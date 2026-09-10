//go:build windows

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/8grp/eight-agent/internal/collect"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const regPath = `SOFTWARE\EIGHT\Agent`

func dataDir() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "EIGHT")
}

// deviceUID はこのPCの印。レジストリに残すので、
// エージェントを入れ直しても変わらない。
// 変わると、台帳に同じPCが2つ並ぶ。
func deviceUID(dir string) string {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, regPath, registry.ALL_ACCESS)
	if err == nil {
		defer k.Close()
		if v, _, err := k.GetStringValue("DeviceUid"); err == nil && v != "" {
			return v
		}
		uid := randomUID()
		if err := k.SetStringValue("DeviceUid", uid); err == nil {
			return uid
		}
	}
	// レジストリに書けないときはファイルに置く
	p := filepath.Join(dir, "device_uid")
	if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
		return strings.TrimSpace(string(b))
	}
	uid := randomUID()
	os.MkdirAll(dir, 0o700)
	os.WriteFile(p, []byte(uid), 0o600)
	return uid
}

func randomUID() string {
	b := make([]byte, 18)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hostname() string { return collect.Hostname() }

func osVersion() (string, string) { return collect.OSVersion() }

// machineSerial は BIOS のシリアル。取れなければ空。
// 貸与品台帳と突き合わせるときに使う
func machineSerial() string {
	out, err := exec.Command("cmd", "/c",
		"wmic bios get serialnumber /value").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "SerialNumber="); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func bootTime() (time.Time, bool) { return collect.BootEvent() }

func openBrowser(url string) error {
	// rundll32 経由。既定のブラウザで開く
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

// ---- UI プロセスからの報せ ---------------------------------------------------

// UIプロセスは1分ごとに1行 JSON を投げてくる。
// サービスからは前面のウィンドウが取れないので、ここだけは向こうに頼る。
//
// パイプの ACL は SYSTEM と Users。別のPCからは繋がらない（ローカル専用）。
type uiReport struct {
	At       time.Time `json:"at"`
	State    string    `json:"state"` // active / idle / locked
	Exe      string    `json:"exe"`
	Product  string    `json:"product"`
	Category string    `json:"category"`
}

const pipeName = `\\.\pipe\eight-agent`

func serveUIPipe(ctx context.Context, ag *collect.Agent) {
	for {
		if ctx.Err() != nil {
			return
		}
		if err := acceptOne(ctx, ag); err != nil {
			log.Printf("UIプロセスとの口でエラー: %v", err)
			time.Sleep(5 * time.Second)
		}
	}
}

func acceptOne(ctx context.Context, ag *collect.Agent) error {
	// 名前付きパイプは golang.org/x/sys/windows では直接扱えないので、
	// ファイルとして開く。UI 側が繋いでくるのを待つ
	f, err := os.OpenFile(pipeName, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		var r uiReport
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			continue
		}
		st := collect.StateIdle
		switch r.State {
		case "active":
			st = collect.StateActive
		case "locked":
			st = collect.StateLocked
		}
		// ここに来るのは実行ファイル名とカテゴリだけ。
		// ウィンドウのタイトルもURLも、UI側が送ってこない作りにしてある
		ag.Minute(r.At, st, collect.ExeName(r.Exe), r.Product, r.Category)
	}
	return sc.Err()
}

// ---- OS からの報せ -----------------------------------------------------------

// watchSystem は、サービスから取れるものを見る。
//   - インストールされたソフトの増減（レジストリの Uninstall キー）
//   - USB の抜き差し
//
// セッション通知（ロック・ログオン）は、サービス本体の
// ハンドラから ag.Note を呼ぶ。ここでは扱わない。
func watchSystem(ctx context.Context, ag *collect.Agent) {
	known := snapshotInstalled()
	usbKnown := snapshotUSB()

	t := time.NewTicker(2 * time.Minute)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if !ag.Collecting() {
				continue
			}
			now := snapshotInstalled()
			for name, ver := range now {
				if _, ok := known[name]; !ok {
					ag.Note("app_install", time.Now(), map[string]string{"name": name, "version": ver})
				}
			}
			for name := range known {
				if _, ok := now[name]; !ok {
					ag.Note("app_uninstall", time.Now(), map[string]string{"name": name})
				}
			}
			known = now

			cur := snapshotUSB()
			for id, d := range cur {
				if _, ok := usbKnown[id]; !ok {
					ag.Note("usb_attach", time.Now(), d)
				}
			}
			for id, d := range usbKnown {
				if _, ok := cur[id]; !ok {
					ag.Note("usb_detach", time.Now(), d)
				}
			}
			usbKnown = cur
		}
	}
}

// snapshotInstalled は「プログラムと機能」に出るものを見る。
// 名前とバージョンだけ。インストール先のパスは取らない
func snapshotInstalled() map[string]string {
	out := map[string]string{}
	roots := []struct {
		key  registry.Key
		path string
	}{
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
		{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`},
	}
	for _, r := range roots {
		k, err := registry.OpenKey(r.key, r.path, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		names, err := k.ReadSubKeyNames(-1)
		k.Close()
		if err != nil {
			continue
		}
		for _, n := range names {
			sub, err := registry.OpenKey(r.key, r.path+`\`+n, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			disp, _, _ := sub.GetStringValue("DisplayName")
			ver, _, _ := sub.GetStringValue("DisplayVersion")
			sub.Close()
			if disp != "" {
				out[disp] = ver
			}
		}
	}
	return out
}

// snapshotUSB はつながっている USB 機器を見る。
//
// class に mass_storage が入ったものだけがアラートになる（判定はサーバ側）。
// マウスやキーボードも見えるが、それでアラートは出さない。
// 中に入っているファイルは見ない。見る道具も持たない
func snapshotUSB() map[string]map[string]string {
	out := map[string]map[string]string{}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Enum\USBSTOR`,
		registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return out
	}
	defer k.Close()
	names, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return out
	}
	for _, n := range names {
		vid, pid := parseUSBName(n)
		out[n] = map[string]string{"class": "mass_storage", "vid": vid, "pid": pid, "label": n}
	}
	return out
}

// "Disk&Ven_SanDisk&Prod_Cruzer&Rev_1.00" のような形から、
// ベンダと製品を取り出す
func parseUSBName(s string) (vid, pid string) {
	for _, part := range strings.Split(s, "&") {
		if v, ok := strings.CutPrefix(part, "Ven_"); ok {
			vid = v
		}
		if v, ok := strings.CutPrefix(part, "Prod_"); ok {
			pid = v
		}
	}
	return
}

// ---- 自動更新 ---------------------------------------------------------------

// checkUpdate は新しい版があるか見る。
//
// ■ 署名の検証は省かない
//
//	更新の口は、そのまま「全PCで任意のコードを動かせる口」になる。
//	SHA256 が合わない、または会社の証明書で署名されていないものは捨てる。
//	ここを緩めるくらいなら、自動更新をやめて手で配るほうがまだよい。
func checkUpdate(ctx context.Context, ag *collect.Agent) {
	m, err := ag.Client.Manifest(ctx)
	if err != nil || m == nil || !m.Update {
		return
	}
	if m.Version == "" || m.URL == "" || m.SHA256 == "" {
		// 3つそろっていない版は配らない（サーバ側でもそう作ってある）
		return
	}
	log.Printf("新しい版 %s があります。%s", m.Version, m.URL)
	// 実際の入れ替えはインストーラ（別）に任せる。
	// サービス自身が自分を書き換えると、失敗したときに戻せない
	ag.Note("agent_update", time.Now(), map[string]string{
		"version": m.Version, "message": "新しい版があります",
	})
}

var _ = windows.ComputerName
