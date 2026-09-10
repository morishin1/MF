package collect

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/8grp/eight-agent/internal/api"
	"github.com/8grp/eight-agent/internal/store"
)

// Agent は集めたものを溜めて、決まった間隔で送る。
//
// ■ 本人が承認するまで動かない
//
//	サーバの config が collect:false を返しているあいだ、
//	Tally には何も足さないし、待ち行列にも入れない。
//	止めているのはサーバ側の判断で、ここはそれに従うだけ。
//	この分岐を「とりあえず溜めておいて後で送る」に変えないこと。
//	それをやると、承認前のデータが端末に残る。
//
// ■ 送れなくても止まらない
//
//	送信に失敗したら待ち行列に残す。次の周期でまた出す。
type Agent struct {
	Client  *api.Client
	Queue   *store.Queue
	Version string
	Host    string
	Dir     string

	mu     sync.Mutex
	cfg    *api.Config
	cat    *Categorizer
	tally  *Tally
	onFlag func(bool) // 収集の可否が変わったときに知らせる（トレイの表示用）
}

func NewAgent(c *api.Client, q *store.Queue, version, host, dir string) *Agent {
	return &Agent{Client: c, Queue: q, Version: version, Host: host, Dir: dir}
}

func (a *Agent) OnCollectChange(f func(bool)) { a.onFlag = f }

// Collecting は、いま集めてよいか。
func (a *Agent) Collecting() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg != nil && a.cfg.Collect
}

func (a *Agent) Config() *api.Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

// Categorizer は、いまの表。まだ設定を受け取っていなければ nil。
func (a *Agent) Categorizer() *Categorizer {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cat
}

// RefreshConfig はサーバから設定を取り直す。
func (a *Agent) RefreshConfig(ctx context.Context) error {
	cfg, err := a.Client.Config(ctx)
	if err != nil {
		return err
	}
	a.mu.Lock()
	was := a.cfg != nil && a.cfg.Collect
	a.cfg = cfg
	a.cat = NewCategorizer(cfg.SiteCategories)
	if a.tally == nil || a.tally.Date() != WorkDate(time.Now()) {
		a.tally = NewTally(WorkDate(time.Now()), hhmm(cfg.NightFrom, 22*60), hhmm(cfg.NightTo, 5*60))
	}
	now := cfg.Collect
	a.mu.Unlock()

	if was != now && a.onFlag != nil {
		a.onFlag(now)
	}
	if !cfg.Collect {
		log.Printf("収集していません: %s（%s）", cfg.Message, cfg.Reason)
	}
	return nil
}

// Note はできごとを1件記録する。承認前は何もしない。
func (a *Agent) Note(kind string, at time.Time, detail map[string]string) {
	if !a.Collecting() {
		return
	}
	if _, err := a.Queue.Add(kind, at, detail); err != nil {
		log.Printf("できごとを置けませんでした: %v", err)
	}
}

// Minute は1分ぶんの状態を足す。承認前は何もしない。
func (a *Agent) Minute(at time.Time, s State, exe, product, category string) {
	if !a.Collecting() {
		return
	}
	a.mu.Lock()
	if a.tally == nil || a.tally.Date() != WorkDate(at) {
		cfg := a.cfg
		a.tally = NewTally(WorkDate(at), hhmm(cfg.NightFrom, 22*60), hhmm(cfg.NightTo, 5*60))
	}
	t := a.tally
	a.mu.Unlock()

	t.AddMinute(at, s, exe, product, category)
}

// Flush は溜まっているぶんを送る。
//
// 1回のPOSTは500件まで。オフラインで何日ぶんも溜まっていても、
// 一度に全部は送らない（サーバ側でも500件で切っている）。
func (a *Agent) Flush(ctx context.Context) error {
	if !a.Collecting() {
		return nil
	}

	items, err := a.Queue.Take(500)
	if err != nil {
		return err
	}

	a.mu.Lock()
	t := a.tally
	a.mu.Unlock()

	body := api.IngestBody{
		SentAt:       time.Now().UTC(),
		AgentVersion: a.Version,
		Hostname:     a.Host,
	}
	for _, it := range items {
		body.Events = append(body.Events, api.Event{
			Seq: it.Seq, At: it.At, Kind: it.Kind, Detail: it.Detail,
		})
	}
	if t != nil {
		u, apps, web := t.Snapshot()
		body.Usage = []api.Usage{{
			WorkDate: u.WorkDate, ActiveMin: u.ActiveMin, IdleMin: u.IdleMin,
			LockedMin: u.LockedMin, NightMin: u.NightMin, HolidayMin: u.HolidayMin,
			FirstAt: u.FirstAt, LastAt: u.LastAt,
		}}
		for _, x := range apps {
			body.Apps = append(body.Apps, api.AppUsage{
				WorkDate: x.WorkDate, ExeName: x.ExeName, Product: x.Product, Minutes: x.Minutes,
			})
		}
		for _, x := range web {
			body.Web = append(body.Web, api.WebUsage{
				WorkDate: x.WorkDate, Category: x.Category, Minutes: x.Minutes,
			})
		}
	}
	if len(body.Events) == 0 && len(body.Usage) == 0 {
		return nil
	}

	res, err := a.Client.Ingest(ctx, body)
	if err != nil {
		// 送れなかった。待ち行列はそのまま。次の周期でまた出す
		return err
	}

	// サーバが「もう集めるな」と言ったら、そこで止める
	if !res.Collect {
		a.mu.Lock()
		if a.cfg != nil {
			a.cfg.Collect = false
		}
		a.mu.Unlock()
		if a.onFlag != nil {
			a.onFlag(false)
		}
	}

	// 送れたぶんだけ捨てる。先に捨てない
	if len(items) > 0 {
		last := items[len(items)-1].Seq
		if err := a.Queue.Done(last); err != nil {
			log.Printf("送信済みを片付けられませんでした: %v", err)
		}
		if err := store.SaveIdentity(a.Dir, &store.Identity{
			DeviceID: a.Client.DeviceID, Secret: a.Client.Secret, LastSeq: last,
		}); err != nil {
			log.Printf("最後の番号を保存できませんでした: %v", err)
		}
	}
	// 溜まりすぎていたら、古いほうから捨てる
	if n, err := a.Queue.Trim(); err == nil && n > 0 {
		log.Printf("古いできごとを %d 件捨てました（溜めすぎないため）", n)
	}
	return nil
}

// Rotate はシークレットを取り替える。90日ごと。
//
// 新しいほうを**保存できてから**使う。保存に失敗したら古いほうを使い続ける。
// 逆にすると、保存に失敗した端末は次から入れなくなる。
func (a *Agent) Rotate(ctx context.Context) error {
	next, err := a.Client.Rotate(ctx)
	if err != nil {
		return err
	}
	if err := store.SaveIdentity(a.Dir, &store.Identity{
		DeviceID: a.Client.DeviceID, Secret: next, LastSeq: a.Queue.LastSeq(),
	}); err != nil {
		// 保存できなかった。サーバ側はもう新しいほうになっているので、
		// ここは人が再登録するしかない。分かるように送っておく
		a.Note("agent_error", time.Now(), map[string]string{
			"message": "新しいシークレットを保存できませんでした。再登録が要ります",
		})
		return err
	}
	a.Client.Secret = next
	return nil
}

func hhmm(s string, fallback int) int {
	if len(s) < 4 {
		return fallback
	}
	var h, m int
	if _, err := timeParse(s, &h, &m); err != nil {
		return fallback
	}
	return h*60 + m
}

func timeParse(s string, h, m *int) (int, error) {
	t, err := time.Parse("15:04", s[:5])
	if err != nil {
		// "22:00:00" のように秒まで来ることがある
		t, err = time.Parse("15:04:05", s)
		if err != nil {
			return 0, err
		}
	}
	*h, *m = t.Hour(), t.Minute()
	return 2, nil
}
