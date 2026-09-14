//go:build windows

// このPCから、自分を消す。
//
// ■ いつ動くか
//
//	管理者が管理画面で「端末を削除」を押すと、サーバがこのPCの
//	資格情報を失効させ、「消せ」という印を立てる。
//	常駐しているほうが、次にサーバへ来たときにそれを受け取る。
//
//	  記録を送れているとき … 送信の返事（5分おき）で受け取る
//	  止まっているとき     … 設定の口（1時間おき）で受け取る
//	  電源が入っていないとき … 次に起動して、つながったときに受け取る
//
//	つまり「オフラインなら削除待ち、次にオンラインになった時点で消える」。
//
// ■ 消す順番には理由がある
//
//	先に実行ファイルを消すと、そのあとの後片付けができない。
//	逆に、報せを最後まで残すと、途中で電源が落ちたときに
//	管理画面が永久に「削除待ち」のままになる。
//
//	そこで、
//	  1. 動いているものを止める（UI・自動起動）
//	  2. ブラウザに書いた設定を外す（拡張・継ぎ役）
//	  3. このPCの印と、溜めた記録を消す
//	  4. サーバへ「消し終わった」と報せる  ← ここまでで台帳から外れる
//	  5. サービスと実行ファイルを、自分が終わったあとに消させる
//
//	4 までは自分で確かめられる。5 は自分を消す作業なので、
//	自分が終わるのを待つ別のプロセスに任せる。
//
// ■ 過去の記録は消さない
//
//	消えるのは、このPCの中のものと、台帳に並ぶ1行だけ。
//	サーバにある監査記録・WEB利用・セキュリティのできごとは、
//	保存期間が来るまでそのまま残る。
//	端末を消した時点で記録まで消えると、
//	「辞める前に消しておけば残らない」が成り立ってしまう。
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/8grp/eight-agent/internal/api"
	"github.com/8grp/eight-agent/internal/browsers"
	"golang.org/x/sys/windows/registry"
)

// ExtensionID は組み立てるときに入れる（agent/build.sh）。
//
// ブラウザに書いた「この拡張を入れる」設定のうち、どれが自分のものかを
// 見分けるのに要る。空のときは、ブラウザの設定には触らない。
// 番号だけを見て消すと、他社のポリシーを消しかねない
var ExtensionID = ""

// selfUninstall は、このPCから EIGHT Agent を消す。
//
// 消せなかったものは left に積んで、サーバへ報せる。
// 途中で止まらない（片付けを1つ失敗したからといって、残り全部を
// 残すほうが困る）。
func selfUninstall(c *api.Client, dir string) error {
	log.Printf("この端末の登録が解除されました。EIGHT Agent を削除します")

	var left []string
	note := func(what string, err error) {
		if err == nil {
			return
		}
		log.Printf("削除: %s を外せませんでした: %v", what, err)
		left = append(left, what)
	}

	// ---- 1. 動いているものを止める ----
	//
	// ログオンした人の画面で動くほう。先に止めないと、
	// 実行ファイルを消せない
	_ = exec.Command("taskkill", "/F", "/IM", "eight-agent-ui.exe").Run()

	// 次にログオンしても上がってこないようにする
	note("自動起動の設定", delValue(runKeyPath, runValueName))

	// ---- 2. ブラウザに書いた設定を外す ----
	note("ブラウザの設定", removeBrowserSetup())

	// ---- 3. このPCの印と、溜めた記録 ----
	//
	// DeviceUid を残すと、入れ直したときに同じ端末として戻ってくる。
	// 「登録を解除した」のだから、印も消す
	note("このPCの印（レジストリ）", delKey(regPath))
	note("溜めた記録", os.RemoveAll(dir))

	// ---- 4. 消し終わったと報せる ----
	//
	// ここが届いてはじめて、管理画面の「削除待ち」が消える。
	// 届かなければ「削除待ち」のまま残る。それでよい。
	// 消えたことにして台帳から外すより、消えたか分からないと出すほうが正しい
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := c.Wiped(ctx, "", left); err != nil {
		log.Printf("削除: 消し終わったと報せられませんでした: %v", err)
		// 報せられなくても、消す作業は続ける。
		// このPCに残しておく理由はもう無い
	}

	// ---- 5. 自分自身 ----
	note("サービスと実行ファイル", scheduleSelfRemoval())

	log.Printf("削除が終わりました")
	return nil
}

const (
	runKeyPath    = `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
	runValueName  = "EightAgentUI"
	nativeHostKey = "jp.co.eightgrp.agent"
	serviceName   = "EightAgent"
)

func delValue(key, name string) error {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, key, registry.SET_VALUE)
	if err != nil {
		if err == registry.ErrNotExist {
			return nil
		}
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(name); err != nil && err != registry.ErrNotExist {
		return err
	}
	return nil
}

func delKey(path string) error {
	err := registry.DeleteKey(registry.LOCAL_MACHINE, path)
	if err == registry.ErrNotExist {
		return nil
	}
	return err
}

// removeBrowserSetup は、インストーラが書いた2つを外す。
//
//	継ぎ役の置き場所（NativeMessagingHosts）
//	拡張を入れる設定（ExtensionInstallForcelist）
//
// どちらも HKLM。入れていないブラウザには、そもそも何も書いていない。
func removeBrowserSetup() error {
	var last error
	for _, kind := range browsers.Known {
		if !browsers.SupportsExtension(kind) {
			continue
		}
		// 継ぎ役。鍵ごと消す。中身は path 1つだけ
		if key, ok := browsers.NativeHostKey(kind, nativeHostKey); ok {
			if err := delKey(key); err != nil {
				last = err
			}
		}
	}

	// 拡張を入れる設定。
	//
	// ここは会社のポリシーで、EIGHT 以外の拡張も並んでいることがある。
	// 番号で消さず、値が自分の拡張のものかどうかを見て消す。
	// IDが焼き込まれていなければ、何が自分のものか分からないので触らない
	if ExtensionID == "" {
		return last
	}
	for _, p := range browsers.Policies {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, p.Key,
			registry.SET_VALUE|registry.QUERY_VALUE)
		if err != nil {
			if err != registry.ErrNotExist {
				last = err
			}
			continue
		}
		names, _ := k.ReadValueNames(0)
		for _, n := range names {
			v, _, err := k.GetStringValue(n)
			if err != nil {
				continue
			}
			// "<拡張のID>;<更新先>" の形。IDの部分だけを見る
			if v != ExtensionID && !hasPrefix(v, ExtensionID+";") {
				continue
			}
			if err := k.DeleteValue(n); err != nil {
				last = err
			}
		}
		k.Close()
	}
	return last
}

func hasPrefix(s, p string) bool { return len(s) >= len(p) && s[:len(p)] == p }

// detached は、親が終わっても生き残るようにする指定。
//
//	DETACHED_PROCESS         … 親のコンソールを引き継がない
//	CREATE_NEW_PROCESS_GROUP … 親に送られた Ctrl-C を道連れにしない
//	CREATE_NO_WINDOW         … 黒い窓を出さない（人に見せるものではない）
func detached() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008 | 0x00000200 | 0x08000000,
	}
}

// scheduleSelfRemoval は、自分が終わったあとに残りを消させる。
//
// 動いている実行ファイルは、自分では消せない。
// サービスも、自分が動いているあいだは delete しても消えきらない。
// そこで、少し待ってから片付ける別のプロセスを置いて、こちらは終わる。
func scheduleSelfRemoval() error {
	dir := filepath.Join(os.Getenv("ProgramFiles"), "EIGHT")

	// ping を時間待ちに使う。timeout は対話セッションでないと失敗する
	script := fmt.Sprintf(
		`ping -n 8 127.0.0.1 >nul & sc stop "%s" >nul 2>&1 & `+
			`ping -n 4 127.0.0.1 >nul & sc delete "%s" >nul 2>&1 & `+
			`rmdir /s /q "%s"`,
		serviceName, serviceName, dir)

	cmd := exec.Command("cmd", "/c", script)
	// 親（自分）が終わっても道連れにならないように、切り離して起動する
	cmd.SysProcAttr = detached()
	if err := cmd.Start(); err != nil {
		return err
	}
	// 待たない。待つと、止められるのを待つことになる
	go func() { _ = cmd.Wait() }()
	return nil
}
