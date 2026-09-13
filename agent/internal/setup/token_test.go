package setup

import "testing"

// 本物の札は、32バイトの乱数を base64url にしたもの（43文字）
const good = "HB84rDZMlz2tsQ-jB3GO8GMVEDEw42VgHd2FVGpAZBM"

func TestTokenFromPath(t *testing.T) {
	cases := []struct {
		name string
		path string
		want string
	}{
		{"ふつう", `C:\Users\taro\Downloads\EIGHT-Agent-Setup-` + good + `.exe`, good},
		{"スラッシュ区切り", "/tmp/EIGHT-Agent-Setup-" + good + ".exe", good},
		{"名前だけ", "EIGHT-Agent-Setup-" + good + ".exe", good},

		// ブラウザは同名を避けて " (1)" を付ける。落とし直した人を弾かない
		{"落とし直し", `C:\Downloads\EIGHT-Agent-Setup-` + good + ` (1).exe`, good},
		{"落とし直し2桁", `C:\Downloads\EIGHT-Agent-Setup-` + good + ` (12).exe`, good},

		// 札が入っていないものは、空。インストーラは自分で作る側に回る
		{"素のまま", `C:\Downloads\EIGHT-Agent-Setup.exe`, ""},
		{"別の名前", `C:\Downloads\setup.exe`, ""},
		{"頭が違う", `C:\Downloads\EIGHT-Agent-` + good + `.exe`, ""},
		{"空", "", ""},

		// 形が合わないものは通さない
		{"短すぎる", "EIGHT-Agent-Setup-abc.exe", ""},
		{"長すぎる", "EIGHT-Agent-Setup-" + repeat("a", 201) + ".exe", ""},
		{"変な字", "EIGHT-Agent-Setup-" + good[:40] + "!!!.exe", ""},
		{"空白入り", "EIGHT-Agent-Setup-" + good[:20] + " " + good[20:] + ".exe", ""},
		{"パス区切りを混ぜる", "EIGHT-Agent-Setup-" + good[:20] + "/../" + good[24:] + ".exe", ""},
		{"日本語", "EIGHT-Agent-Setup-" + repeat("あ", 40) + ".exe", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := TokenFromPath(c.path); got != c.want {
				t.Errorf("TokenFromPath(%q)\n got %q\nwant %q", c.path, got, c.want)
			}
		})
	}
}

// 札をファイル名に入れて、また読み出せること。
// サーバ（api/devices/setup.js）が作る名前と、ここが読む名前は同じ形
func TestRoundTrip(t *testing.T) {
	for _, tok := range []string{
		good,
		repeat("A", 32),
		repeat("z", 200),
		"aA0-_" + repeat("x", 38),
	} {
		name := Prefix + tok + ".exe"
		if got := TokenFromPath(name); got != tok {
			t.Errorf("%q → %q（戻らない）", name, got)
		}
	}
}

// 拡張子が無い・違うときも、名前が合っていれば読む。
// Windows が拡張子を隠している環境で落としたものを弾かない
func TestExtension(t *testing.T) {
	if got := TokenFromPath(Prefix + good); got != good {
		t.Errorf("拡張子なしで読めない: %q", got)
	}
	if got := TokenFromPath(Prefix + good + ".EXE"); got != good {
		t.Errorf("大文字の拡張子で読めない: %q", got)
	}
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}
