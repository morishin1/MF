package collect

import (
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse("2006-01-02 15:04", s)
	if err != nil {
		panic(err)
	}
	// 日本時間として読む
	return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), 0, 0, JST)
}

func TestTallyCountsMinutes(t *testing.T) {
	ta := NewTally("2026-09-09", 22*60, 5*60)
	for i := 0; i < 10; i++ {
		ta.AddMinute(at("2026-09-09 10:00").Add(time.Duration(i)*time.Minute),
			StateActive, "excel.exe", "Microsoft Excel", "work")
	}
	for i := 0; i < 3; i++ {
		ta.AddMinute(at("2026-09-09 10:10").Add(time.Duration(i)*time.Minute), StateIdle, "", "", "")
	}
	ta.AddMinute(at("2026-09-09 10:20"), StateLocked, "", "", "")

	u, apps, web := ta.Snapshot()
	if u.ActiveMin != 10 || u.IdleMin != 3 || u.LockedMin != 1 {
		t.Fatalf("分の数え方がちがいます: %+v", u)
	}
	if len(apps) != 1 || apps[0].ExeName != "excel.exe" || apps[0].Minutes != 10 {
		t.Fatalf("アプリの集計がちがいます: %+v", apps)
	}
	if len(web) != 1 || web[0].Category != "work" || web[0].Minutes != 10 {
		t.Fatalf("サイトの集計がちがいます: %+v", web)
	}
	if u.FirstAt == nil || u.LastAt == nil {
		t.Fatal("最初と最後が入っていません")
	}
}

func TestTallyOnlyCountsAppsWhileActive(t *testing.T) {
	// 離席中・ロック中に前面のアプリを数えると、
	// 席を外しているあいだも「Excel を使っていた」ことになる
	ta := NewTally("2026-09-09", 22*60, 5*60)
	ta.AddMinute(at("2026-09-09 10:00"), StateIdle, "excel.exe", "", "work")
	ta.AddMinute(at("2026-09-09 10:01"), StateLocked, "excel.exe", "", "work")

	_, apps, web := ta.Snapshot()
	if len(apps) != 0 {
		t.Fatalf("離席中のアプリを数えています: %+v", apps)
	}
	if len(web) != 0 {
		t.Fatalf("離席中のサイトを数えています: %+v", web)
	}
}

func TestTallyNightAndHoliday(t *testing.T) {
	ta := NewTally("2026-09-09", 22*60, 5*60)
	ta.AddMinute(at("2026-09-09 23:30"), StateActive, "chrome.exe", "", "")
	ta.AddMinute(at("2026-09-09 14:00"), StateActive, "chrome.exe", "", "")
	u, _, _ := ta.Snapshot()
	if u.NightMin != 1 {
		t.Fatalf("深夜のぶんがちがいます: %d", u.NightMin)
	}
	if u.HolidayMin != 0 {
		t.Fatalf("水曜は休日ではありません: %d", u.HolidayMin)
	}

	// 2026-09-12 は土曜
	sat := NewTally("2026-09-12", 22*60, 5*60)
	sat.AddMinute(at("2026-09-12 14:00"), StateActive, "chrome.exe", "", "")
	u2, _, _ := sat.Snapshot()
	if u2.HolidayMin != 1 {
		t.Fatalf("土曜のぶんがちがいます: %d", u2.HolidayMin)
	}
}

func TestTallyNightWrapsMidnight(t *testing.T) {
	// 22:00〜05:00 は日をまたぐ
	ta := NewTally("2026-09-09", 22*60, 5*60)
	for _, s := range []string{"2026-09-09 22:00", "2026-09-09 23:59", "2026-09-09 03:00"} {
		ta.AddMinute(at(s), StateActive, "", "", "")
	}
	ta.AddMinute(at("2026-09-09 05:00"), StateActive, "", "", "")
	ta.AddMinute(at("2026-09-09 12:00"), StateActive, "", "", "")

	u, _, _ := ta.Snapshot()
	if u.NightMin != 3 {
		t.Fatalf("日をまたぐ深夜の数え方がちがいます: %d（22:00, 23:59, 03:00 の3分のはず）", u.NightMin)
	}
}

func TestTallyCapsAtOneDay(t *testing.T) {
	ta := NewTally("2026-09-09", 22*60, 5*60)
	for i := 0; i < 2000; i++ {
		ta.AddMinute(at("2026-09-09 00:00").Add(time.Duration(i)*time.Minute), StateActive, "", "", "")
	}
	u, _, _ := ta.Snapshot()
	if u.ActiveMin > 1440 {
		t.Fatalf("1日は1440分。%d は壊れています", u.ActiveMin)
	}
}

func TestWorkDateUsesJST(t *testing.T) {
	// UTC の夕方は、日本ではもう翌日
	utc := time.Date(2026, 9, 9, 15, 30, 0, 0, time.UTC)
	if got := WorkDate(utc); got != "2026-09-10" {
		t.Fatalf("日本時間で切っていません: %s", got)
	}
}
