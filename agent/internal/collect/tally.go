package collect

import (
	"sync"
	"time"
)

// JST は日本時間。サーバも日本時間で日付を切るので、こちらもそろえる。
var JST = time.FixedZone("JST", 9*3600)

func WorkDate(t time.Time) string { return t.In(JST).Format("2006-01-02") }

// Tally は1日ぶんの集計。
//
// ■ 生の秒単位は、ここで捨てる
//
//	「何時何分に何のアプリを触っていたか」を持つと、それは行動の記録になる。
//	1日の合計だけ持てば、端末管理には足りる。
type Tally struct {
	mu sync.Mutex

	date    string
	active  int // 使っていた分
	idle    int // 離席していた分
	locked  int // ロックしていた分
	night   int
	holiday int
	firstAt time.Time
	lastAt  time.Time

	apps map[string]*appTally
	web  map[string]int

	nightFrom, nightTo int // 日本時間での 分
}

type appTally struct {
	product string
	minutes int
}

func NewTally(date string, nightFrom, nightTo int) *Tally {
	return &Tally{
		date:      date,
		apps:      map[string]*appTally{},
		web:       map[string]int{},
		nightFrom: nightFrom,
		nightTo:   nightTo,
	}
}

func (t *Tally) Date() string { return t.date }

// State は1分ぶんの状態。1分ごとに1回だけ呼ぶ。
type State int

const (
	StateActive State = iota
	StateIdle
	StateLocked
)

// AddMinute は1分ぶんを足す。
func (t *Tally) AddMinute(at time.Time, s State, exe, product, category string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	switch s {
	case StateActive:
		t.active++
	case StateIdle:
		t.idle++
	case StateLocked:
		t.locked++
	}

	if s == StateActive {
		if t.inNight(at) {
			t.night++
		}
		if isWeekend(at) {
			t.holiday++
		}
		if exe != "" {
			a := t.apps[exe]
			if a == nil {
				a = &appTally{product: product}
				t.apps[exe] = a
			}
			a.minutes++
		}
		if category != "" {
			t.web[category]++
		}
	}

	if t.firstAt.IsZero() || at.Before(t.firstAt) {
		t.firstAt = at
	}
	if at.After(t.lastAt) {
		t.lastAt = at
	}
}

func (t *Tally) inNight(at time.Time) bool {
	m := at.In(JST).Hour()*60 + at.In(JST).Minute()
	if t.nightFrom <= t.nightTo {
		return m >= t.nightFrom && m < t.nightTo
	}
	// 22:00〜05:00 のように日をまたぐ設定
	return m >= t.nightFrom || m < t.nightTo
}

func isWeekend(at time.Time) bool {
	d := at.In(JST).Weekday()
	return d == time.Saturday || d == time.Sunday
}

// Snapshot は送る形にして返す。上限を超える値は落とす。
func (t *Tally) Snapshot() (usage Usage, apps []App, web []Web) {
	t.mu.Lock()
	defer t.mu.Unlock()

	usage = Usage{
		WorkDate:   t.date,
		ActiveMin:  cap1440(t.active),
		IdleMin:    cap1440(t.idle),
		LockedMin:  cap1440(t.locked),
		NightMin:   cap1440(t.night),
		HolidayMin: cap1440(t.holiday),
	}
	if !t.firstAt.IsZero() {
		f, l := t.firstAt, t.lastAt
		usage.FirstAt, usage.LastAt = &f, &l
	}
	// アプリは多すぎても意味がない。長く使ったものから
	for exe, a := range t.apps {
		if a.minutes > 0 {
			apps = append(apps, App{WorkDate: t.date, ExeName: exe,
				Product: a.product, Minutes: cap1440(a.minutes)})
		}
	}
	for c, m := range t.web {
		if m > 0 {
			web = append(web, Web{WorkDate: t.date, Category: c, Minutes: cap1440(m)})
		}
	}
	return
}

func cap1440(n int) int {
	if n < 0 {
		return 0
	}
	if n > 1440 {
		return 1440
	}
	return n
}

// 送る形。api パッケージの型と同じ形にしてあるが、
// collect が api に依存しないように、こちらでも持つ
type Usage struct {
	WorkDate                                          string
	ActiveMin, IdleMin, LockedMin, NightMin, HolidayMin int
	FirstAt, LastAt                                   *time.Time
}

type App struct {
	WorkDate, ExeName, Product string
	Minutes                    int
}

type Web struct {
	WorkDate, Category string
	Minutes            int
}
