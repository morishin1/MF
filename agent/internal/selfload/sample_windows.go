//go:build windows

package selfload

import (
	"runtime"
	"time"

	"golang.org/x/sys/windows"
)

// 見るのは、うちの3つだけ。ほかのソフトがどれだけ使っているかは見ない
var ours = []string{
	"eight-agent-svc.exe",
	"eight-agent-ui.exe",
	"eight-agent-host.exe",
}

// Sampler は、うちの3つがどれだけ使っているかを計る。
//
// CPU は「前に計ってから今までに使った時間 ÷ 経過時間 ÷ 論理CPU数」。
// 1回では出せないので、前回の値を持っておく
type Sampler struct {
	cpus  int
	prev  time.Time
	prevT time.Duration
}

func NewSampler() *Sampler {
	// 論理CPU数。「PC全体のうち何%か」にするために割る。
	// 8コアのPCで1コアを使い切っても、全体では 12.5%
	n := runtime.NumCPU()
	if n < 1 {
		n = 1
	}
	return &Sampler{cpus: n}
}

// Sample は、1回ぶん計る。
// 1回目は CPU を出せないので ok が false（差が取れないため）
func (s *Sampler) Sample(idle bool) (Sample, bool) {
	pids := findOurs()

	var cpu time.Duration
	var mem int64
	for _, pid := range pids {
		t, m := usageOf(pid)
		cpu += t
		mem += m
	}

	now := time.Now()
	out := Sample{At: now, MemoryBytes: mem, Idle: idle}

	if s.prev.IsZero() {
		s.prev, s.prevT = now, cpu
		return out, false
	}

	elapsed := now.Sub(s.prev)
	used := cpu - s.prevT
	s.prev, s.prevT = now, cpu

	if elapsed <= 0 {
		return out, false
	}
	// プロセスが入れ替わると、合計が減ることがある。負の割合は出さない
	if used < 0 {
		used = 0
	}
	out.CPUPercent = float64(used) / float64(elapsed) / float64(s.cpus) * 100
	if out.CPUPercent < 0 {
		out.CPUPercent = 0
	}
	return out, true
}

// findOurs は、うちの3つの PID を集める
func findOurs() []uint32 {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)

	var e windows.ProcessEntry32
	e.Size = uint32(unsafeSizeof(e))
	if err := windows.Process32First(snap, &e); err != nil {
		return nil
	}
	var out []uint32
	for {
		name := windows.UTF16ToString(e.ExeFile[:])
		for _, want := range ours {
			if equalFold(name, want) {
				out = append(out, e.ProcessID)
				break
			}
		}
		if err := windows.Process32Next(snap, &e); err != nil {
			break
		}
	}
	return out
}

// usageOf は、そのプロセスが使ったCPU時間と、いまの実メモリ
func usageOf(pid uint32) (time.Duration, int64) {
	h, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return 0, 0
	}
	defer windows.CloseHandle(h)

	var create, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &create, &exit, &kernel, &user); err != nil {
		return 0, 0
	}
	// FILETIME は100ナノ秒きざみ
	ticks := filetimeTicks(kernel) + filetimeTicks(user)
	cpu := time.Duration(ticks) * 100 * time.Nanosecond

	var mc processMemoryCounters
	mc.cb = uint32(unsafeSizeof(mc))
	if err := getProcessMemoryInfo(h, &mc); err != nil {
		return cpu, 0
	}
	return cpu, int64(mc.WorkingSetSize)
}

func filetimeTicks(f windows.Filetime) uint64 {
	return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime)
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		x, y := a[i], b[i]
		if 'A' <= x && x <= 'Z' {
			x += 'a' - 'A'
		}
		if 'A' <= y && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}
