//go:build windows

package collect

import (
	"time"

	"golang.org/x/sys/windows"
)

// Windows のセッション通知（ロック・解除・ログオン・ログオフ）と、
// USB の抜き差しを受け取る。
//
// ■ サービス（SYSTEM）から取れるもの・取れないもの
//
//	取れる  … セッションの状態、デバイスの抜き差し、レジストリの変化
//	取れない … いま前面にあるウィンドウ、キーボードを最後に触った時刻
//
//	Session 0 Isolation のため、サービスは対話セッションを覗けない。
//	だから「いま何のアプリを使っているか」は UI プロセスが見て、
//	名前付きパイプでこちらに渡す。cmd/eight-agent-ui を参照。

const (
	wtsConsoleConnect    = 0x1
	wtsConsoleDisconnect = 0x2
	wtsSessionLogon      = 0x5
	wtsSessionLogoff     = 0x6
	wtsSessionLock       = 0x7
	wtsSessionUnlock     = 0x8
)

// SessionKind は Windows のセッション通知を、こちらの言葉に直す。
func SessionKind(code uint32) string {
	switch code {
	case wtsSessionLogon, wtsConsoleConnect:
		return "logon"
	case wtsSessionLogoff, wtsConsoleDisconnect:
		return "logoff"
	case wtsSessionLock:
		return "lock"
	case wtsSessionUnlock:
		return "unlock"
	}
	return ""
}

// PowerKind は電源の通知を、こちらの言葉に直す。
func PowerKind(code uint32) string {
	switch code {
	case 0x4: // PBT_APMSUSPEND
		return "sleep"
	case 0x7, 0x12: // PBT_APMRESUMESUSPEND / PBT_APMRESUMEAUTOMATIC
		return "wake"
	}
	return ""
}

// Hostname はこのPCの名前。変わることがあるので、送るたびに取り直す。
func Hostname() string {
	n, err := windows.ComputerName()
	if err != nil {
		return ""
	}
	return n
}

// OSVersion は「10.0.22631」のような形で返す。
func OSVersion() (version, build string) {
	v := windows.RtlGetVersion()
	return itoa(int(v.MajorVersion)) + "." + itoa(int(v.MinorVersion)), itoa(int(v.BuildNumber))
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// BootEvent は、このPCが起動した時刻を返す。
// サービスが上がった時点で1件送る。
func BootEvent() (time.Time, bool) {
	ms, err := bootMillis()
	if err != nil {
		return time.Time{}, false
	}
	return time.Now().Add(-time.Duration(ms) * time.Millisecond), true
}

func bootMillis() (uint64, error) {
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	proc := kernel32.NewProc("GetTickCount64")
	r, _, err := proc.Call()
	if r == 0 {
		return 0, err
	}
	return uint64(r), nil
}
