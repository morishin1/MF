//go:build windows

// eight-agent-ui は、ログオンした人のセッションで動くほう。
//
// ■ なぜ分かれているのか
//
//	Windows の Session 0 Isolation により、サービス（SYSTEM）からは
//	対話セッションのフォアグラウンドウィンドウが取れない。
//	「いま何のアプリを使っているか」を見られるのは、このプロセスだけ。
//
// ■ ここが送るのは3つだけ
//
//	・実行ファイル名（excel.exe）
//	・離席しているか
//	・見ているサイトの**カテゴリ**（work / sns / …）
//
//	ウィンドウのタイトルは取らない。GetWindowText を呼ばない。
//	URLは、このプロセスの中でホスト名→カテゴリに落としてから渡す。
//	サービスにもサーバにも、URLそのものは渡らない。
//
// ■ タスクトレイに出す
//
//	動いていることが本人に見えない常駐は、その時点で監視になる。
//	アイコンから「いま何を記録しているか」を開けるようにする。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/8grp/eight-agent/internal/collect"
)

var Version = "0.0.0-dev"

const pipeName = `\\.\pipe\eight-agent`

// report は1分に1回、サービスへ渡すもの。
//
// この構造体に、ウィンドウのタイトルやURLを入れる場所は無い。
// 入れる場所を作らないことが、いちばん確実な歯止めになる。
type report struct {
	At       time.Time `json:"at"`
	State    string    `json:"state"`
	Exe      string    `json:"exe"`
	Product  string    `json:"product,omitempty"`
	Category string    `json:"category,omitempty"`
}

func main() {
	idleAfter := flag.Int("idle-min", 5, "何分触らなければ離席とみなすか")
	flag.Parse()

	log.SetPrefix("[eight-agent-ui] ")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go runTray(ctx)

	t := time.NewTicker(time.Minute)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			r := sample(now, *idleAfter)
			if err := send(r); err != nil {
				// サービスが止まっているだけかもしれない。次の分で試す
				log.Printf("サービスへ渡せませんでした: %v", err)
			}
		}
	}
}

// sample はこの1分の状態を見る。
func sample(now time.Time, idleAfterMin int) report {
	r := report{At: now.UTC()}

	if locked() {
		r.State = "locked"
		return r
	}
	if collect.IdleSeconds() >= idleAfterMin*60 {
		r.State = "idle"
		return r
	}

	r.State = "active"
	r.Exe = collect.ForegroundExe()

	// ブラウザを使っているときだけ、いま見ているサイトのカテゴリを添える。
	// URL は categoryOf に渡した時点で捨てる。この関数から外へ出さない
	if isBrowser(r.Exe) {
		if host := currentHost(); host != "" {
			r.Category = categorize(host)
		}
	}
	return r
}

func isBrowser(exe string) bool {
	switch exe {
	case "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "brave.exe":
		return true
	}
	return false
}

func send(r report) error {
	f, err := os.OpenFile(pipeName, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()

	buf, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = f.Write(append(buf, '\n'))
	return err
}
