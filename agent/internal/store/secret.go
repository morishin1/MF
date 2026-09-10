package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Identity は、この端末がサーバに対して名乗るもの。
//
// ■ 平文でディスクに置かない
//
//	Windows では DPAPI（マシンスコープ）で包んでから書く。
//	包む・ほどくは identity_windows.go にある。
//	Windows 以外では包めないので、開発中しか動かない。
//
// ■ 置き場所
//
//	%ProgramData%\EIGHT\ に置き、ACL は SYSTEM と Administrators だけ。
//	一般ユーザーが読めるところに置くと、端末になりすませる。
type Identity struct {
	DeviceID string `json:"deviceId"`
	Secret   string `json:"secret"`
	LastSeq  int64  `json:"lastSeq"`
}

var ErrNoIdentity = errors.New("この端末はまだ登録されていません")

func identityPath(dir string) string { return filepath.Join(dir, "identity.dat") }

// LoadIdentity は保存してあるものを読む。無ければ ErrNoIdentity。
func LoadIdentity(dir string) (*Identity, error) {
	raw, err := os.ReadFile(identityPath(dir))
	if os.IsNotExist(err) {
		return nil, ErrNoIdentity
	}
	if err != nil {
		return nil, err
	}
	plain, err := unprotect(raw)
	if err != nil {
		return nil, err
	}
	var id Identity
	if err := json.Unmarshal(plain, &id); err != nil {
		return nil, err
	}
	if id.DeviceID == "" || id.Secret == "" {
		return nil, ErrNoIdentity
	}
	return &id, nil
}

// SaveIdentity は包んでから書く。
//
// 先に書いてから返すこと。シークレットを取り替えたのに保存できていないと、
// その端末は次から入れなくなる。
func SaveIdentity(dir string, id *Identity) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	buf, err := json.Marshal(id)
	if err != nil {
		return err
	}
	sealed, err := protect(buf)
	if err != nil {
		return err
	}
	tmp := identityPath(dir) + ".tmp"
	if err := os.WriteFile(tmp, sealed, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, identityPath(dir))
}
