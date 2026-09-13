//go:build windows

// EIGHT-Agent-Setup.exe — 社員が1回押すだけで終わるようにするためのもの。
//
// ■ 社員から見た手順
//
//	 EXEをダウンロード → 実行 → （管理者の確認）→ ブラウザが開く
//	 →「このパソコンです」を押す → 完了
//
//	登録コードは打たせない。コマンドも使わせない。
//	ブラウザ側の拡張も、ここが一緒に入れる。
//
// ■ 中でやっていること
//
//  1. 必要なファイルを C:\Program Files\EIGHT に置く
//
//  2. サービスを作って動かす（起動時に自動で上がる）
//
//  3. ログオンした人の画面で動くほう（UI）を、次回から自動で上げる
//
//  4. Chrome / Edge に、継ぎ役（Native Messaging）の置き場所を教える
//
//  5. Chrome / Edge に、会社の拡張を入れる設定を書く
//
//  6. このPCの中で1回きりの札を作り、サーバへ預ける
//
//  7. 既定のブラウザで device-setup.html?pair=札 を開く
//
//  8. 本人が押すと登録コードが出るので、引き取って登録を終える
//
//     札は15分で切れる。使うと死ぬ。平文の鍵はどこにも書き出さない。
//
// ■ ここで止まったら、何も残さない
//
//	途中で失敗したら、置いたものを片付けてから終わる。
//	half-installed のまま「動いているように見える」状態を作らない。
package main

import (
	"bytes"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"crypto/rand"

	"github.com/8grp/eight-agent/internal/browsers"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Version は組み立てるときに入れる
var Version = "0.0.0-dev"

// BaseURL と ExtensionID は、組み立てるときに差し替える。
// 拡張の ID は、鍵を作ったときに決まる（agent/extension/README.md）
var (
	BaseURL     = "https://mf.8grp.co.jp"
	ExtensionID = ""
	// 自社で配るときの更新先。Chrome ウェブストアに出す場合は空にする
	UpdateURL = "https://mf.8grp.co.jp/ext/updates.xml"
)

//go:embed payload
var payload embed.FS

const (
	appDir     = `EIGHT`
	svcName    = "EightAgent"
	svcDisplay = "EIGHT 端末管理"
	hostName   = "jp.co.eightgrp.agent"
	runKey     = `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
	runValue   = "EightAgentUI"
)

func main() {
	// -update … 版を入れ替えるだけ。常駐しているサービスから呼ばれる。
	//
	// 登録も同意もやり直さない。画面も出さない。
	// ここに来るのは、署名とハッシュを確かめ終えたものだけ
	// （eight-agent-svc の checkUpdate）
	if len(os.Args) > 1 && os.Args[1] == "-update" {
		if err := update(); err != nil {
			// 入れ替えに失敗しても、古い版はそのまま動いている。
			// 画面は出さない（誰も見ていない時間に走るため）
			os.Exit(1)
		}
		return
	}

	// 管理者でなければ、管理者として上げ直す。
	// 初回は管理者か社内IT担当が入れる想定だが、
	// 「右クリックして管理者として実行」を覚えさせないためにここで上げ直す
	if !amAdmin() {
		if err := relaunchElevated(); err != nil {
			say("このパソコンに入れるには、管理者の確認が要ります。\n\n"+
				"「はい」を押してもう一度お試しください。", "EIGHT 端末管理")
		}
		return
	}

	if err := run(); err != nil {
		cleanup()
		say(fmt.Sprintf("設定できませんでした。\n\n%v\n\n"+
			"何も入れずに終わりました。管理部にご連絡ください。", err), "EIGHT 端末管理")
		os.Exit(1)
	}
}

// update は、入っているものを新しい版に置き換える。
//
// 消さないもの: 資格情報（ProgramData\EIGHT）、DeviceUid、同意の状態。
// つまり、入れ替えても「登録し直し」や「同意し直し」にはならない。
//
// 失敗しても片付け（cleanup）はしない。
// 古い版が残っているほうが、何も無いより良い
func update() error {
	dir := filepath.Join(os.Getenv("ProgramFiles"), appDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, name := range []string{"eight-agent-svc.exe", "eight-agent-ui.exe", "eight-agent-host.exe"} {
		if err := put(dir, name); err != nil {
			return err
		}
	}
	if err := installService(filepath.Join(dir, "eight-agent-svc.exe")); err != nil {
		return err
	}
	_ = setRun(filepath.Join(dir, "eight-agent-ui.exe"))
	// ブラウザの設定も入れ直す。人が消していたら、ここで戻る
	_ = setupBrowsers(dir, browsers.Installed())

	_ = exec.Command("sc", "start", svcName).Run()
	_ = exec.Command("cmd", "/c", "start", "", filepath.Join(dir, "eight-agent-ui.exe")).Start()
	return nil
}

func run() error {
	dir := filepath.Join(os.Getenv("ProgramFiles"), appDir)

	// ---- 1. ファイルを置く ----
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("置き場所を作れません: %w", err)
	}
	for _, name := range []string{"eight-agent-svc.exe", "eight-agent-ui.exe", "eight-agent-host.exe"} {
		if err := put(dir, name); err != nil {
			return err
		}
	}

	// ---- 2. サービス ----
	if err := installService(filepath.Join(dir, "eight-agent-svc.exe")); err != nil {
		return fmt.Errorf("常駐の登録に失敗しました: %w", err)
	}

	// ---- 3. ログオンした人の画面で動くほう ----
	if err := setRun(filepath.Join(dir, "eight-agent-ui.exe")); err != nil {
		return fmt.Errorf("自動起動の登録に失敗しました: %w", err)
	}

	// ---- 4〜5. ブラウザ ----
	found := browsers.Installed()
	if err := setupBrowsers(dir, found); err != nil {
		// ブラウザ連携が入らなくても、PC側の記録は動く。
		// ここで全部を止めない
		warn("ブラウザ連携の設定に失敗しました: %v", err)
	}

	// ---- 6. 札を作って預ける ----
	token, err := newToken()
	if err != nil {
		return err
	}
	if err := openPair(token, found); err != nil {
		return fmt.Errorf("サーバにつながりません: %w", err)
	}

	// ---- 7. 既定のブラウザで開く ----
	url := fmt.Sprintf("%s/device-setup.html?pair=%s", BaseURL, token)
	if err := openBrowser(url); err != nil {
		say("ブラウザを開けませんでした。\n\n"+
			"次のページを開いて、画面の案内にしたがってください:\n\n"+url, "EIGHT 端末管理")
	}

	// ---- 8. 本人が押すのを待って、登録を終える ----
	code, err := waitForCode(token)
	if err != nil {
		return err
	}
	if err := enroll(dir, code); err != nil {
		return fmt.Errorf("登録できませんでした: %w", err)
	}

	// サービスを上げ直して、登録した資格情報で動かす
	_ = exec.Command("sc", "start", svcName).Run()
	// いま開いている人の画面のほうも、待たずに上げる
	_ = exec.Command("cmd", "/c", "start", "", filepath.Join(dir, "eight-agent-ui.exe")).Start()

	say("設定が終わりました。\n\n"+
		"ブラウザの画面にもどって、最後に「記録すること」を読んでください。\n"+
		"読んで確認するまで、記録は始まりません。", "EIGHT 端末管理")
	return nil
}

// ---- ファイル ---------------------------------------------------------------

func put(dir, name string) error {
	b, err := payload.ReadFile("payload/" + name)
	if err != nil {
		return fmt.Errorf("%s が入っていません（組み立てのミス）: %w", name, err)
	}
	dst := filepath.Join(dir, name)
	// 動いているものは置き換えられない。先に止める
	_ = exec.Command("sc", "stop", svcName).Run()
	_ = exec.Command("taskkill", "/F", "/IM", name).Run()
	time.Sleep(500 * time.Millisecond)

	if err := os.WriteFile(dst, b, 0o755); err != nil {
		return fmt.Errorf("%s を置けません: %w", name, err)
	}
	return nil
}

// ---- サービス ---------------------------------------------------------------

func installService(exe string) error {
	// 既にあれば作り直さない。設定だけ入れ直す
	_ = exec.Command("sc", "create", svcName,
		"binPath=", fmt.Sprintf(`"%s" -run`, exe),
		"start=", "auto",
		"DisplayName=", svcDisplay,
	).Run()

	_ = exec.Command("sc", "config", svcName,
		"binPath=", fmt.Sprintf(`"%s" -run`, exe),
		"start=", "auto",
	).Run()

	_ = exec.Command("sc", "description", svcName,
		"会社のパソコンの利用状況を記録し、mf.8grp.co.jp へ送ります。").Run()

	// 落ちても上がってくるようにする
	_ = exec.Command("sc", "failure", svcName,
		"reset=", "86400", "actions=", "restart/60000/restart/60000/restart/60000").Run()

	out, err := exec.Command("sc", "query", svcName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func setRun(exe string) error {
	// 全員ぶん。HKLM の Run に置くと、誰がログオンしても上がる
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(runValue, fmt.Sprintf(`"%s"`, exe))
}

// ---- ブラウザ ---------------------------------------------------------------

// setupBrowsers は、継ぎ役の置き場所と、拡張を入れる設定を書く。
//
// 社員に拡張を入れさせない、が目的なので「会社が配る」形で書く。
// 入っていないブラウザには何も書かない
func setupBrowsers(dir string, found []browsers.Found) error {
	hostExe := filepath.Join(dir, "eight-agent-host.exe")
	manifest := filepath.Join(dir, hostName+".json")

	// 拡張のIDが焼き込まれていなければ、ブラウザ連携だけ置いていく。
	// PC側の記録（起動終了・ソフト・USB・離席）は、これが無くても動く。
	// 「拡張のIDが無いから入らない」で止めると、入れ直しのたびに
	// 管理者が全PCを回ることになる
	if ExtensionID == "" {
		return fmt.Errorf("拡張のIDが入っていないので、ブラウザ連携は設定しませんでした" +
			"（PC側の記録は動きます。拡張を配るときに入れ直してください）")
	}

	// 継ぎ役の説明書き。どの拡張から呼ばれてよいかを、ここで縛る
	mf := map[string]any{
		"name":            hostName,
		"description":     "EIGHT 端末管理",
		"path":            hostExe,
		"type":            "stdio",
		"allowed_origins": []string{fmt.Sprintf("chrome-extension://%s/", ExtensionID)},
	}
	b, _ := json.MarshalIndent(mf, "", "  ")
	if err := os.WriteFile(manifest, b, 0o644); err != nil {
		return err
	}

	var last error
	for _, f := range found {
		if !browsers.SupportsExtension(f.Kind) {
			continue
		}
		// 継ぎ役の置き場所
		if key, ok := browsers.NativeHostKey(f.Kind, hostName); ok {
			k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, key, registry.SET_VALUE)
			if err != nil {
				last = err
				continue
			}
			_ = k.SetStringValue("", manifest)
			k.Close()
		}
		// 拡張を入れる設定
		if err := forceInstall(f.Kind); err != nil {
			last = err
		}
	}
	return last
}

func forceInstall(kind browsers.Kind) error {
	var path string
	for _, p := range browsers.Policies {
		if p.Kind == kind {
			path = p.Key
		}
	}
	if path == "" {
		return nil
	}
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, path, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()

	// 既に同じものが書いてあれば、足さない。
	// 番号を増やし続けると、入れ直すたびに同じ行が並ぶ
	names, _ := k.ReadValueNames(0)
	want := ExtensionID + ";" + UpdateURL
	for _, n := range names {
		if v, _, err := k.GetStringValue(n); err == nil && v == want {
			return nil
		}
	}
	// 空いている番号に書く。ほかの会社のポリシーを上書きしない
	for i := 1; i < 100; i++ {
		name := fmt.Sprint(i)
		if _, _, err := k.GetStringValue(name); err != nil {
			return k.SetStringValue(name, want)
		}
	}
	return fmt.Errorf("書ける場所がありません")
}

// ---- サーバとのやりとり ------------------------------------------------------

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("札を作れません: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func openPair(token string, found []browsers.Found) error {
	host, _ := os.Hostname()
	body, _ := json.Marshal(map[string]any{
		"token":    token,
		"hostname": host,
		"os":       osName(),
		"browsers": found,
	})
	r, err := http.Post(BaseURL+"/api/devices/pair", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		msg, _ := io.ReadAll(io.LimitReader(r.Body, 400))
		return fmt.Errorf("%d %s", r.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

// waitForCode は、本人がブラウザで押すのを待つ。
//
// 押されると登録コードが1回だけ引き取れる。押されないまま15分で札が切れる
func waitForCode(token string) (string, error) {
	deadline := time.Now().Add(14 * time.Minute)
	url := fmt.Sprintf("%s/api/devices/pair?token=%s&code=1", BaseURL, token)

	for time.Now().Before(deadline) {
		time.Sleep(3 * time.Second)

		r, err := http.Get(url)
		if err != nil {
			continue
		}
		var out struct {
			Ready       bool   `json:"ready"`
			EnrollToken string `json:"enrollToken"`
			Error       string `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&out)
		r.Body.Close()

		if out.Ready && out.EnrollToken != "" {
			return out.EnrollToken, nil
		}
		if out.Error == "expired" {
			return "", fmt.Errorf("時間切れです。もう一度実行してください")
		}
	}
	return "", fmt.Errorf("ブラウザで「このパソコンです」が押されませんでした")
}

// enroll は、引き取った登録コードで登録を終える。
// 登録そのものはサービスの仕事（鍵の置き方を1か所にするため）
func enroll(dir, code string) error {
	cmd := exec.Command(filepath.Join(dir, "eight-agent-svc.exe"), "-enroll", code)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return nil
}

// ---- 片付け -----------------------------------------------------------------

// cleanup は、途中で失敗したときに置いたものを片付ける。
// 中途半端に入った状態を残さない
func cleanup() {
	_ = exec.Command("sc", "stop", svcName).Run()
	_ = exec.Command("sc", "delete", svcName).Run()
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, runKey, registry.SET_VALUE); err == nil {
		_ = k.DeleteValue(runValue)
		k.Close()
	}
}

// ---- Windows の小物 ---------------------------------------------------------

func amAdmin() bool {
	var sid *windows.SID
	err := windows.AllocateAndInitializeSid(
		&windows.SECURITY_NT_AUTHORITY, 2,
		windows.SECURITY_BUILTIN_DOMAIN_RID,
		windows.DOMAIN_ALIAS_RID_ADMINS,
		0, 0, 0, 0, 0, 0, &sid)
	if err != nil {
		return false
	}
	defer windows.FreeSid(sid)

	token := windows.Token(0)
	member, err := token.IsMember(sid)
	return err == nil && member
}

func relaunchElevated() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	dir, _ := windows.UTF16PtrFromString(filepath.Dir(exe))
	return windows.ShellExecute(0, verb, file, nil, dir, windows.SW_NORMAL)
}

func openBrowser(url string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	target, _ := windows.UTF16PtrFromString(url)
	return windows.ShellExecute(0, verb, target, nil, nil, windows.SW_NORMAL)
}

func say(msg, title string) {
	m, _ := windows.UTF16PtrFromString(msg)
	t, _ := windows.UTF16PtrFromString(title)
	_, _ = windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONINFORMATION)
}

func warn(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
}

func osName() string {
	// 詳しい版は、サービスが登録のときに送る。ここは見せる用
	return "Windows"
}
