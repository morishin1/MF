//go:build windows

package collect

import (
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ここは **UI プロセス（ユーザー権限）** から呼ぶ。
// サービス（SYSTEM）からは Session 0 Isolation で取れない。
//
// ■ 取るのは実行ファイル名だけ
//
//	ウィンドウのタイトルは取らない。GetWindowText は呼ばない。
//	「〇〇様_見積書.xlsx - Excel」「△△さんとのDM - Slack」が入るため。
//	欲しいのは「Excel を2時間40分」であって、何を開いていたかではない。

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadPID  = user32.NewProc("GetWindowThreadProcessId")
	procGetLastInputInfo    = user32.NewProc("GetLastInputInfo")
	procGetTickCount        = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetTickCount")
)

// ForegroundExe は、いま前面にあるアプリの実行ファイル名を返す。
// 取れなければ空。
func ForegroundExe() string {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return ""
	}
	var pid uint32
	procGetWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return ""
	}

	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)

	buf := make([]uint16, windows.MAX_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return ""
	}
	// パスは捨てる。ファイル名だけにする
	return strings.ToLower(filepath.Base(windows.UTF16ToString(buf[:n])))
}

type lastInputInfo struct {
	cbSize uint32
	dwTime uint32
}

// IdleSeconds は、キーボードもマウスも触っていない秒数。
//
// 何を打ったかは見ない。**最後に触った時刻**しか取らない。
// GetLastInputInfo が返すのはそれだけで、内容は取れない仕組みになっている。
func IdleSeconds() int {
	info := lastInputInfo{cbSize: uint32(unsafe.Sizeof(lastInputInfo{}))}
	r, _, _ := procGetLastInputInfo.Call(uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		return 0
	}
	tick, _, _ := procGetTickCount.Call()
	if uint32(tick) < info.dwTime {
		return 0
	}
	return int((uint32(tick) - info.dwTime) / 1000)
}
