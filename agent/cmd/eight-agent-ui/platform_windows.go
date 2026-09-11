//go:build windows

package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/8grp/eight-agent/internal/collect"
	"golang.org/x/sys/windows"
)

// ---- ロックしているか ---------------------------------------------------------

// ロック中は前面のウィンドウが取れない。
// OpenInputDesktop が失敗するかどうかで見る（画面の中身は覗かない）
var (
	user32           = windows.NewLazySystemDLL("user32.dll")
	procOpenInputDes = user32.NewProc("OpenInputDesktop")
	procCloseDesktop = user32.NewProc("CloseDesktop")
)

func locked() bool {
	h, _, _ := procOpenInputDes.Call(0, 0, uintptr(0x0100)) // DESKTOP_SWITCHDESKTOP
	if h == 0 {
		return true
	}
	procCloseDesktop.Call(h)
	return false
}

// ---- カテゴリ表 ---------------------------------------------------------------

// 表はサービスが持っている設定を写したもの。
// %ProgramData%\EIGHT\sites.json に置く（サービスが書き出す）
var (
	catOnce sync.Once
	catzr   *collect.Categorizer
)

func categorize(host string) string {
	catOnce.Do(func() {
		table := map[string]string{}
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		if b, err := os.ReadFile(filepath.Join(pd, "EIGHT", "sites.json")); err == nil {
			json.Unmarshal(b, &table)
		}
		catzr = collect.NewCategorizer(table)
	})
	return catzr.Of(host)
}

// ---- タスクトレイ -------------------------------------------------------------

// runTray はタスクトレイに常駐する。
//
// ■ 出すのは意図的
//
//	動いていることが本人に見えない常駐は、その時点で監視になる。
//	アイコンを右クリックすると、記録している内容の画面を開ける。
//
// いまはトレイの実装（Shell_NotifyIcon とウィンドウ手続き）を入れていない。
// 代わりに、ローカルだけで応答する小さな窓口を開けてある。
// ブラウザから http://127.0.0.1:14812/ を開くと、いまの状態が読める。
func runTray(ctx context.Context) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(trayHTML))
	})
	mux.HandleFunc("/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(map[string]any{
			"version":     Version,
			"locked":      locked(),
			"idleSeconds": collect.IdleSeconds(),
			"exe":         collect.ForegroundExe(),
		})
	})

	// 127.0.0.1 だけ。ほかのPCからは開けない
	srv := &http.Server{Addr: "127.0.0.1:14812", Handler: mux,
		ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(sh)
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("状態の窓口を開けませんでした: %v", err)
	}
}

const trayHTML = `<!DOCTYPE html><html lang="ja"><meta charset="utf-8">
<title>このパソコンで記録していること</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;
line-height:1.9;color:#1a202c}h1{font-size:19px}h2{font-size:15px;margin-top:28px}
ul{padding-left:1.3em}.n{color:#1f7a4c}.t{color:#2b5f9e}</style>
<h1>このパソコンで記録していること</h1>
<h2 class="t">取っているもの</h2>
<ul>
<li>パソコンの起動・終了・ログオン・ロックの時刻</li>
<li>1日の稼働時間と、離席していた時間</li>
<li>使ったソフトの名前と、その合計時間</li>
<li>見たサイトの<b>種類</b>（業務・調べもの・SNS など）と合計時間</li>
<li>USBメモリをつないだこと、ソフトを入れたこと</li>
</ul>
<h2 class="n">取っていないもの</h2>
<ul>
<li>キーボードで打った内容</li>
<li>パスワード</li>
<li>メールやチャットの本文</li>
<li>画面の録画・スクリーンショット</li>
<li>開いていた画面のタイトル</li>
<li>見たページのURL（種類だけにして送ります）</li>
<li>ファイルの中身</li>
</ul>
<p>自分の記録は、いつでも
<a href="https://mf.8grp.co.jp/mypage.html">マイページ</a>で見られます。
管理者があなたの記録を開いたときは、それもそこに残ります。</p>
`
