//go:build windows

package browsers

import (
	"os"
	"path/filepath"
)

// Detect は、このパソコンに入っているブラウザを返す。
//
// 見るのは「実行ファイルがそこにあるか」だけ。
// 開かない。プロファイルも履歴もブックマークも読まない。
func Detect() []Found {
	out := make([]Found, 0, len(Candidates))
	for _, c := range Candidates {
		f := Found{Kind: c.Kind}
		for _, rel := range c.Paths {
			if p, ok := findIn(rel); ok {
				f.Installed = true
				f.Path = p
				break
			}
		}
		out = append(out, f)
	}
	return out
}

// findIn は、探す根を順に当てて、実行ファイルがあるかを見る。
func findIn(rel string) (string, bool) {
	for _, root := range Roots {
		base := os.Getenv(root)
		if base == "" {
			continue
		}
		p := filepath.Join(base, rel)
		st, err := os.Stat(p)
		if err == nil && !st.IsDir() {
			return p, true
		}
	}
	return "", false
}

// Installed は、入っているものだけを返す。
func Installed() []Found {
	out := []Found{}
	for _, f := range Detect() {
		if f.Installed {
			out = append(out, f)
		}
	}
	return out
}
