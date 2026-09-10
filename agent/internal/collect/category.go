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
