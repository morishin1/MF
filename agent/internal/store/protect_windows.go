//go:build windows

package store

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// DPAPI（マシンスコープ）で包む・ほどく。
//
// マシンスコープにするのは、サービス（SYSTEM）とインストーラの両方から
// 触れる必要があるため。ユーザースコープだと、ログオンしている人が
// 変わったときに読めなくなる。
//
// ファイルの ACL で守るのが主で、DPAPI は「ディスクを抜かれたとき」のぶん。
// どちらか片方では足りない。

var (
	crypt32          = windows.NewLazySystemDLL("crypt32.dll")
	procProtectData  = crypt32.NewProc("CryptProtectData")
	procUnprotectDat = crypt32.NewProc("CryptUnprotectData")
	kernel32         = windows.NewLazySystemDLL("kernel32.dll")
	procLocalFree    = kernel32.NewProc("LocalFree")
)

const cryptprotectLocalMachine = 0x4

type dataBlob struct {
	cbData uint32
	pbData *byte
}

func newBlob(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{cbData: uint32(len(b)), pbData: &b[0]}
}

func (b dataBlob) bytes() []byte {
	if b.pbData == nil || b.cbData == 0 {
		return nil
	}
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	return out
}

func protect(plain []byte) ([]byte, error) {
	in := newBlob(plain)
	var out dataBlob
	r, _, err := procProtectData.Call(
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0,
		uintptr(cryptprotectLocalMachine),
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return nil, fmt.Errorf("シークレットを包めませんでした: %w", err)
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.bytes(), nil
}

func unprotect(sealed []byte) ([]byte, error) {
	in := newBlob(sealed)
	var out dataBlob
	r, _, err := procUnprotectDat.Call(
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0,
		uintptr(cryptprotectLocalMachine),
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return nil, fmt.Errorf("シークレットをほどけませんでした: %w", err)
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.bytes(), nil
}
