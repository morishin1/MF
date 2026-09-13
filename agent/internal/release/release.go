// Package release は、更新ファイルが「うちが作ったもの」かを確かめる。
//
// ■ なぜ自前でやるのか
//
//	商用のコード署名証明書は使わない（費用をかけない方針）。
//	そうすると Windows は、落としたEXEを誰が作ったか確かめてくれない。
//
//	だからといって「落としたEXEをそのまま実行する」自動更新にはできない。
//	配布先のURLが乗っ取られたら、全台で任意のプログラムが動く。
//	証明書が無いぶん、ここで確かめる。
//
// ■ 確かめるのは2つ。両方そろって初めて実行する
//
//  1. 署名   … サーバが言ってきた version / url / sha256 / size を
//     Ed25519 の公開鍵で確かめる。合わなければ URL を開きにいかない
//
//  2. ハッシュ … 落としたファイルの SHA-256 が、署名された値と一致するか
//
//     どちらか一方でも合わなければ、**絶対に実行しない**。
//     「とりあえず入れて、あとで確かめる」はしない。
//
// ■ 公開鍵は組み立てのときに焼き込む
//
//	秘密鍵は社内に1本だけ置き、リポジトリには入れない。
//	公開鍵は埋め込むだけなので、読まれても困らない。
package release

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Info は、サーバが「この版に上げてよい」と言ってきた中身。
type Info struct {
	Version   string
	URL       string
	SHA256    string
	SizeBytes int64
	Signature string // base64url
	KeyID     string
}

var (
	ErrNoKey     = errors.New("公開鍵が焼き込まれていません（署名を確かめられないので更新しません）")
	ErrNoSig     = errors.New("署名がありません")
	ErrBadSig    = errors.New("署名が合いません")
	ErrBadHash   = errors.New("落としたファイルが、署名された内容と違います")
	ErrTooBig    = errors.New("大きすぎます")
	ErrBadFields = errors.New("版・URL・ハッシュ・大きさのどれかが足りません")
)

// 更新ファイルの上限。これより大きいものは落とさない。
// 取り違えたURLで延々と落とし続けないため
const MaxSize = 120 << 20

// Signed は、署名の対象になる1つの文字列を作る。
//
// 4つをまとめて署名するのが大事。ハッシュだけに署名すると、
// 同じハッシュのまま URL を差し替えられる余地が残る。
func Signed(version, url, sha string, size int64) string {
	return strings.Join([]string{
		strings.TrimSpace(version),
		strings.TrimSpace(url),
		strings.ToLower(strings.TrimSpace(sha)),
		strconv.FormatInt(size, 10),
	}, "\n")
}

// ParseKey は、焼き込んだ公開鍵を読む（base64url、32バイト）。
func ParseKey(s string) (ed25519.PublicKey, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, ErrNoKey
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		// 末尾に = が付いた形でも読めるようにしておく
		b, err = base64.URLEncoding.DecodeString(s)
	}
	if err != nil {
		return nil, fmt.Errorf("公開鍵を読めません: %w", err)
	}
	if len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("公開鍵の長さが違います: %d バイト", len(b))
	}
	return ed25519.PublicKey(b), nil
}

// KeyID は公開鍵の目印。鍵を入れ替えたときに、どれで署名したか分かるように
func KeyID(pub ed25519.PublicKey) string {
	s := base64.RawURLEncoding.EncodeToString(pub)
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

// Verify は、サーバの言い分が「うちの鍵で署名されているか」を確かめる。
//
// ここを通らなければ、URL を開きにいかない。
func Verify(pubKey string, in Info) error {
	pub, err := ParseKey(pubKey)
	if err != nil {
		return err
	}
	if in.Version == "" || in.URL == "" || in.SHA256 == "" || in.SizeBytes <= 0 {
		return ErrBadFields
	}
	if in.SizeBytes > MaxSize {
		return ErrTooBig
	}
	if in.Signature == "" {
		return ErrNoSig
	}
	// 落とす先は https だけ。平文で落としたものを実行しない
	if !strings.HasPrefix(strings.ToLower(in.URL), "https://") {
		return fmt.Errorf("https でない配布先です: %s", in.URL)
	}
	if _, err := hex.DecodeString(in.SHA256); err != nil || len(in.SHA256) != 64 {
		return fmt.Errorf("ハッシュの形が違います")
	}

	sig, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(in.Signature))
	if err != nil {
		sig, err = base64.URLEncoding.DecodeString(strings.TrimSpace(in.Signature))
	}
	if err != nil || len(sig) != ed25519.SignatureSize {
		return ErrBadSig
	}

	if !ed25519.Verify(pub, []byte(Signed(in.Version, in.URL, in.SHA256, in.SizeBytes)), sig) {
		return ErrBadSig
	}
	return nil
}

// CheckBytes は、落としたファイルが署名された内容と同じかを確かめる。
//
// Verify を通っていても、これが合わなければ実行しない。
// 署名は「サーバの言い分」に対するもので、落ちてきた中身に対するものではない。
func CheckBytes(r io.Reader, in Info) ([]byte, error) {
	if in.SizeBytes <= 0 || in.SizeBytes > MaxSize {
		return nil, ErrTooBig
	}
	// 言われた大きさ＋1だけ読む。多ければその時点で違う
	buf, err := io.ReadAll(io.LimitReader(r, in.SizeBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) != in.SizeBytes {
		return nil, fmt.Errorf("%w（大きさが %d、言われたのは %d）",
			ErrBadHash, len(buf), in.SizeBytes)
	}
	sum := sha256.Sum256(buf)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), strings.TrimSpace(in.SHA256)) {
		return nil, ErrBadHash
	}
	return buf, nil
}

// Sign は、リリースのときに1行へ署名する（組み立て側で使う）。
func Sign(priv ed25519.PrivateKey, version, url, sha string, size int64) string {
	sig := ed25519.Sign(priv, []byte(Signed(version, url, sha, size)))
	return base64.RawURLEncoding.EncodeToString(sig)
}
