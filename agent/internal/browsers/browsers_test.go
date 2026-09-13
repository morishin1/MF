package browsers

import "testing"

// 鍵は管理画面（lib/devices.js の BROWSERS）と同じでなければならない。
// ずれると、送った状態がどのブラウザのものか分からなくなる
func TestKindsMatchServer(t *testing.T) {
	want := map[Kind]string{
		Chrome: "chrome", Edge: "edge", Firefox: "firefox",
		Brave: "brave", Opera: "opera",
	}
	for k, s := range want {
		if string(k) != s {
			t.Fatalf("鍵が違う: %q != %q", k, s)
		}
	}
	if len(Known) != len(want) {
		t.Fatalf("Known の数が合わない: %d", len(Known))
	}
}

func TestExeNameAndBack(t *testing.T) {
	for _, k := range Known {
		exe := ExeName(k)
		if exe == "" {
			t.Fatalf("%s の実行ファイル名が空", k)
		}
		if got := FromExe(exe); got != k {
			t.Fatalf("%s → %s → %s", k, exe, got)
		}
		// 大文字で来ても引ける。Windows は大小を区別しない
		if got := FromExe("CHROME.EXE"); got != Chrome {
			t.Fatalf("大文字が引けない: %s", got)
		}
	}
	if got := FromExe("notepad.exe"); got != "" {
		t.Fatalf("知らないものが引けてしまう: %s", got)
	}
}

// 拡張を配れるのは Chrome と Edge だけ。
// ここが増えるときは、配り方も一緒に決めること
func TestOnlyChromeAndEdgeGetExtension(t *testing.T) {
	if !SupportsExtension(Chrome) || !SupportsExtension(Edge) {
		t.Fatal("Chrome と Edge には配れるはず")
	}
	for _, k := range []Kind{Firefox, Brave, Opera} {
		if SupportsExtension(k) {
			t.Fatalf("%s に配る手立てはまだ無いはず", k)
		}
	}
}

func TestNativeHostKey(t *testing.T) {
	k, ok := NativeHostKey(Chrome, "jp.co.eightgrp.agent")
	if !ok || k != `SOFTWARE\Google\Chrome\NativeMessagingHosts\jp.co.eightgrp.agent` {
		t.Fatalf("Chrome の置き場所が違う: %q", k)
	}
	if _, ok := NativeHostKey(Firefox, "x"); ok {
		t.Fatal("Firefox には置き場所を返さないはず")
	}
}

// 探す場所に、利用者のフォルダを直接掘るようなものが混ざっていないこと。
// ここが緩むと、拡張の設定を書く先が本人のフォルダに散る
func TestCandidatePathsAreRelative(t *testing.T) {
	for _, c := range Candidates {
		for _, p := range c.Paths {
			if len(p) > 1 && (p[0] == '\\' || p[1] == ':') {
				t.Fatalf("%s の探し先が絶対パスになっている: %q", c.Kind, p)
			}
		}
	}
	if len(Roots) == 0 {
		t.Fatal("探す根が空")
	}
}
