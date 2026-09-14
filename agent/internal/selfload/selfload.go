// Package selfload は、エージェント自身がどれだけPCを使っているかを見る。
//
// ■ なぜ自分を見るのか
//
//	端末管理のソフトは、入れられる側から見れば「勝手に入ってきて、
//	ずっと動いているもの」でしかない。それがPCを重くしたら、
//	何を説明しても受け入れてもらえない。
//
//	だから、**PCの操作感に影響を与えないこと**を最優先にする。
//	目標は次のとおり。
//
//	  待機時   CPU 平均 1% 未満
//	  通常時   CPU 平均 2〜3% 未満
//	  メモリ   3つ合わせて 100MB 未満
//
//	守れているかどうかを、人が思い出して測るのではなく、
//	エージェント自身が測り続ける。
//
// ■ 越えたらどうするか
//
//	2つやる。
//
//	  1. **自分で軽くする**… 送る間隔・見にいく間隔を延ばす。
//	     重いまま動き続けるくらいなら、粗くてよい。
//	  2. **管理画面に出す**… 「Agent負荷異常」として知らせる。
//	     黙って軽くすると、何が起きているのか誰も分からない。
//
//	一瞬の跳ねで騒がない。続いたときだけ動く。
//	インストール直後やWindows Update の最中は、誰でも重くなる。
//
// ■ WEB の見かたは変えない
//
//	毎秒見にいく作りにはしない。いまのまま、
//	ブラウザからの報せ（イベント）＋ 決まった間隔でのまとめ、を続ける。
//	重いときに間隔を延ばすのは、そのまとめのほう。
package selfload

import (
	"fmt"
	"time"
)

// Level は、いまどれくらい重いか。
type Level int

const (
	// OK は、目標のうち。
	OK Level = iota
	// High は、目標を越えている。粗くして様子を見る。
	High
	// Critical は、大きく越えている。いちばん粗くして知らせる。
	Critical
)

func (l Level) String() string {
	switch l {
	case High:
		return "high"
	case Critical:
		return "critical"
	default:
		return "ok"
	}
}

// Sample は、1回ぶんの計り。
type Sample struct {
	At time.Time
	// CPUPercent は、PC全体に対する割合（0〜100）。3つのプロセスの合計。
	CPUPercent float64
	// MemoryBytes は、3つのプロセスの合計（実メモリ）。
	MemoryBytes int64
	// Idle は、そのとき誰も触っていなかったか。
	// 待機時と通常時では、許せる重さが違う
	Idle bool
}

// Limits は、どこから「重い」とするか。
//
// 数字は docs/device-agent-testing.md の目標と揃えてある。
// 変えるときは、あちらも直すこと
type Limits struct {
	IdleCPU     float64 // 待機時のCPU（%）
	BusyCPU     float64 // 通常時のCPU（%）
	MemoryBytes int64   // 3つ合わせたメモリ

	// Critical は、目標の何倍を超えたら「大きく越えている」とするか
	CriticalFactor float64

	// Sustain は、何回続いたら重いと決めるか。
	// 一瞬の跳ねで騒がないため
	Sustain int
	// Recover は、何回続いたら元に戻すか。
	// すぐ戻すと、重い・軽いを行き来する
	Recover int
}

// DefaultLimits は、決めた目標そのもの。
func DefaultLimits() Limits {
	return Limits{
		IdleCPU:        1.0,
		BusyCPU:        3.0,
		MemoryBytes:    100 << 20,
		CriticalFactor: 3.0,
		Sustain:        5,
		Recover:        10,
	}
}

// Watcher は、計りを受け取って「重いか」を決める。
//
// 計りかたそのもの（OSごと）とは分けてある。
// 決めかたは、どのOSでも同じで、テストで確かめられるようにするため
type Watcher struct {
	lim Limits

	level Level
	over  int // 続けて越えた回数
	under int // 続けて収まった回数

	last Sample
	// worst は、越えているあいだの、いちばん重かったとき。
	// 知らせるときに「どれくらい重かったか」を言うため
	worst Sample
}

func New(lim Limits) *Watcher {
	if lim.Sustain < 1 {
		lim.Sustain = 1
	}
	if lim.Recover < 1 {
		lim.Recover = 1
	}
	if lim.CriticalFactor < 1 {
		lim.CriticalFactor = 1
	}
	return &Watcher{lim: lim}
}

// Change は、Add の結果。level が変わったときだけ Changed が立つ。
type Change struct {
	Changed bool
	Level   Level
	// Worst は、重くなったと決めたときの、いちばん重かった計り。
	Worst Sample
	// Reason は、何が越えたか（人が読む用）。
	Reason string
}

// Add は、計りを1つ入れて、いまの重さを決める。
func (w *Watcher) Add(s Sample) Change {
	w.last = s

	over, why := w.exceeds(s)
	want := w.level

	if over {
		w.under = 0
		w.over++
		if w.worst.At.IsZero() || heavier(s, w.worst) {
			w.worst = s
		}
		if w.over >= w.lim.Sustain {
			if w.critical(s) {
				want = Critical
			} else if w.level == OK {
				want = High
			}
		}
	} else {
		w.over = 0
		w.under++
		if w.under >= w.lim.Recover {
			want = OK
		}
	}

	if want == w.level {
		return Change{Level: w.level}
	}

	c := Change{Changed: true, Level: want, Worst: w.worst, Reason: why}
	if want == OK {
		// 戻ったので、いちばん重かったときの記録も捨てる
		c.Worst = w.worst
		c.Reason = ""
		w.worst = Sample{}
	}
	w.level = want
	return c
}

// Level は、いまの重さ。
func (w *Watcher) Level() Level { return w.level }

// Last は、いちばん新しい計り。
func (w *Watcher) Last() Sample { return w.last }

func (w *Watcher) cpuLimit(s Sample) float64 {
	if s.Idle {
		return w.lim.IdleCPU
	}
	return w.lim.BusyCPU
}

func (w *Watcher) exceeds(s Sample) (bool, string) {
	lim := w.cpuLimit(s)
	if s.CPUPercent > lim {
		where := "通常時"
		if s.Idle {
			where = "待機時"
		}
		return true, fmt.Sprintf("%sのCPUが %.1f%%（目安 %.1f%%）", where, s.CPUPercent, lim)
	}
	if w.lim.MemoryBytes > 0 && s.MemoryBytes > w.lim.MemoryBytes {
		return true, fmt.Sprintf("メモリが %dMB（目安 %dMB）",
			s.MemoryBytes>>20, w.lim.MemoryBytes>>20)
	}
	return false, ""
}

func (w *Watcher) critical(s Sample) bool {
	f := w.lim.CriticalFactor
	if s.CPUPercent > w.cpuLimit(s)*f {
		return true
	}
	return w.lim.MemoryBytes > 0 && s.MemoryBytes > int64(float64(w.lim.MemoryBytes)*f)
}

// heavier は、a のほうが重いか。CPU を先に見る
func heavier(a, b Sample) bool {
	if a.CPUPercent != b.CPUPercent {
		return a.CPUPercent > b.CPUPercent
	}
	return a.MemoryBytes > b.MemoryBytes
}

// ---- どれくらい粗くするか -------------------------------------------------------

// Slowdown は、いまの重さに応じて、間隔を何倍にするか。
//
// 重いまま動き続けるくらいなら、粗くてよい。
// 粗くしても、取るもの（何を見ているか）は変えない。
// 見る間隔が延びるだけ
func Slowdown(l Level) int {
	switch l {
	case High:
		return 2
	case Critical:
		return 4
	default:
		return 1
	}
}

// Interval は、基準の間隔に重さを掛けたもの。
// 延ばしすぎると記録が粗くなりすぎるので、上限を置く
func Interval(base time.Duration, l Level, max time.Duration) time.Duration {
	d := base * time.Duration(Slowdown(l))
	if max > 0 && d > max {
		return max
	}
	return d
}
