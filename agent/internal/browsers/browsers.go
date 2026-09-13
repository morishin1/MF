// Package browsers は、このパソコンにどのブラウザが入っているかを見る。
//
// ■ 何のためか
//
//	インストーラが「Chrome と Edge が入っている」と分かれば、
//	その2つにだけ拡張の設定を書けばよい。入っていないブラウザの設定を
//	書き散らさない。
//	管理画面にも「Chrome ●連携済 / Edge ●未連携」として出る。
//
// ■ 見るのは、実行ファイルがあるかどうかだけ
//
//	レジストリの「既定のブラウザ」は見ない。既定でなくても使うことはある。
//	閲覧履歴のファイルにも触らない。ここで欲しいのは「入っているか」だけ。
//
// ■ プロファイルもブックマークも読まない
//
//	読む口をこのパッケージに作らない。
package browsers

import "strings"

// Kind は管理画面と揃えた鍵。lib/devices.js の BROWSERS と同じ
type Kind string

const (
	Chrome  Kind = "chrome"
	Edge    Kind = "edge"
	Firefox Kind = "firefox"
	Brave   Kind = "brave"
	Opera   Kind = "opera"
)

// Known は見にいく順。上から順に探す
var Known = []Kind{Chrome, Edge, Firefox, Brave, Opera}

// Candidate は、そのブラウザを探す場所。
//
// 環境変数の展開は Windows 側で行う。ここは表を持つだけなので、
// どのOSでも読めて、そのまま試験できる
type Candidate struct {
	Kind Kind
	// 相対パス。先頭の {P} は探す根（ProgramFiles など）に置き換わる
	Paths []string
}

// Roots は探す根の名前。Windows 側でこの順に環境変数を引く
var Roots = []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"}

// Candidates は、どこに何があるか。
//
// どれも「実行ファイルがそこにあるか」を見るだけ。開かない。
var Candidates = []Candidate{
	{Chrome, []string{
		`Google\Chrome\Application\chrome.exe`,
	}},
	{Edge, []string{
		`Microsoft\Edge\Application\msedge.exe`,
	}},
	{Firefox, []string{
		`Mozilla Firefox\firefox.exe`,
	}},
	{Brave, []string{
		`BraveSoftware\Brave-Browser\Application\brave.exe`,
	}},
	{Opera, []string{
		`Opera\opera.exe`,
		`Programs\Opera\opera.exe`,
	}},
}

// Found は1つぶんの結果。
type Found struct {
	Kind Kind   `json:"browser"`
	// 入っているか
	Installed bool `json:"installed"`
	// 拡張から届いているか。インストーラの時点では必ず false
	Linked bool `json:"linked"`
	// 見つけた場所。サーバへは送らない（利用者名が入ることがある）
	Path string `json:"-"`
}

// ExtensionPolicy は、拡張を配るときにブラウザごとに違うところ。
//
// Chrome と Edge は同じ形のポリシーを、別の場所に置く。
// Firefox は仕組みが違うので、いまは対象にしない
type ExtensionPolicy struct {
	Kind Kind
	// レジストリの置き場所（HKLM の下）
	Key string
}

// Policies は拡張を強制で入れられるブラウザ。
//
// 社員に入れさせない、が目的なので、
// 「会社が配る」形（ExtensionInstallForcelist）で入れる
var Policies = []ExtensionPolicy{
	{Chrome, `SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist`},
	{Edge, `SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist`},
}

// NativeHostKey は、ブラウザが継ぎ役（eight-agent-host.exe）を見つける場所。
func NativeHostKey(k Kind, hostName string) (string, bool) {
	switch k {
	case Chrome:
		return `SOFTWARE\Google\Chrome\NativeMessagingHosts\` + hostName, true
	case Edge:
		return `SOFTWARE\Microsoft\Edge\NativeMessagingHosts\` + hostName, true
	}
	return "", false
}

// SupportsExtension は、いま拡張を配れるブラウザか。
func SupportsExtension(k Kind) bool {
	for _, p := range Policies {
		if p.Kind == k {
			return true
		}
	}
	return false
}

// ExeName は、そのブラウザの実行ファイル名。
// サービス側が「いまブラウザを使っている」を見分けるのに使う
func ExeName(k Kind) string {
	switch k {
	case Chrome:
		return "chrome.exe"
	case Edge:
		return "msedge.exe"
	case Firefox:
		return "firefox.exe"
	case Brave:
		return "brave.exe"
	case Opera:
		return "opera.exe"
	}
	return ""
}

// FromExe は実行ファイル名から鍵を引く。見つからなければ空
func FromExe(exe string) Kind {
	e := strings.ToLower(strings.TrimSpace(exe))
	for _, k := range Known {
		if ExeName(k) == e {
			return k
		}
	}
	return ""
}
