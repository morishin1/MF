//go:build windows

// eight-agent-host は、ブラウザの拡張と、常駐しているサービスのあいだを継ぐ。
//
// ■ なぜ間に1つ挟むのか
//
//	拡張からサーバへ直接つながせると、端末の鍵を拡張に持たせることになる。
//	拡張の中身はユーザーが読めるので、鍵は置けない。
//	拡張は「数えた結果」をここへ渡すだけにして、送るのはサービスがやる。
//
// ■ ブラウザが起こして、ブラウザが落とす
//
//	Native Messaging は、拡張が sendNativeMessage を呼ぶたびに
//	このプロセスを起こし、1往復して終わる。常駐はしない。
//
// ■ 形式
//
//	標準入力から「長さ4バイト（リトルエンディアン）＋ JSON」。
//	返すときも同じ形。1MBを超えるものは読まない（仕様の上限）。
//
// ■ ここを通るもの
//
//	ドメイン・ページの場所・時刻・秒数・ブラウザの名前だけ。
//	ページの中身やURLの全文を入れる場所は、この構造体に無い。
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"time"
)

const pipeName = `\\.\pipe\eight-agent`

// 仕様の上限。これより大きいものは読まない
const maxMessage = 1 << 20

// visit は拡張が数えた1回の滞在。
//
// この構造体に、ページの中身・題・URLの全文・入力した内容を入れる場所は無い。
type visit struct {
	Host      string `json:"host"`
	Path      string `json:"path,omitempty"`
	StartedAt string `json:"startedAt"`
	EndedAt   string `json:"endedAt,omitempty"`
	ActiveSec int    `json:"activeSec"`
	Browser   string `json:"browser,omitempty"`
}

type inbound struct {
	Kind    string  `json:"kind"`
	Browser string  `json:"browser"`
	Version string  `json:"version"`
	Visits  []visit `json:"visits,omitempty"`
}

// toService は名前付きパイプへ流す形。サービス側の読み手と合わせてある
type toService struct {
	From    string  `json:"from"`
	At      time.Time `json:"at"`
	Browser string  `json:"browser"`
	Version string  `json:"version"`
	Visits  []visit `json:"visits,omitempty"`
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("[eight-agent-host] ")
	// 標準出力は拡張との通信に使う。ログは標準エラーへ
	log.SetOutput(os.Stderr)

	msg, err := read(os.Stdin)
	if err != nil {
		if err != io.EOF {
			log.Printf("読めませんでした: %v", err)
		}
		return
	}

	var in inbound
	if err := json.Unmarshal(msg, &in); err != nil {
		reply(map[string]any{"ok": false, "error": "bad_json"})
		return
	}

	// 知らない種類は捨てる。拡張が新しくなっても、古いホストが勝手に解釈しない
	if in.Kind != "visits" && in.Kind != "alive" {
		reply(map[string]any{"ok": false, "error": "unknown_kind"})
		return
	}

	out := toService{
		From: "extension", At: time.Now().UTC(),
		Browser: clean(in.Browser, 20),
		Version: clean(in.Version, 20),
		Visits:  sane(in.Visits),
	}

	if err := toPipe(out); err != nil {
		// サービスが止まっているだけかもしれない。
		// 拡張に失敗を返すと、拡張が溜め直して次に送る
		log.Printf("サービスへ渡せませんでした: %v", err)
		reply(map[string]any{"ok": false, "error": "agent_unavailable"})
		return
	}
	reply(map[string]any{"ok": true, "accepted": len(out.Visits)})
}

// sane は、渡してよい形だけに削る。
//
// ここでも一度削る。拡張が新しくなったり、別のものが名乗って繋いできたときに、
// 通る中身が広がらないようにする
func sane(list []visit) []visit {
	if len(list) > 500 {
		list = list[len(list)-500:]
	}
	out := make([]visit, 0, len(list))
	for _, v := range list {
		if v.Host == "" || v.ActiveSec <= 0 {
			continue
		}
		out = append(out, visit{
			Host:      clean(v.Host, 120),
			Path:      clean(v.Path, 120),
			StartedAt: clean(v.StartedAt, 40),
			EndedAt:   clean(v.EndedAt, 40),
			ActiveSec: min(v.ActiveSec, 12*3600),
			Browser:   clean(v.Browser, 20),
		})
	}
	return out
}

func clean(s string, max int) string {
	b := make([]rune, 0, len(s))
	for _, r := range s {
		// 制御文字は落とす。ログやJSONを壊されないため
		if r < 0x20 || r == 0x7f {
			continue
		}
		b = append(b, r)
		if len(b) >= max {
			break
		}
	}
	return string(b)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ---- Native Messaging の読み書き --------------------------------------------

func read(r io.Reader) ([]byte, error) {
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, err
	}
	if n == 0 || n > maxMessage {
		return nil, fmt.Errorf("長さが不正です: %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func reply(v any) {
	buf, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = binary.Write(os.Stdout, binary.LittleEndian, uint32(len(buf)))
	_, _ = os.Stdout.Write(buf)
}

// ---- サービスへ渡す ---------------------------------------------------------

func toPipe(v toService) error {
	f, err := os.OpenFile(pipeName, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()

	buf, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = f.Write(append(buf, '\n'))
	return err
}
