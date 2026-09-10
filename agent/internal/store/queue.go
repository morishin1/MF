// Package store は、送るまでのあいだ手元に置いておく箱。
//
// ■ 通信できなくても止まらない
//
//	外に出ているPC、社内LANに戻るまで繋がらないPCがある。
//	送れないあいだは、ここに溜まり続ける。
//
// ■ SQLite を使わない
//
//	cgo が要る（配布がややこしくなる）か、純Goの実装を足すことになる。
//	置くのは「送っていないできごと」だけで、多くても数千件。
//	1行1JSONの追記ファイルで足りる。
//
// ■ 溜めすぎない
//
//	上限を超えたら**古いほうから**捨てる。
//	新しいできごとのほうが、対応に要る。
package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Item は送っていないできごと1件。
type Item struct {
	Seq    int64             `json:"seq"`
	At     time.Time         `json:"at"`
	Kind   string            `json:"kind"`
	Detail map[string]string `json:"detail,omitempty"`
}

// Queue は追記ファイル。
type Queue struct {
	mu   sync.Mutex
	path string
	seq  int64
	max  int
}

// Open は箱を開く。無ければ作る。
//
// max は溜めておく上限。30日ぶんの目安として 20000 くらい。
func Open(dir string, max int) (*Queue, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	q := &Queue{path: filepath.Join(dir, "queue.jsonl"), max: max}
	items, err := q.readAll()
	if err != nil {
		return nil, err
	}
	// seq は端末の中で単調に増える。同じものが2回届いても、
	// サーバは (device_id, seq) の一意制約で1行にする
	for _, it := range items {
		if it.Seq > q.seq {
			q.seq = it.Seq
		}
	}
	return q, nil
}

// SeqFloor は、再インストール後に seq が巻き戻らないようにする。
// レジストリに残した最後の seq を渡す。
func (q *Queue) SeqFloor(n int64) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if n > q.seq {
		q.seq = n
	}
}

func (q *Queue) LastSeq() int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.seq
}

// Add はできごとを1件足す。
func (q *Queue) Add(kind string, at time.Time, detail map[string]string) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	q.seq++
	it := Item{Seq: q.seq, At: at.UTC(), Kind: kind, Detail: detail}

	f, err := os.OpenFile(q.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	buf, err := json.Marshal(it)
	if err != nil {
		return 0, err
	}
	if _, err := f.Write(append(buf, '\n')); err != nil {
		return 0, err
	}
	return it.Seq, nil
}

// Take は古いほうから n 件返す。まだ消さない。
// 送れたことを確かめてから Done を呼ぶ。
func (q *Queue) Take(n int) ([]Item, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	items, err := q.readAll()
	if err != nil {
		return nil, err
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Seq < items[j].Seq })
	if len(items) > n {
		items = items[:n]
	}
	return items, nil
}

// Done は seq がここまでのものを捨てる。
//
// 送れたことを確かめてから呼ぶ。先に消すと、通信が落ちたときに消えたままになる。
func (q *Queue) Done(upTo int64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.rewrite(func(it Item) bool { return it.Seq > upTo })
}

// Trim は上限を超えたぶんを、古いほうから捨てる。
func (q *Queue) Trim() (dropped int, err error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	items, err := q.readAll()
	if err != nil {
		return 0, err
	}
	if len(items) <= q.max {
		return 0, nil
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Seq < items[j].Seq })
	cut := items[len(items)-q.max].Seq
	dropped = len(items) - q.max
	return dropped, q.rewrite(func(it Item) bool { return it.Seq >= cut })
}

func (q *Queue) Len() (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	items, err := q.readAll()
	return len(items), err
}

func (q *Queue) readAll() ([]Item, error) {
	f, err := os.Open(q.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []Item
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var it Item
		// 壊れた行は飛ばす。1行のせいで全部読めなくなるほうが困る
		if err := json.Unmarshal(line, &it); err != nil {
			continue
		}
		out = append(out, it)
	}
	return out, sc.Err()
}

// rewrite は keep が true のものだけ残して書き直す。
// 書いてから差し替える。途中で電源が落ちても、元のファイルは壊れない
func (q *Queue) rewrite(keep func(Item) bool) error {
	items, err := q.readAll()
	if err != nil {
		return err
	}
	tmp := q.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	for _, it := range items {
		if !keep(it) {
			continue
		}
		buf, err := json.Marshal(it)
		if err != nil {
			continue
		}
		if _, err := w.Write(append(buf, '\n')); err != nil {
			f.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, q.path); err != nil {
		return fmt.Errorf("待ち行列を書き直せませんでした: %w", err)
	}
	return nil
}

// openAppend はテストから使う。追記で開く
func openAppend(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
}
