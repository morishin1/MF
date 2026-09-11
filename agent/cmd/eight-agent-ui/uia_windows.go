//go:build windows

package main

// 前面のブラウザが開いているページの **ホスト名だけ** を取る。
//
// ■ ここがこの機能でいちばん気をつけるところ
//
//	URL の全文は、このファイルの中から外へ出さない。
//	currentHost() が返すのはホスト名だけで、パスもクエリも落としてある。
//	`https://example.com/orders/12345?customer=yamada` は `example.com` になって返る。
//	呼び出し側（main.go の sample）は、それをさらにカテゴリに変換してから送る。
//	サーバに届くのは work / sns のような6語のどれかだけ。
//
// ■ どうやって取るか
//
//	UI Automation（IUIAutomation）で、前面ウィンドウの中から
//	「アドレスバー」にあたる Edit コントロールを探し、その ValuePattern を読む。
//	ウィンドウのタイトル（GetWindowText）は読まない。
//	タイトルには「〇〇様_見積書.xlsx」「△△さんとのDM」が入るため。
//
// ■ COM をどう呼ぶか
//
//	Go には COM のバインディングが標準で無いので、vtable を自分で数えて
//	syscall で呼ぶ。添えてある番号は UIAutomationClient.h の並び順。
//	番号を間違えると別のメソッドを呼ぶことになるので、変えるときは必ず実機で確かめる。

import (
	"errors"
	"sync"
	"syscall"
	"unsafe"

	"github.com/8grp/eight-agent/internal/collect"
	"golang.org/x/sys/windows"
)

var (
	ole32               = windows.NewLazySystemDLL("ole32.dll")
	procCoInitializeEx  = ole32.NewProc("CoInitializeEx")
	procCoCreateInstanc = ole32.NewProc("CoCreateInstance")

	oleaut32          = windows.NewLazySystemDLL("oleaut32.dll")
	procSysFreeString = oleaut32.NewProc("SysFreeString")
	procVariantClear  = oleaut32.NewProc("VariantClear")

	procGetForeground = user32.NewProc("GetForegroundWindow")
)

// CLSID_CUIAutomation {FF48DBA4-60EF-4201-AA87-54103EEF594E}
var clsidCUIAutomation = windows.GUID{
	Data1: 0xFF48DBA4, Data2: 0x60EF, Data3: 0x4201,
	Data4: [8]byte{0xAA, 0x87, 0x54, 0x10, 0x3E, 0xEF, 0x59, 0x4E},
}

// IID_IUIAutomation {30CBE57D-D9D0-452A-AB13-7AC5AC4825EE}
var iidIUIAutomation = windows.GUID{
	Data1: 0x30CBE57D, Data2: 0xD9D0, Data3: 0x452A,
	Data4: [8]byte{0xAB, 0x13, 0x7A, 0xC5, 0xAC, 0x48, 0x25, 0xEE},
}

const (
	clsctxInprocServer = 0x1
	coinitApartment    = 0x2

	// UIAutomationClient.h の定数
	uiaControlTypePropertyId = 30003
	uiaValueValuePropertyId  = 30045
	uiaEditControlTypeId     = 50004
	treeScopeDescendants     = 4

	vtI4   = 3
	vtBstr = 8
)

// IUnknown の vtable は 0:QueryInterface 1:AddRef 2:Release。
// 以下の番号はそこからの続き。
const (
	// IUIAutomation
	vtElementFromHandle       = 6
	vtCreatePropertyCondition = 23

	// IUIAutomationElement
	vtFindFirst               = 5
	vtGetCurrentPropertyValue = 10
)

// comObject は COM インターフェイスへのポインタ。
//
// 先頭に vtable へのポインタが1つあるだけ。
// 指している先は COM（ネイティブ側）が確保したメモリで、Go の GC は動かさない。
// out パラメータは **comObject で受け取る。uintptr を経由してポインタに
// 戻すと、GC が動かせるメモリを指していた場合に壊れるため
// （ここでは実際には壊れないが、その形を残さない）。
type comObject struct {
	vtbl *[64]uintptr
}

func (o *comObject) call(index int, args ...uintptr) (uintptr, error) {
	if o == nil || o.vtbl == nil {
		return 0, errors.New("COM オブジェクトがありません")
	}
	method := o.vtbl[index]
	all := append([]uintptr{uintptr(unsafe.Pointer(o))}, args...)
	r, _, _ := syscall.SyscallN(method, all...)
	if int32(r) < 0 {
		return r, syscall.Errno(r)
	}
	return r, nil
}

func (o *comObject) release() {
	if o != nil && o.vtbl != nil {
		o.call(2)
	}
}

// variant は VARIANT。24バイト（64bit）。
// 中身の取り出しは BSTR と I4 しか使わない
type variant struct {
	vt  uint16
	_   [6]byte
	val uintptr
	_   [8]byte
}

// bstr は VARIANT の中身を BSTR として読むためのもの。
// vt が VT_BSTR のときだけ使う
func (v *variant) bstr() *uint16 {
	if v.vt != vtBstr || v.val == 0 {
		return nil
	}
	return *(**uint16)(unsafe.Pointer(&v.val))
}

var (
	uiaOnce sync.Once
	uiaAuto *comObject
	uiaErr  error
)

// initUIA は UI Automation を1度だけ用意する。
//
// 失敗しても呼び出し側は止まらない。カテゴリが付かないだけで、
// アプリ名と稼働時間はそのまま取れる
func initUIA() (*comObject, error) {
	uiaOnce.Do(func() {
		// このスレッドは STA。UI Automation は STA から呼ぶ
		r, _, _ := procCoInitializeEx.Call(0, coinitApartment)
		// S_OK(0) / S_FALSE(1) / RPC_E_CHANGED_MODE は、どれも続けてよい
		if int32(r) < 0 && uint32(r) != 0x80010106 {
			uiaErr = syscall.Errno(r)
			return
		}
		var p *comObject
		hr, _, _ := procCoCreateInstanc.Call(
			uintptr(unsafe.Pointer(&clsidCUIAutomation)), 0,
			clsctxInprocServer,
			uintptr(unsafe.Pointer(&iidIUIAutomation)),
			uintptr(unsafe.Pointer(&p)),
		)
		if int32(hr) < 0 || p == nil {
			uiaErr = errors.New("UI Automation を用意できませんでした")
			return
		}
		uiaAuto = p
	})
	return uiaAuto, uiaErr
}

// currentHost は、前面のブラウザが開いているページのホスト名を返す。
//
// 取れなければ空。**URL の全文は絶対に返さない。**
func currentHost() string {
	auto, err := initUIA()
	if err != nil || auto == nil {
		return ""
	}

	hwnd, _, _ := procGetForeground.Call()
	if hwnd == 0 {
		return ""
	}

	// 前面ウィンドウを UI Automation の要素にする
	var elem *comObject
	if _, err := auto.call(vtElementFromHandle, hwnd,
		uintptr(unsafe.Pointer(&elem))); err != nil || elem == nil {
		return ""
	}
	defer elem.release()

	// 「Edit コントロールであること」という条件を作る。
	// アドレスバーは、どのブラウザでも Edit として見える
	cond := variant{vt: vtI4, val: uintptr(uiaEditControlTypeId)}
	var condObj *comObject
	if _, err := auto.call(vtCreatePropertyCondition,
		uintptr(uiaControlTypePropertyId),
		uintptr(unsafe.Pointer(&cond)),
		uintptr(unsafe.Pointer(&condObj)),
	); err != nil || condObj == nil {
		return ""
	}
	defer condObj.release()

	// 最初に見つかった Edit を使う。
	// ブラウザの中で最初に来る Edit はアドレスバー（ページ内の入力欄より前）
	var bar *comObject
	if _, err := elem.call(vtFindFirst,
		uintptr(treeScopeDescendants), uintptr(unsafe.Pointer(condObj)),
		uintptr(unsafe.Pointer(&bar)),
	); err != nil || bar == nil {
		return ""
	}
	defer bar.release()

	// ValuePattern の中身＝アドレスバーの文字列
	var v variant
	if _, err := bar.call(vtGetCurrentPropertyValue,
		uintptr(uiaValueValuePropertyId),
		uintptr(unsafe.Pointer(&v)),
	); err != nil {
		return ""
	}
	defer procVariantClear.Call(uintptr(unsafe.Pointer(&v)))

	raw := bstrToString(v.bstr())

	// ここが最後の関門。collect.HostOnly はこの環境でテストしてある
	return collect.HostOnly(raw)
}

func bstrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	// BSTR は長さ（バイト数）が文字列の4バイト手前に入っている
	n := *(*uint32)(unsafe.Add(unsafe.Pointer(p), -4)) / 2
	// アドレスバーに数千文字は入らない。それ以上なら何かがおかしい
	if n == 0 || n > 4096 {
		return ""
	}
	return windows.UTF16ToString(unsafe.Slice(p, n))
}

var _ = procSysFreeString
