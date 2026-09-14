package selfload

import (
	"testing"
	"time"
)

func at(min int) time.Time {
	return time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC).Add(time.Duration(min) * time.Minute)
}

func feed(w *Watcher, n int, s Sample) Change {
	var last Change
	for i := 0; i < n; i++ {
		s.At = at(i)
		c := w.Add(s)
		if c.Changed {
			last = c
		}
	}
	return last
}

const MB = 1 << 20

// ---- 目標のうちなら、何も起きない ------------------------------------------------

func TestQuietWhenWithinTargets(t *testing.T) {
	w := New(DefaultLimits())
	// 待機時 0.4%、メモリ 60MB。目標のうち
	c := feed(w, 50, Sample{CPUPercent: 0.4, MemoryBytes: 60 * MB, Idle: true})
	if c.Changed {
		t.Fatalf("目標のうちなのに知らせた: %+v", c)
	}
	if w.Level() != OK {
		t.Fatalf("OK のはず: %v", w.Level())
	}
	if Slowdown(w.Level()) != 1 {
		t.Fatal("粗くする必要はない")
	}
}

// 通常時は 3% まで許す。待機時の目安（1%）で騒がないこと
func TestBusyAllowsMore(t *testing.T) {
	w := New(DefaultLimits())
	c := feed(w, 50, Sample{CPUPercent: 2.5, MemoryBytes: 80 * MB, Idle: false})
	if c.Changed {
		t.Fatalf("通常時 2.5%% は目標のうち: %+v", c)
	}
}

// 同じ 2.5% でも、誰も触っていないなら重い
func TestIdleIsStricter(t *testing.T) {
	w := New(DefaultLimits())
	c := feed(w, 10, Sample{CPUPercent: 2.5, MemoryBytes: 80 * MB, Idle: true})
	if !c.Changed || c.Level != High {
		t.Fatalf("待機時 2.5%% は重い: %+v", c)
	}
	if c.Reason == "" {
		t.Fatal("何が越えたか言うこと")
	}
}

// ---- 一瞬の跳ねでは騒がない --------------------------------------------------------

// インストール直後や Windows Update の最中は、誰でも重くなる。
// そのたびに「Agent負荷異常」が出ると、誰も見なくなる
func TestSpikeDoesNotAlert(t *testing.T) {
	w := New(DefaultLimits())
	heavy := Sample{CPUPercent: 40, MemoryBytes: 300 * MB, Idle: true}
	light := Sample{CPUPercent: 0.3, MemoryBytes: 60 * MB, Idle: true}

	for i := 0; i < 4; i++ { // Sustain は 5。4回では決めない
		heavy.At = at(i)
		if c := w.Add(heavy); c.Changed {
			t.Fatalf("%d 回目で知らせた（5回続くまで待つはず）", i+1)
		}
	}
	light.At = at(4)
	w.Add(light)
	if w.Level() != OK {
		t.Fatal("収まったら、そのまま OK でいること")
	}
}

func TestSustainedAlerts(t *testing.T) {
	w := New(DefaultLimits())
	heavy := Sample{CPUPercent: 8, MemoryBytes: 60 * MB, Idle: false}
	var got Change
	for i := 0; i < 5; i++ {
		heavy.At = at(i)
		got = w.Add(heavy)
	}
	if !got.Changed || got.Level != High {
		t.Fatalf("5回続いたら知らせる: %+v", got)
	}
	if Slowdown(got.Level) != 2 {
		t.Fatal("重いときは間隔を延ばす")
	}
}

// 大きく越えていたら、いちばん粗くする
func TestCriticalGoesFurther(t *testing.T) {
	w := New(DefaultLimits())
	// 通常時の目安 3% の3倍を超える
	c := feed(w, 6, Sample{CPUPercent: 30, MemoryBytes: 60 * MB, Idle: false})
	if c.Level != Critical {
		t.Fatalf("大きく越えていれば critical: %+v", c)
	}
	if Slowdown(Critical) != 4 {
		t.Fatal("いちばん粗くする")
	}
}

func TestMemoryAlone(t *testing.T) {
	w := New(DefaultLimits())
	// CPU は静かでも、メモリだけで越えることがある（漏れているとき）
	c := feed(w, 6, Sample{CPUPercent: 0.1, MemoryBytes: 250 * MB, Idle: true})
	if !c.Changed || c.Level == OK {
		t.Fatalf("メモリだけでも知らせる: %+v", c)
	}
	if c.Reason == "" || c.Worst.MemoryBytes != 250*MB {
		t.Fatalf("どれくらいだったか残す: %+v", c)
	}
}

// ---- 戻るときは、ゆっくり ----------------------------------------------------------

// すぐ戻すと、重い・軽いを行き来して、そのたびに知らせることになる
func TestRecoveryIsSlow(t *testing.T) {
	w := New(DefaultLimits())
	feed(w, 6, Sample{CPUPercent: 8, MemoryBytes: 60 * MB, Idle: false})
	if w.Level() != High {
		t.Fatal("まず重くしておく")
	}

	light := Sample{CPUPercent: 0.2, MemoryBytes: 50 * MB, Idle: true}
	for i := 0; i < 9; i++ { // Recover は 10
		light.At = at(100 + i)
		if c := w.Add(light); c.Changed {
			t.Fatalf("%d 回で戻した（10回続くまで待つはず）", i+1)
		}
	}
	light.At = at(200)
	c := w.Add(light)
	if !c.Changed || c.Level != OK {
		t.Fatalf("10回続いたら戻す: %+v", c)
	}
}

// 行ったり来たりで、知らせが何度も出ないこと
func TestNoFlapping(t *testing.T) {
	w := New(DefaultLimits())
	heavy := Sample{CPUPercent: 8, MemoryBytes: 60 * MB, Idle: false}
	light := Sample{CPUPercent: 0.2, MemoryBytes: 50 * MB, Idle: true}

	changes := 0
	for round := 0; round < 20; round++ {
		for i := 0; i < 6; i++ {
			heavy.At = at(round*20 + i)
			if w.Add(heavy).Changed {
				changes++
			}
		}
		for i := 0; i < 3; i++ { // 戻り切らない程度に静か
			light.At = at(round*20 + 10 + i)
			if w.Add(light).Changed {
				changes++
			}
		}
	}
	if changes != 1 {
		t.Fatalf("知らせは1回だけのはず（%d 回出た）", changes)
	}
}

// 重いあいだに、さらに重くなったら上げる
func TestHighToCritical(t *testing.T) {
	w := New(DefaultLimits())
	feed(w, 6, Sample{CPUPercent: 5, MemoryBytes: 60 * MB, Idle: false})
	if w.Level() != High {
		t.Fatal("まず high")
	}
	c := feed(w, 6, Sample{CPUPercent: 40, MemoryBytes: 60 * MB, Idle: false})
	if !c.Changed || c.Level != Critical {
		t.Fatalf("さらに重くなったら上げる: %+v", c)
	}
}

// ---- どれくらい粗くするか ------------------------------------------------------------

func TestInterval(t *testing.T) {
	base := 5 * time.Minute
	max := 30 * time.Minute
	if got := Interval(base, OK, max); got != base {
		t.Fatalf("軽いときは、そのまま: %v", got)
	}
	if got := Interval(base, High, max); got != 10*time.Minute {
		t.Fatalf("重いときは倍: %v", got)
	}
	if got := Interval(base, Critical, max); got != 20*time.Minute {
		t.Fatalf("大きく越えていれば4倍: %v", got)
	}
	// 延ばしすぎると記録が粗くなりすぎる
	if got := Interval(20*time.Minute, Critical, max); got != max {
		t.Fatalf("上限で止める: %v", got)
	}
}

// ---- いちばん重かったときを残す --------------------------------------------------------

func TestWorstIsKept(t *testing.T) {
	w := New(DefaultLimits())
	for i, cpu := range []float64{5, 9, 6, 7, 5} {
		w.Add(Sample{At: at(i), CPUPercent: cpu, MemoryBytes: 60 * MB, Idle: false})
	}
	c := w.Add(Sample{At: at(5), CPUPercent: 5, MemoryBytes: 60 * MB, Idle: false})
	_ = c
	if w.worst.CPUPercent != 9 {
		t.Fatalf("いちばん重かったのは 9%%: %v", w.worst.CPUPercent)
	}
}

func TestLevelString(t *testing.T) {
	for l, want := range map[Level]string{OK: "ok", High: "high", Critical: "critical"} {
		if l.String() != want {
			t.Fatalf("%d: %s != %s", l, l.String(), want)
		}
	}
}

// 変な設定でも壊れない
func TestNewFixesBadLimits(t *testing.T) {
	w := New(Limits{Sustain: 0, Recover: -3, CriticalFactor: 0})
	if w.lim.Sustain < 1 || w.lim.Recover < 1 || w.lim.CriticalFactor < 1 {
		t.Fatalf("直していない: %+v", w.lim)
	}
	// 1回で決まる設定でも、落ちずに動くこと
	c := w.Add(Sample{At: at(0), CPUPercent: 50, MemoryBytes: 500 * MB})
	if !c.Changed {
		t.Fatal("動くこと")
	}
}
