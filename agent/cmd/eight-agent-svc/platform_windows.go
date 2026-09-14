//go:build windows

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/8grp/eight-agent/internal/collect"
	"github.com/8grp/eight-agent/internal/release"
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
	// ブラウザの拡張が1回にまとめて渡してくることがある。既定の64KBでは足りない
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for sc.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		// 口は1つだが、繋いでくるのは2種類。
		//   ・同じPCの UI プロセス（いま使っているソフト・離席）
		//   ・ブラウザの拡張（継ぎ役ごし。見ていたサイト）
		// from で見分ける。付いていなければ、これまでどおり UI として読む
		var head struct {
			From string `json:"from"`
		}
		if err := json.Unmarshal(sc.Bytes(), &head); err == nil && head.From == "extension" {
			fromExtension(ag, sc.Bytes())
			continue
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
		// 触っているかどうかは、自分の重さを見るときにも使う。
		// 待機しているだけで重いのが、いちばん困る
		markActive(st == collect.StateActive)
		// ここに来るのは実行ファイル名とカテゴリだけ。
		// ウィンドウのタイトルもURLも、UI側が送ってこない作りにしてある
		ag.Minute(r.At, st, collect.ExeName(r.Exe), r.Product, r.Category)
	}
	return sc.Err()
}

// fromExtension は、ブラウザの拡張が数えた滞在を受け取る。
//
// 継ぎ役（eight-agent-host.exe）も一度削っているが、ここでも削る。
// 口が1つでも、通る中身は2か所で絞る。片方が緩んでも、もう片方で止まる。
//
// ここに来るのは ドメイン・ページの場所・時刻・秒数・ブラウザ名 だけ。
// ページの中身や題を入れる場所が、そもそも構造体に無い
func fromExtension(ag *collect.Agent, line []byte) {
	var in struct {
		Browser string `json:"browser"`
		Version string `json:"version"`
		Visits  []struct {
			Host      string    `json:"host"`
			Path      string    `json:"path"`
			StartedAt time.Time `json:"startedAt"`
			EndedAt   time.Time `json:"endedAt"`
			ActiveSec int       `json:"activeSec"`
			Browser   string    `json:"browser"`
		} `json:"visits"`
	}
	if err := json.Unmarshal(line, &in); err != nil {
		return
	}

	// 届いた＝そのブラウザは繋がっている。管理画面の「●連携済」はこれ
	ag.BrowserAlive(in.Browser, in.Version)

	for _, v := range in.Visits {
		host := collect.HostOnly(v.Host)
		if host == "" || v.ActiveSec <= 0 {
			continue
		}
		ag.Visit(collect.Visit{
			Host:      host,
			Path:      collect.PathOnly(v.Path),
			StartedAt: v.StartedAt,
			EndedAt:   v.EndedAt,
			ActiveSec: v.ActiveSec,
			Browser:   v.Browser,
		})
	}
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

// checkUpdate は新しい版があるか見て、確かめられたものだけ入れ替える。
//
// ■ 「落としたEXEをそのまま実行する」ことは、しない
//
//	更新の口は、そのまま「全PCで任意のコードを動かせる口」になる。
//	商用のコード署名証明書は買わない方針なので、Windows は確かめてくれない。
//	そのぶん、ここで2つ確かめる。
//
//	  1. サーバの言い分（版・URL・ハッシュ・大きさ）が、
//	     焼き込んだ公開鍵の署名と合うか。合わなければ URL を開きにすらいかない
//	  2. 落ちてきた中身の SHA-256 が、署名された値と合うか
//
//	どちらか一方でも合わなければ、**実行しない**。ファイルは消す。
//	公開鍵が焼き込まれていなければ、更新そのものをしない。
func checkUpdate(ctx context.Context, ag *collect.Agent) {
	m, err := ag.Client.Manifest(ctx)
	if err != nil || m == nil || !m.Update {
		return
	}
	in := release.Info{
		Version:   m.Version,
		URL:       m.URL,
		Locator:   m.Locator,
		SHA256:    m.SHA256,
		SizeBytes: m.SizeBytes,
		Signature: m.Signature,
		KeyID:     m.KeyID,
	}

	// ---- 1. 言い分を確かめる（ここを通らなければ落としにいかない）----
	if err := release.Verify(UpdateKey, in); err != nil {
		log.Printf("更新しません（確かめられませんでした）: %v", err)
		ag.Note("agent_update_refused", time.Now(), map[string]string{
			"version": m.Version, "reason": err.Error(),
		})
		return
	}

	log.Printf("新しい版 %s があります。%s", m.Version, m.URL)

	// ---- 2. 落として、中身を確かめる ----
	path, err := fetchUpdate(ctx, in)
	if err != nil {
		log.Printf("更新しません: %v", err)
		ag.Note("agent_update_refused", time.Now(), map[string]string{
			"version": m.Version, "reason": err.Error(),
		})
		return
	}

	// ---- 3. 入れ替えはインストーラに任せる ----
	//
	// サービスが自分自身を書き換えると、失敗したときに戻せない。
	// -update はセットアップと違い、登録も同意もやり直さない
	ag.Note("agent_update", time.Now(), map[string]string{
		"version": m.Version, "message": "新しい版に入れ替えます",
	})
	if err := exec.Command(path, "-update").Start(); err != nil {
		log.Printf("入れ替えを始められませんでした: %v", err)
		_ = os.Remove(path)
		return
	}
	log.Printf("入れ替えを始めました（%s）", m.Version)
}

// fetchUpdate は更新ファイルを落として、署名された中身と同じかを確かめる。
//
// 合わなければ消して、パスを返さない。
// 「とりあえず置いておいて、あとで確かめる」はしない
func fetchUpdate(ctx context.Context, in release.Info) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, in.URL, nil)
	if err != nil {
		return "", err
	}
	cl := &http.Client{Timeout: 10 * time.Minute}
	res, err := cl.Do(req)
	if err != nil {
		return "", fmt.Errorf("落とせませんでした: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("落とせませんでした: HTTP %d", res.StatusCode)
	}

	// 大きさとハッシュを、ここで確かめる。
	// 言われた大きさを超えたらその時点で止まる（読み続けない）
	body, err := release.CheckBytes(res.Body, in)
	if err != nil {
		return "", err
	}

	dir := filepath.Join(dataDir(), "update")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	// 前の版の置き土産を消す。20MB のものが何本も残ると、
	// 台数ぶんの無駄なディスクになる
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	// 版ごとに名前を分ける。前回の落としかけが残っていても混ざらない
	path := filepath.Join(dir, "EIGHT-Agent-Setup-"+safeName(in.Version)+".exe")
	// 0700 … SYSTEM だけ。ここに書けるのが増えると、
	// そのまま「全PCで何か動かせる場所」になる
	if err := os.WriteFile(path, body, 0o700); err != nil {
		return "", err
	}
	return path, nil
}

// safeName は、版の文字列をファイル名に使える形にする。
// サーバから来た文字列をそのままパスに混ぜない
func safeName(v string) string {
	var b strings.Builder
	for _, r := range v {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z',
			r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	s := b.String()
	if len(s) > 40 {
		s = s[:40]
	}
	if s == "" {
		s = "new"
	}
	return s
}

var _ = windows.ComputerName
