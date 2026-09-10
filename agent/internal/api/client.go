// Package api は mf.8grp.co.jp との通信をまとめる。
//
// ■ 社員のアカウントはこのPCに置かない
//
//	置くと、PCが盗まれた人が社員として全部できてしまう。
//	使うのは端末専用の資格情報で、できることは「自分のぶんを送る」だけ。
//
//	Authorization: Device <deviceId>:<secret>
//
// ■ 送るものは決まっている
//
//	キー入力・パスワード・メール本文・チャット本文・画面・
//	ウィンドウのタイトル・URLの全文は、この構造体に入れる場所が無い。
//	入れる場所を作らないことが、いちばん確実な歯止めになる。
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const userAgent = "EightAgent/1.0 (Windows)"

// Client はサーバとの1本の口。
type Client struct {
	BaseURL  string
	DeviceID string
	Secret   string
	HTTP     *http.Client
}

func New(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		// オフラインのPCで長く待たない。溜めて次に回すほうがよい
		HTTP: &http.Client{Timeout: 30 * time.Second},
	}
}

// ---- 送るもの ---------------------------------------------------------------

// Event は点の記録。detail に入れてよい鍵はサーバ側でも絞ってある。
type Event struct {
	Seq    int64             `json:"seq"`
	At     time.Time         `json:"at"`
	Kind   string            `json:"kind"`
	Detail map[string]string `json:"detail,omitempty"`
}

// Usage は日別の集計。生の秒単位はこのPCの中で捨てる。
type Usage struct {
	WorkDate   string     `json:"workDate"`
	ActiveMin  int        `json:"activeMin"`
	IdleMin    int        `json:"idleMin"`
	LockedMin  int        `json:"lockedMin"`
	NightMin   int        `json:"nightMin"`
	HolidayMin int        `json:"holidayMin"`
	FirstAt    *time.Time `json:"firstAt,omitempty"`
	LastAt     *time.Time `json:"lastAt,omitempty"`
}

// AppUsage は実行ファイル名だけ。パスは送らない（ユーザー名が入る）。
type AppUsage struct {
	WorkDate string `json:"workDate"`
	ExeName  string `json:"exeName"`
	Product  string `json:"product,omitempty"`
	Minutes  int    `json:"minutes"`
}

// WebUsage はカテゴリだけ。
//
// URL もホスト名も、ここには入らない。変換はこのPCの中で終わらせる。
// サーバに送ってから落とすと、送信経路とログに一度は全文が乗る。
type WebUsage struct {
	WorkDate string `json:"workDate"`
	Category string `json:"category"`
	Minutes  int    `json:"minutes"`
}

type IngestBody struct {
	SentAt       time.Time  `json:"sentAt"`
	AgentVersion string     `json:"agentVersion"`
	Hostname     string     `json:"hostname,omitempty"`
	Events       []Event    `json:"events,omitempty"`
	Usage        []Usage    `json:"usage,omitempty"`
	Apps         []AppUsage `json:"apps,omitempty"`
	Web          []WebUsage `json:"web,omitempty"`
}

// ---- 受け取るもの -----------------------------------------------------------

type EnrollResult struct {
	DeviceID string `json:"deviceId"`
	Secret   string `json:"secret"`
	Collect  bool   `json:"collect"`
	LinkURL  string `json:"linkUrl"`
}

// Config はサーバが配る設定。
//
// Collect が false のあいだ、エージェントは何も送らない。
// 本人が告知を読むまで収集しないという決まりを、ここで受け取る。
type Config struct {
	Collect         bool              `json:"collect"`
	Reason          string            `json:"reason"`
	Message         string            `json:"message"`
	SendIntervalSec int               `json:"sendIntervalSec"`
	IdleAfterMin    int               `json:"idleAfterMin"`
	NightFrom       string            `json:"nightFrom"`
	NightTo         string            `json:"nightTo"`
	SiteCategories  map[string]string `json:"siteCategories"`
	WatchInstalls   bool              `json:"watchInstalls"`
	WatchUsb        bool              `json:"watchUsb"`
	Never           []string          `json:"never"`
	RecheckSec      int               `json:"recheckSec"`
}

type IngestResult struct {
	Collect  bool `json:"collect"`
	Accepted struct {
		Events int `json:"events"`
		Usage  int `json:"usage"`
		Apps   int `json:"apps"`
		Web    int `json:"web"`
	} `json:"accepted"`
	Alerts int `json:"alerts"`
}

type Manifest struct {
	Update     bool   `json:"update"`
	Version    string `json:"version"`
	URL        string `json:"url"`
	SHA256     string `json:"sha256"`
	RecheckSec int    `json:"recheckSec"`
}

// ---- 呼び出し ---------------------------------------------------------------

// Enroll は登録コードを端末の資格情報に交換する。1回しか通らない。
func (c *Client) Enroll(ctx context.Context, token string, info map[string]string) (*EnrollResult, error) {
	body := map[string]any{"enrollToken": token}
	for k, v := range info {
		body[k] = v
	}
	var out EnrollResult
	if err := c.do(ctx, http.MethodPost, "/api/devices/enroll", body, &out, false); err != nil {
		return nil, err
	}
	if out.DeviceID == "" || out.Secret == "" {
		return nil, fmt.Errorf("登録の返事が足りません")
	}
	c.DeviceID, c.Secret = out.DeviceID, out.Secret
	return &out, nil
}

func (c *Client) Config(ctx context.Context) (*Config, error) {
	var out Config
	err := c.do(ctx, http.MethodGet, "/api/devices/config", nil, &out, true)
	return &out, err
}

func (c *Client) Ingest(ctx context.Context, b IngestBody) (*IngestResult, error) {
	var out IngestResult
	err := c.do(ctx, http.MethodPost, "/api/devices/ingest", b, &out, true)
	return &out, err
}

// Rotate はシークレットを取り替える。
//
// 返ってきた新しいほうを保存できなければ、この端末は入り直せなくなる。
// 呼ぶ側は、保存に成功してから古いほうを捨てること。
func (c *Client) Rotate(ctx context.Context) (string, error) {
	var out struct {
		Secret string `json:"secret"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/devices/rotate", map[string]any{}, &out, true); err != nil {
		return "", err
	}
	return out.Secret, nil
}

func (c *Client) Manifest(ctx context.Context) (*Manifest, error) {
	var out Manifest
	err := c.do(ctx, http.MethodGet, "/api/devices/manifest", nil, &out, true)
	return &out, err
}

// Unauthorized は、資格情報が通らなくなったことを表す。
// 管理者が端末を消したか、シークレットが入れ替わったか。人が再登録する。
type Unauthorized struct{ Status int }

func (e *Unauthorized) Error() string {
	return fmt.Sprintf("この端末の資格情報が通りませんでした (%d)", e.Status)
}

func (c *Client) do(ctx context.Context, method, path string, in, out any, auth bool) error {
	var body io.Reader
	if in != nil {
		buf, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth {
		if c.DeviceID == "" || c.Secret == "" {
			return fmt.Errorf("この端末はまだ登録されていません")
		}
		req.Header.Set("Authorization", "Device "+c.DeviceID+":"+c.Secret)
	}

	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	// 大きな返事は来ない。来たなら何かがおかしいので、そこで切る
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return &Unauthorized{Status: res.StatusCode}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("サーバが %d を返しました: %s", res.StatusCode, trim(string(raw), 200))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
