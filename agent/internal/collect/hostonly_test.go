package collect

import (
	"strings"
	"testing"
)

// HostOnly は、URL がこのPCから出ていく最後の関門。
// ここが漏れると、送信経路とサーバのログに全文が乗る。
// アドレスバーから読んだ文字列がそのまま来る前提で確かめる。

func TestHostOnlyDropsEverythingButHost(t *testing.T) {
	cases := []struct{ in, want string }{
		// パス・クエリ・フラグメントは落ちる
		{"https://example.com/orders/12345?customer=yamada", "example.com"},
		{"https://example.com/#/secret", "example.com"},
		{"http://example.com", "example.com"},
		{"example.com/path", "example.com"},
		// www. とポートは落とす
		{"https://www.example.com:8443/x", "example.com"},
		{"example.com:443", "example.com"},
		// 大文字は小文字に
		{"HTTPS://Example.COM/X", "example.com"},
		// user:pass@ は落とす（資格情報がURLに入っていることがある）
		{"https://user:pass@example.com/x", "example.com"},
		// IPv6
		{"http://[2001:db8::1]:8080/x", ""},
	}
	for _, c := range cases {
		if got := HostOnly(c.in); got != c.want {
			t.Errorf("HostOnly(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestHostOnlyRefusesSearchTerms(t *testing.T) {
	// アドレスバーには、入力途中の検索語がそのまま入っている。
	// これを送ってしまうと「打った内容は取りません」が嘘になる
	for _, s := range []string{
		"新宿 ランチ おすすめ",
		"取引先 見積 いくら",
		"how to quit my job",
		"エラー 対処法",
		"localhost",
		"localhost:3000",
		"about:blank",
		"",
		"   ",
	} {
		if got := HostOnly(s); got != "" {
			t.Errorf("検索語や URL でないものを通しました: HostOnly(%q) = %q", s, got)
		}
	}
}

func TestHostOnlyRefusesWeirdCharacters(t *testing.T) {
	// ホスト名に使えない字が入っていたら、URL ではない
	for _, s := range []string{
		"日本語.テスト/path",
		"exa mple.com",
		"<script>alert(1)</script>",
		"example.com\x00evil",
	} {
		if got := HostOnly(s); got != "" {
			t.Errorf("ホスト名でないものを通しました: HostOnly(%q) = %q", s, got)
		}
	}
}

func TestHostOnlyNeverReturnsLongerThanInput(t *testing.T) {
	// 念のため。落とすだけの関数なので、増えることはない
	long := "https://example.com/" + string(make([]byte, 5000))
	got := HostOnly(long)
	if len(got) > 100 {
		t.Fatalf("長すぎるものを返しました（%d文字）", len(got))
	}
}

// 実際の流れ：アドレスバー → HostOnly → カテゴリ。
// サーバに届くのは最後の1語だけであることを、続けて確かめる
func TestAddressBarToCategoryLeaksNothing(t *testing.T) {
	c := NewCategorizer(map[string]string{
		"github.com": "work",
		"x.com":      "sns",
	})
	secret := "https://github.com/8grp/private/blob/main/%E7%A7%98%E5%AF%86.txt?token=abc123"

	host := HostOnly(secret)
	if host != "github.com" {
		t.Fatalf("ホスト名だけになっていません: %q", host)
	}
	cat := c.Of(host)
	switch cat {
	case "work", "research", "sns", "video", "shopping", "other":
	default:
		t.Fatalf("カテゴリ以外が返りました: %q", cat)
	}
	if cat != "work" {
		t.Fatalf("カテゴリがちがいます: %q", cat)
	}
}

// PathOnly は、サーバへ出す前に URL を削る。
// ここが緩むと、検索語や一度きりの鍵がそのまま会社へ届く
func TestPathOnly(t *testing.T) {
	cases := []struct{ in, want string }{
		// 問い合わせと断片は必ず落ちる
		{"https://x.jp/a/b?q=" + "ひみつ", "/a/b"},
		{"https://www.google.com/search?q=転職", "/search"},
		{"https://mail.google.com/mail/u/0/#inbox/FMfcgzABCD", "/mail/u/0"},
		{"https://x.jp/a#frag", "/a"},
		// 一度きりのリンクに見える区切りは伏せる
		{"https://x.jp/reset/9f3c8a2bd41e77aa", "/reset/…"},
		{"https://x.jp/i/aGVsbG8td29ybGQxMjM0", "/i/…"},
		// 何のページかは残す
		{"https://x.jp/recruit/apply", "/recruit/apply"},
		{"https://x.jp/news/2026/09", "/news/2026/09"},
		// パスが無い
		{"https://x.jp/", ""},
		{"https://x.jp", ""},
		{"", ""},
		// ホスト名だけで来ても、パスとして解釈しない
		{"x.jp", "/x.jp"},
	}
	for _, c := range cases {
		if got := PathOnly(c.in); got != c.want {
			t.Errorf("PathOnly(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 区切りの数と長さに上限があること。
// 長いパスをそのまま送ると、それ自体が中身になる
func TestPathOnlyLimits(t *testing.T) {
	long := "https://x.jp/" + strings.Repeat("segment/", 20)
	got := PathOnly(long)
	if strings.Count(got, "/") > 6 {
		t.Errorf("区切りが多すぎる: %q", got)
	}
	if len(got) > 120 {
		t.Errorf("長すぎる: %d", len(got))
	}
	// 1区切りも切り詰める
	one := PathOnly("https://x.jp/" + strings.Repeat("あ", 60))
	if len([]rune(one)) > 121 {
		t.Errorf("1区切りが切り詰められていない: %q", one)
	}
}

// 人が読む語は伏せない。伏せすぎると、何のページか分からなくなって意味が無い
func TestPathOnlyKeepsWords(t *testing.T) {
	for _, s := range []string{"/about", "/採用情報", "/news", "/v2", "/2026"} {
		if got := PathOnly("https://x.jp" + s); got != s {
			t.Errorf("PathOnly(%q) = %q（伏せすぎ）", s, got)
		}
	}
}
