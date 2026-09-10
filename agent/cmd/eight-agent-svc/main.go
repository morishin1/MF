//go:build windows

// eight-agent-svc は、このPCで常時動くほうのプロセス。
//
// ■ 2つに分かれている理由
//
//	Windows の Session 0 Isolation により、サービス（SYSTEM）からは
//	対話セッションのフォアグラウンドウィンドウが取れない。
//	「いま何のアプリを使っているか」はサービスからは分からない。
//	だから前面のアプリと離席の判定は eight-agent-ui.exe（ユーザー権限）が見て、
//	名前付きパイプでこちらへ渡す。
//
//	     ┌─ eight-agent-svc.exe (SYSTEM) ─┐
//	     │  起動終了・ロック・USB・ソフト   │
//	     │  待ち行列・送信・自動更新        │
//	     └──────────┬─────────────┘
//	                │ \\.\pipe\eight-agent
//	     ┌──────────┴─────────────┐
//	     │ eight-agent-ui.exe (ユーザー)    │
//	     │  前面のアプリ・離席・URL→カテゴリ │
//	     │  タスクトレイ（記録中が見える）    │
//	     └────────────────────────┘
//
// ■ 本人が承認するまで何も送らない
//
//	サーバの /api/devices/config が collect:false を返しているあいだ、
//	待ち行列にも Tally にも1件も入らない（collect.Agent がそう作ってある）。
//	就業規則への明記と本人への周知が済むまで、データは溜まらない。
//
// 使い方:
//
//	eight-agent-svc.exe -enroll ABCD-2345-KMNP   … 登録して、案内をブラウザで開く
//	eight-agent-svc.exe -run                     … 常駐（サービスから呼ばれる）
//	eight-agent-svc.exe -status                  … いまの状態を出す
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/8grp/eight-agent/internal/api"
	"github.com/8grp/eight-agent/internal/collect"
	"github.com/8grp/eight-agent/internal/store"
)

// Version はビルド時に -ldflags で入れる。
var Version = "0.0.0-dev"

const (
	defaultBaseURL = "https://mf.8grp.co.jp"
	queueMax       = 20000            // だいたい30日ぶん
	rotateAfter    = 90 * 24 * time.Hour
)

func main() {
	var (
		enroll  = flag.String("enroll", "", "登録コード（ABCD-2345-KMNP）")
		run     = flag.Bool("run", false, "常駐する")
		status  = flag.Bool("status", false, "いまの状態を出す")
		baseURL = flag.String("server", envOr("EIGHT_SERVER", defaultBaseURL), "サーバのURL")
		dir     = flag.String("dir", dataDir(), "置き場所")
	)
	flag.Parse()

	log.SetFlags(log.LstdFlags)
	log.SetPrefix("[eight-agent] ")

	switch {
	case *enroll != "":
		if err := doEnroll(*baseURL, *dir, *enroll); err != nil {
			log.Fatalf("登録できませんでした: %v", err)
		}
	case *status:
		if err := doStatus(*baseURL, *dir); err != nil {
			log.Fatalf("状態を取れませんでした: %v", err)
		}
	case *run:
		if err := doRun(*baseURL, *dir); err != nil {
			log.Fatalf("止まりました: %v", err)
		}
	default:
		flag.Usage()
		os.Exit(2)
	}
}

// ---- 登録 -------------------------------------------------------------------

func doEnroll(baseURL, dir, token string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	c := api.New(baseURL)
	host := hostname()
	ver, build := osVersion()

	res, err := c.Enroll(ctx, token, map[string]string{
		"deviceUid":    deviceUID(dir),
		"hostname":     host,
		"os":           "Windows",
		"osVersion":    ver,
		"osBuild":      build,
		"serial":       machineSerial(),
		"agentVersion": Version,
	})
	if err != nil {
		return err
	}

	if err := store.SaveIdentity(dir, &store.Identity{
		DeviceID: res.DeviceID, Secret: res.Secret,
	}); err != nil {
		return fmt.Errorf("資格情報を保存できませんでした: %w", err)
	}

	fmt.Println("このパソコンを登録しました。")
	fmt.Println()
	fmt.Println("つづけて、使う方が下の画面を開いて")
	fmt.Println("「このパソコンです」を押すまで、記録は始まりません。")
	fmt.Println()
	fmt.Println("  " + res.LinkURL)

	// 既定のブラウザで開く。本人がログインした状態で開けば、
	// このパソコンとそのブラウザがつながる
	if res.LinkURL != "" {
		if err := openBrowser(res.LinkURL); err != nil {
			log.Printf("ブラウザを開けませんでした。上のURLを手で開いてください: %v", err)
		}
	}
	return nil
}

// ---- 状態 -------------------------------------------------------------------

func doStatus(baseURL, dir string) error {
	id, err := store.LoadIdentity(dir)
	if err != nil {
		return err
	}
	c := api.New(baseURL)
	c.DeviceID, c.Secret = id.DeviceID, id.Secret

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cfg, err := c.Config(ctx)
	if err != nil {
		return err
	}
	q, err := store.Open(queueDir(dir), queueMax)
	if err != nil {
		return err
	}
	n, _ := q.Len()

	fmt.Printf("バージョン    %s\n", Version)
	fmt.Printf("パソコン      %s\n", hostname())
	if cfg.Collect {
		fmt.Printf("記録          しています（%d秒ごとに送信）\n", cfg.SendIntervalSec)
	} else {
		fmt.Printf("記録          していません（%s）\n", cfg.Message)
	}
	fmt.Printf("未送信        %d件\n", n)
	fmt.Println()
	fmt.Println("取っていないもの:")
	for _, s := range cfg.Never {
		fmt.Printf("  ・%s\n", neverJa(s))
	}
	return nil
}

func neverJa(k string) string {
	switch k {
	case "keystrokes":
		return "キーボードで打った内容"
	case "clipboard":
		return "コピーした内容"
	case "screenshots":
		return "画面の録画・スクリーンショット"
	case "window_titles":
		return "開いていた画面のタイトル"
	case "full_urls":
		return "見たページのURL（種類だけにして送ります）"
	case "file_contents":
		return "ファイルの中身"
	}
	return k
}

// ---- 常駐 -------------------------------------------------------------------

func doRun(baseURL, dir string) error {
	id, err := store.LoadIdentity(dir)
	if err != nil {
		return err
	}
	q, err := store.Open(queueDir(dir), queueMax)
	if err != nil {
		return err
	}
	q.SeqFloor(id.LastSeq)

	c := api.New(baseURL)
	c.DeviceID, c.Secret = id.DeviceID, id.Secret

	ag := collect.NewAgent(c, q, Version, hostname(), dir)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// まず設定を取る。取れるまでは何もしない。
	// 「取れなかったから、とりあえず集めておく」はしない
	if err := ag.RefreshConfig(ctx); err != nil {
		log.Printf("設定を取れませんでした。しばらくして試します: %v", err)
	}

	ag.Note("agent_start", time.Now(), map[string]string{"version": Version})
	if at, ok := bootTime(); ok {
		ag.Note("boot", at, nil)
	}

	// UI プロセスからの報せを受ける（前面のアプリ・離席）
	go serveUIPipe(ctx, ag)

	// OS からの報せを受ける（ロック・USB・ソフトの出入り）
	go watchSystem(ctx, ag)

	sendEvery := 5 * time.Minute
	if cfg := ag.Config(); cfg != nil && cfg.SendIntervalSec > 0 {
		sendEvery = time.Duration(cfg.SendIntervalSec) * time.Second
	}

	send := time.NewTicker(sendEvery)
	defer send.Stop()
	refresh := time.NewTicker(6 * time.Hour)
	defer refresh.Stop()

	rotatedAt := time.Now()

	for {
		select {
		case <-ctx.Done():
			// 落ちる前に、溜まっているぶんを出す
			flushCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			ag.Note("shutdown", time.Now(), nil)
			if err := ag.Flush(flushCtx); err != nil {
				log.Printf("最後の送信に失敗しました（次の起動で送ります）: %v", err)
			}
			cancel()
			return nil

		case <-send.C:
			if err := ag.Flush(ctx); err != nil {
				if _, dead := err.(*api.Unauthorized); dead {
					// 資格情報が通らない。管理者が端末を消したか、
					// シークレットが入れ替わった。人が再登録するしかない
					log.Printf("この端末は登録し直しが要ります: %v", err)
					return err
				}
				log.Printf("送れませんでした（溜めておきます）: %v", err)
			}

		case <-refresh.C:
			if err := ag.RefreshConfig(ctx); err != nil {
				log.Printf("設定を取れませんでした: %v", err)
			}
			if time.Since(rotatedAt) > rotateAfter {
				if err := ag.Rotate(ctx); err != nil {
					log.Printf("シークレットを取り替えられませんでした: %v", err)
				} else {
					rotatedAt = time.Now()
					log.Printf("シークレットを取り替えました")
				}
			}
			checkUpdate(ctx, ag)
		}
	}
}

// ---- 小物 -------------------------------------------------------------------

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func queueDir(dir string) string { return filepath.Join(dir, "queue") }
