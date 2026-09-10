//go:build !windows

package store

// Windows 以外では DPAPI が無い。開発中に動かすためだけのもの。
//
// 包まずにそのまま置く。この道で本番のPCを動かさないこと。
// 本番は Windows なので、protect_windows.go のほうが使われる。
func protect(plain []byte) ([]byte, error)    { return plain, nil }
func unprotect(sealed []byte) ([]byte, error) { return sealed, nil }
