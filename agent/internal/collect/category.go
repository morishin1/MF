// Package collect は、このPCの中で集めたものを「送ってよい形」に落とす。
//
// ここがいちばん大事なところ。
// URL → ホスト名 → カテゴリ の変換は、**必ずこのPCの中で終わらせる**。
// サーバに送ってから落とすと、送信経路とサーバのログに一度は全文が乗る。
// そこが漏れたら、落とした意味がない。
package collect

import (
	"net/url"
	"strings"
)

// Categorizer はホスト名をカテゴリに落とす表。
// サーバの /api/devices/config が配ってくるものを入れる。
type Categorizer struct {
	table map[string]string
}

func NewCategorizer(table map[string]string) *Categorizer {
	t := make(map[string]string, len(table))
	for k, v := range table {
		t[strings.ToLower(strings.TrimPrefix(k, "www."))] = v
	}
	return &Categorizer{table: t}
}

// Of は URL か ホスト名 をカテゴリにする。
//
// 返すのは work / research / sns / video / shopping / other のどれか。
// 表に無いものは other。分類できないものを「怪しい」とはしない。
//
// 引数の url はこの関数の外に出さない。呼び出し側も、戻り値だけを持ち回ること。
func (c *Categorizer) Of(raw string) string {
	h := hostOf(raw)
	if h == "" {
		return "other"
	}
	if v, ok := c.table[h]; ok {
		return v
	}
	// 後ろから1段ずつ削って探す。a.b.example.com → b.example.com → example.com
	parts := strings.Split(h, ".")
	for i := 1; i < len(parts)-1; i++ {
		if v, ok := c.table[strings.Join(parts[i:], ".")]; ok {
			return v
		}
	}
	return "other"
}

func hostOf(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil {
			return ""
		}
		s = u.Hostname()
	} else if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	s = strings.ToLower(strings.TrimPrefix(s, "www."))
	// ポート番号は落とす
	if i := strings.LastIndex(s, ":"); i > 0 && !strings.Contains(s[i:], "]") {
		s = s[:i]
	}
	return s
}

// ExeName はプロセスのパスから実行ファイル名だけを取り出す。
//
// パスは送らない。C:\Users\yamada\... には本人の名前が入っているし、
// 置き場所そのものが仕事の中身を表すことがある。
func ExeName(path string) string {
	s := path
	if i := strings.LastIndexAny(s, `\/`); i >= 0 {
		s = s[i+1:]
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// HostOnly は、アドレスバーから読んだ文字列をホスト名だけにする。
//
// ■ ここが、URL がこのPCから出ていく最後の関門
//
//	currentHost()（Windows側）は、返す前に必ずここを通す。
//	パスもクエリも落とし、ホスト名に見えないものは空にする。
//	アドレスバーには入力途中の検索語が入っていることがあるので、
//	「URLの形をしていないものは送らない」を、ここで確実にやる。
//
// Windows 専用のファイルに置くと、この環境でテストできない。
// いちばん確かめたいところなので、OSに依らないここに置く。
func HostOnly(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	// 空白を含むものは URL ではない（検索語の入力途中）
	if strings.ContainsAny(s, " \t　") {
		return ""
	}
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if i := strings.Index(s, "@"); i >= 0 { // user:pass@host
		s = s[i+1:]
	}
	// ポート番号を落とす（IPv6 の [::1]:8080 も考える）
	if strings.HasPrefix(s, "[") {
		if i := strings.Index(s, "]"); i >= 0 {
			s = s[1:i]
		}
	} else if i := strings.LastIndex(s, ":"); i > 0 {
		s = s[:i]
	}
	s = strings.ToLower(strings.TrimPrefix(s, "www."))

	// ホスト名に見えないものは捨てる。
	// 「.」が1つも無いもの（localhost、検索語の一部）は送らない
	if s == "" || !strings.Contains(s, ".") {
		return ""
	}
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '-'
		if !ok {
			return ""
		}
	}
	return s
}
