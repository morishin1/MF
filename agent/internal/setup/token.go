// Package setup は、インストーラが「自分は誰のために落とされたか」を知るところ。
//
// ■ なぜファイル名から読むのか
//
//	本人はグループウェアにログインしている。誰なのかはもう分かっている。
//	それなのに登録コードを配って打たせるのは、配る手間と打ち間違いを
//	足しているだけで、確かめられることは増えていない。
//
//	そこで、本人がマイページで作った札を、落とすファイルの名前に入れる。
//
//	  EIGHT-Agent-Setup-<札>.exe
//
//	インストーラは自分のファイル名から読む。打ち込ませない。
//	**中身は変えない**ので、署名もハッシュもそのまま通るし、
//	配る版を人ごとに作り分けなくてよい。
//
// ■ 読んだものを、そのまま信じない
//
//	ファイル名は誰でも変えられる。ここで確かめるのは形だけで、
//	その札が本当に生きているかはサーバが決める。
//	形が合わなければ「無い」として扱い、インストーラは自分で札を作る。
//	止まらないことが大事で、ここで弾いても何も守れない。
package setup

import "strings"

// Prefix は、配るファイルの名前の頭。サーバ側（api/devices/setup.js）と合わせる。
const Prefix = "EIGHT-Agent-Setup-"

// 札は32バイトの乱数を base64url にしたもの（43文字）。
// 幅を持たせてあるのは、作り方を変えたときに弾かないため
const (
	minLen = 32
	maxLen = 200
)

// TokenFromPath は、実行ファイルのパスに入っている札を返す。
// 入っていなければ空文字。
func TokenFromPath(path string) string {
	name := base(path)
	name = strings.TrimSuffix(name, ext(name))

	// ブラウザは、同じ名前が既にあると " (1)" を付ける。
	// 落とし直した人のぶんを、ここで拾えなくする理由がない
	if i := strings.Index(name, " ("); i > 0 {
		name = name[:i]
	}
	name = strings.TrimSpace(name)

	if !strings.HasPrefix(name, Prefix) {
		return ""
	}
	t := strings.TrimPrefix(name, Prefix)
	if len(t) < minLen || len(t) > maxLen {
		return ""
	}
	for _, r := range t {
		if !isTokenChar(r) {
			return ""
		}
	}
	return t
}

// base は、区切りが / でも \ でもファイル名を取り出す。
//
// filepath.Base は、動いている OS の区切りしか見ない。
// このコードは Windows で動くが、テストは Linux で回すので、
// OS に任せると「Linux では通らないが Windows では通る」ができてしまう。
// 確かめられないコードにしないため、ここは自分で切る
func base(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// ext は、最後の . から後ろ。区切りより後ろにある . だけを見る
func ext(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		return name[i:]
	}
	return ""
}

func isTokenChar(r rune) bool {
	return (r >= 'a' && r <= 'z') ||
		(r >= 'A' && r <= 'Z') ||
		(r >= '0' && r <= '9') ||
		r == '-' || r == '_'
}
