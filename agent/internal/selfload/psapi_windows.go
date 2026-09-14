//go:build windows

package selfload

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// PROCESS_MEMORY_COUNTERS（psapi.h）。
// 使うのは WorkingSetSize だけだが、大きさを合わせないと呼べない
type processMemoryCounters struct {
	cb                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

var (
	// Windows 7 以降は kernel32 に寄せてある（K32GetProcessMemoryInfo）。
	// psapi.dll を直接読まないのは、版によって置き場所が違うため
	modKernel32              = windows.NewLazySystemDLL("kernel32.dll")
	procGetProcessMemoryInfo = modKernel32.NewProc("K32GetProcessMemoryInfo")
)

func getProcessMemoryInfo(h windows.Handle, mc *processMemoryCounters) error {
	r, _, err := procGetProcessMemoryInfo.Call(
		uintptr(h), uintptr(unsafe.Pointer(mc)), uintptr(mc.cb))
	if r == 0 {
		if err != nil {
			return err
		}
		return fmt.Errorf("K32GetProcessMemoryInfo が失敗しました")
	}
	return nil
}

func unsafeSizeof(v any) uintptr {
	switch x := v.(type) {
	case processMemoryCounters:
		return unsafe.Sizeof(x)
	case windows.ProcessEntry32:
		return unsafe.Sizeof(x)
	}
	return 0
}
