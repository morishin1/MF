//go:build windows

package main

import (
	"context"
	"fmt"
	"log"
	"sync/atomic"
	"time"

	"github.com/8grp/eight-agent/internal/collect"
	"github.com/8grp/eight-agent/internal/selfload"
)

// 計る間隔。これ自体は軽い（3つのプロセスの時間とメモリを読むだけ）。
// 目安を越えているかどうかは、5回続いてから決める（selfload.Sustain）
const loadEvery = 60 * time.Second

// 送る間隔を延ばすときの上限。
// 延ばしすぎると記録が粗くなりすぎる
const sendMax = 30 * time.Minute

// 誰か触っているか。UI から1分ごとに届く報せで書き換える。
//
// 待機時と通常時で、許せる重さが違う。
// 「誰も触っていないのに重い」がいちばん困るので、そこを厳しく見る
var lastActive atomic.Int64

func markActive(active bool) {
	if active {
		lastActive.Store(time.Now().Unix())
	}
}

// isIdle は、しばらく誰も触っていないか。
// 報せが来ていない（UI が動いていない）ときも、触っていない扱いにする
func isIdle() bool {
	at := lastActive.Load()
	if at == 0 {
		return true
	}
	return time.Since(time.Unix(at, 0)) > 3*time.Minute
}

// loadWatch は、自分の重さを見て、重ければ粗くする。
//
// ■ 重いときにやること
//
//  1. 自分で軽くする … 送る間隔・見にいく間隔を延ばす
//
//  2. 管理画面に出す … 「Agent負荷異常」として知らせる
//
//     黙って軽くすると、何が起きているのか誰も分からない。
//     知らせるだけだと、重いまま動き続ける。両方やる
type loadWatch struct {
	ag *collect.Agent
	w  *selfload.Watcher
	s  *selfload.Sampler

	// level は、ほかの goroutine（送る側・見にいく側）からも読む
	level atomic.Int32
}

func newLoadWatch(ag *collect.Agent) *loadWatch {
	return &loadWatch{
		ag: ag,
		w:  selfload.New(selfload.DefaultLimits()),
		s:  selfload.NewSampler(),
	}
}

// Level は、いまの重さ。送る間隔を決めるときに読む
func (l *loadWatch) Level() selfload.Level {
	return selfload.Level(l.level.Load())
}

func (l *loadWatch) run(ctx context.Context) {
	t := time.NewTicker(loadEvery)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			l.once()
		}
	}
}

func (l *loadWatch) once() {
	// 誰も触っていないときのほうが、目安は厳しい。
	// 待機しているだけで重いのは、いちばん困る
	s, ok := l.s.Sample(isIdle())
	if !ok {
		return // 1回目は差が取れない
	}

	c := l.w.Add(s)
	if !c.Changed {
		return
	}
	l.level.Store(int32(c.Level))

	if c.Level == selfload.OK {
		log.Printf("負荷が戻りました")
		// 戻ったことも残す。管理画面のアラートを閉じてよい材料になる
		l.ag.Note("agent_load_ok", time.Now(), nil)
		return
	}

	log.Printf("負荷が高い状態が続いています（%s）: %s", c.Level, c.Reason)

	// 取るものは変えない。見にいく間隔が延びるだけ。
	// 「重いから記録をやめる」はしない
	l.ag.Note("agent_load_high", time.Now(), map[string]string{
		"label": c.Level.String(),
		"message": fmt.Sprintf("%s（CPU %.1f%% / メモリ %dMB）",
			c.Reason, c.Worst.CPUPercent, c.Worst.MemoryBytes>>20),
	})
}
