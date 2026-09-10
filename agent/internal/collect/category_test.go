package collect

import "testing"

// URL がこのPCの外へ出ないことが、この機能でいちばん大事なところ。
// ここが崩れると、送信経路とサーバのログに全文が乗る。

func TestOfReturnsOnlyCategory(t *testing.T) {
	c := NewCategorizer(map[string]string{
		"github.com":      "work",
		"mail.google.com": "work",
		"google.com":      "research",
		"x.com":           "sns",
	})

	cases := []struct{ in, want string }{
		// パスもクエリも落ちる。返るのはカテゴリだけ
		{"https://github.com/8grp/secret-repo/pull/42", "work"},
		{"https://mail.google.com/mail/u/0/#inbox/FMfcgz", "work"},
		{"https://www.google.com/search?q=%E7%A7%98%E5%AF%86", "research"},
		{"https://x.com/someone/status/123", "sns"},
		// 表に無いものは other。分類できないものを「怪しい」とはしない
		{"https://example.co.jp/orders/12345?customer=yamada", "other"},
		{"", "other"},
		// ホスト名だけでも通る
		{"github.com", "work"},
		{"GitHub.com", "work"},
		{"www.github.com", "work"},
		// ポート番号は落とす
		{"https://github.com:443/x", "work"},
	}
	for _, c2 := range cases {
		if got := c.Of(c2.in); got != c2.want {
			t.Errorf("Of(%q) = %q, want %q", c2.in, got, c2.want)
		}
	}
}

func TestOfNeverLeaksInput(t *testing.T) {
	c := NewCategorizer(map[string]string{"github.com": "work"})
	secret := "https://github.com/8grp/private/blob/main/%E7%A7%98%E5%AF%86.txt?token=abc123"
	got := c.Of(secret)
	// 戻り値は決まった6語のどれかにしかならない
	switch got {
	case "work", "research", "sns", "video", "shopping", "other":
	default:
		t.Fatalf("カテゴリ以外が返りました: %q", got)
	}
	if len(got) > 10 {
		t.Fatalf("カテゴリにしては長すぎます: %q", got)
	}
}

func TestOfPrefersMoreSpecific(t *testing.T) {
	c := NewCategorizer(map[string]string{
		"google.com":      "research",
		"mail.google.com": "work",
	})
	if got := c.Of("mail.google.com"); got != "work" {
		t.Errorf("より具体的なほうが勝つはず: %q", got)
	}
	if got := c.Of("news.google.com"); got != "research" {
		t.Errorf("表に無いサブドメインは親に落ちるはず: %q", got)
	}
}

func TestExeNameDropsPath(t *testing.T) {
	// パスにはユーザー名が入る。置き場所そのものが仕事の中身を表すこともある
	cases := []struct{ in, want string }{
		{`C:\Users\yamada\AppData\Local\Programs\chrome.exe`, "chrome.exe"},
		{`C:/Users/yamada/excel.exe`, "excel.exe"},
		{"slack.exe", "slack.exe"},
		{"", ""},
	}
	for _, c := range cases {
		if got := ExeName(c.in); got != c.want {
			t.Errorf("ExeName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	long := ExeName("a" + string(make([]byte, 300)) + ".exe")
	if len(long) > 120 {
		t.Errorf("長すぎるものを切っていません: %d", len(long))
	}
}
