package store

import (
	"testing"
	"time"
)

func TestQueueKeepsUntilDone(t *testing.T) {
	// 送れたことを確かめてから捨てる。先に捨てると、
	// 通信が落ちたときに消えたままになる
	q, err := Open(t.TempDir(), 100)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := q.Add("lock", time.Now(), nil); err != nil {
			t.Fatal(err)
		}
	}
	items, err := q.Take(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 5 {
		t.Fatalf("取れたのは %d 件", len(items))
	}
	// まだ捨てていない
	if n, _ := q.Len(); n != 5 {
		t.Fatalf("Take で消えています: %d", n)
	}
	if err := q.Done(items[2].Seq); err != nil {
		t.Fatal(err)
	}
	if n, _ := q.Len(); n != 2 {
		t.Fatalf("Done のあとに残っているのは %d 件（2件のはず）", n)
	}
}

func TestQueueSeqIsMonotonic(t *testing.T) {
	// サーバは (device_id, seq) の一意制約で重複を落とす。
	// 巻き戻ると、別のできごとが同じ番号になって消える
	dir := t.TempDir()
	q, _ := Open(dir, 100)
	var last int64
	for i := 0; i < 20; i++ {
		s, _ := q.Add("lock", time.Now(), nil)
		if s <= last {
			t.Fatalf("番号が増えていません: %d のあとに %d", last, s)
		}
		last = s
	}
	// 開き直しても続きから
	q2, _ := Open(dir, 100)
	s, _ := q2.Add("lock", time.Now(), nil)
	if s != last+1 {
		t.Fatalf("開き直したら巻き戻りました: %d のあとに %d", last, s)
	}
}

func TestQueueSeqFloorSurvivesReinstall(t *testing.T) {
	// 入れ直すと待ち行列は空になる。
	// レジストリに残した最後の番号から続けないと、番号がぶつかる
	q, _ := Open(t.TempDir(), 100)
	q.SeqFloor(5000)
	s, _ := q.Add("boot", time.Now(), nil)
	if s != 5001 {
		t.Fatalf("SeqFloor が効いていません: %d", s)
	}
}

func TestQueueDropsOldestWhenFull(t *testing.T) {
	// 溜めすぎない。超えたら古いほうから捨てる。
	// 新しいできごとのほうが、対応に要る
	q, _ := Open(t.TempDir(), 10)
	for i := 0; i < 25; i++ {
		q.Add("lock", time.Now(), nil)
	}
	dropped, err := q.Trim()
	if err != nil {
		t.Fatal(err)
	}
	if dropped != 15 {
		t.Fatalf("捨てたのは %d 件（15件のはず）", dropped)
	}
	items, _ := q.Take(100)
	if len(items) != 10 {
		t.Fatalf("残ったのは %d 件", len(items))
	}
	// 残ったのは新しいほう
	if items[0].Seq != 16 {
		t.Fatalf("古いほうから捨てていません。先頭が %d", items[0].Seq)
	}
}

func TestQueueSurvivesBrokenLine(t *testing.T) {
	// 電源が落ちて途中まで書けた行があっても、
	// 1行のせいで全部読めなくなるほうが困る
	dir := t.TempDir()
	q, _ := Open(dir, 100)
	q.Add("boot", time.Now(), nil)

	f, err := openAppend(q.path)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString("{壊れた行\n")
	f.Close()

	q2, err := Open(dir, 100)
	if err != nil {
		t.Fatalf("壊れた行で開けなくなりました: %v", err)
	}
	items, err := q2.Take(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("読めたのは %d 件（1件のはず）", len(items))
	}
}

func TestQueueRoundTripsDetail(t *testing.T) {
	q, _ := Open(t.TempDir(), 100)
	q.Add("usb_attach", time.Now(), map[string]string{
		"class": "mass_storage", "vid": "SanDisk", "pid": "Cruzer",
	})
	items, _ := q.Take(10)
	if items[0].Detail["class"] != "mass_storage" || items[0].Detail["vid"] != "SanDisk" {
		t.Fatalf("detail が壊れています: %+v", items[0].Detail)
	}
}
