package collect

import "testing"

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
