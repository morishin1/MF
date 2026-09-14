package collect

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ブラウザの拡張が、読んではいけないものに手が届かないことを確かめる。
//
// 拡張は「ページの中身を読まない」と画面にも規程にも書いてある。
// 書いてあるだけでは、あとから誰かが1行足したときに崩れる。
//
// いちばん確かなのは **権限を持たせないこと** なので、
// manifest.json に危ないものが入っていないかを見る。
// 権限が無ければ、コードを足しても読めない。

func manifestPath() string { return filepath.Join("..", "..", "extension", "manifest.json") }

type manifest struct {
	Permissions     []string          `json:"permissions"`
	HostPermissions []string          `json:"host_permissions"`
	ContentScripts  []any             `json:"content_scripts"`
	WebAccessible   []any             `json:"web_accessible_resources"`
	Background      map[string]string `json:"background"`
}

func readManifest(t *testing.T) manifest {
	t.Helper()
	b, err := os.ReadFile(manifestPath())
	if err != nil {
		t.Fatalf("manifest.json を読めません: %v", err)
	}
	var m manifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("manifest.json が壊れています: %v", err)
	}
	return m
}

// 危ない権限が1つも入っていないこと。
//
// ここに足したくなったときは、本人への告知（api/devices/me.js の AGENT_NOTICE）と
// 就業規則のほうを先に直すこと。順番を逆にしない
func TestExtensionHasNoDangerousPermissions(t *testing.T) {
	forbidden := map[string]string{
		"<all_urls>":         "全サイトに入り込める",
		"webRequest":         "通信の中身が読める",
		"webRequestBlocking": "同上",
		"cookies":            "Cookie とログインの鍵が読める",
		"history":            "閲覧履歴の全文（URL）が読める",
		"bookmarks":          "ブックマークが読める",
		"downloads":          "ダウンロードしたファイルが分かる",
		"clipboardRead":      "コピーした内容が読める",
		"debugger":           "何でもできる",
		"management":         "ほかの拡張を触れる",
		"proxy":              "通信を曲げられる",
		"privacy":            "ブラウザの設定を変えられる",
		"scripting":          "ページにコードを差し込める",
		"pageCapture":        "ページを丸ごと保存できる",
		"desktopCapture":     "画面を取れる",
		"tabCapture":         "タブの中身を取れる",
	}

	m := readManifest(t)
	for _, p := range m.Permissions {
		if why, bad := forbidden[p]; bad {
			t.Errorf("拡張に %q が入っています（%s）。"+
				"足すなら、先に本人への告知と規程を直すこと", p, why)
		}
	}
	// 通信先は、会社のグループウェアだけ。
	//
	// 以前はここを空にしていた（拡張はサーバへ直接つながず、
	// パソコンの中のソフトへ渡していた）。
	// いまは拡張が自分で送るので、送り先を1つだけ許す。
	// ここに別のサイトが増えたら、そのサイトのページの中に入れるようになる
	for _, h := range m.HostPermissions {
		if h != "https://mf.8grp.co.jp/*" {
			t.Errorf("host_permissions に %q が入っています。"+
				"会社のグループウェア以外を足さないこと", h)
		}
	}
	if len(m.ContentScripts) > 0 {
		t.Error("content_scripts が入っています。ページの中身が読めるようになります")
	}
}

// 要る権限はそろっていること。減らしすぎると、ただ動かないだけになる
func TestExtensionHasWhatItNeeds(t *testing.T) {
	m := readManifest(t)
	// storage … 端末専用の資格情報を置く。
	// nativeMessaging は外した。EXE を必須にしないため
	need := []string{"tabs", "idle", "alarms", "storage"}
	have := map[string]bool{}
	for _, p := range m.Permissions {
		have[p] = true
	}
	for _, n := range need {
		if !have[n] {
			t.Errorf("拡張に %q がありません", n)
		}
	}
	if m.Background["service_worker"] == "" {
		t.Error("service_worker が指定されていません")
	}
}

// 中のコードが、読んではいけないものに触っていないこと。
//
// 権限が無ければ呼んでも失敗するが、呼ぼうとしていること自体が
// 「そのうち権限を足す」への一歩になる。ここで止める
func TestExtensionCodeDoesNotReach(t *testing.T) {
	forbidden := map[string]string{
		`\.title`:            "ページの題（タイトル）",
		`chrome\.cookies`:    "Cookie",
		`chrome\.history`:    "閲覧履歴の全文",
		`chrome\.webRequest`: "通信の中身",
		`chrome\.scripting`:  "ページへの差し込み",
		`chrome\.downloads`:  "ダウンロード",
		`executeScript`:      "ページへの差し込み",
		`chrome\.bookmarks`:  "ブックマーク",
		`captureVisibleTab`:  "画面のコピー",
	}

	src, err := os.ReadFile(filepath.Join("..", "..", "extension", "background.js"))
	if err != nil {
		t.Fatalf("background.js を読めません: %v", err)
	}
	code := stripJSComments(string(src))

	for pat, why := range forbidden {
		if regexp.MustCompile(pat).MatchString(code) {
			t.Errorf("background.js が %s に触っています（%s）", pat, why)
		}
	}

	// URL を外へ出す前に必ず削っていること。
	// keep() を通さずに tab.url を持ち回る書き方をさせない
	if !strings.Contains(code, "function keep(") {
		t.Error("keep() が無い。URL を削る場所が1か所である前提が崩れている")
	}
	if strings.Count(code, "tab.url") > 1 {
		t.Error("tab.url を何か所でも読んでいる。keep() に集めること")
	}
}

// JS のコメントを落とす。コメントに書いてある語で落ちないようにする
func stripJSComments(s string) string {
	s = regexp.MustCompile(`(?s)/\*.*?\*/`).ReplaceAllString(s, "")
	out := make([]string, 0, 256)
	for _, line := range strings.Split(s, "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}
