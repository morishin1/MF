package collect

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 取ってはいけないものに手が届くAPIを、うっかり呼ばないようにする。
//
// 「取らない」と規程にも画面にも書いてある。
// 書いてあるだけでは、あとから誰かが1行足したときに崩れる。
// ここで落ちるようにしておく。
//
// コメントの中は数えない。呼んでいるかどうかだけを見る。
func TestNoForbiddenWindowsAPIs(t *testing.T) {
	forbidden := map[string]string{
		"GetWindowText":          "ウィンドウのタイトル（ファイル名や相手の名前が入る）",
		"SetWindowsHookEx":       "キー入力・マウスのフック（キーロガー）",
		"GetAsyncKeyState":       "キーの状態（キーロガーになりうる）",
		"GetKeyboardState":       "キーの状態（同上）",
		"GetClipboardData":       "コピーした内容",
		"BitBlt":                 "画面のコピー（スクリーンショット）",
		"PrintWindow":            "ウィンドウの画像化",
		"CreateCompatibleBitmap": "画面のコピーに使う",
	}

	root := ".."
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		code := stripComments(string(raw))
		for api, why := range forbidden {
			if strings.Contains(code, api) {
				t.Errorf("%s が %s を呼んでいます。これは取らないと決めたもの: %s", path, api, why)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

var (
	lineComment  = regexp.MustCompile(`(?m)//.*$`)
	blockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
)

func stripComments(s string) string {
	s = blockComment.ReplaceAllString(s, "")
	return lineComment.ReplaceAllString(s, "")
}
