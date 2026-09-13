// Package crx は、Chrome / Edge に配る拡張（.crx）を作る。
//
// ■ なぜ自分で作るのか
//
//	拡張の ID は、署名に使う鍵から決まる。鍵が同じなら ID も同じ。
//	ID は会社のポリシー（ExtensionInstallForcelist）と、継ぎ役の
//	allowed_origins に焼き込むので、**変わってはいけない**。
//
//	Chrome の「拡張機能をパッケージ化」ボタンでも作れるが、それだと
//	誰かのパソコンに Chrome が要る。ここに置いておけば GitHub Actions
//	だけで完結する。
//
// ■ 形（CRX3）
//
//	"Cr24" | 版=3 | 見出しの長さ | 見出し | zip
//
//	見出しは protobuf。中に「公開鍵」と「署名」が入る。
//	署名は次の並びに対して RSA-SHA256（PKCS#1 v1.5）:
//
//	  "CRX3 SignedData\0" | 長さ(4) | SignedData | zip
//
//	この形は Chrome 側の読み手（crx_verifier）と合わせてある。
//	crx_test.go で、Chromium が作った .crx をこのコードで読めることを
//	確かめている。合わなくなったら、そこで落ちる。
package crx

import (
	"archive/zip"
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// MaxSize は、読み込む .crx の上限。壊れた長さを渡されて
// 際限なく確保しないための歯止め
const MaxSize = 64 << 20

// magic と、署名の対象の先頭に置く決まり文句。
// どちらも Chrome 側と一字でも違うと通らない
const (
	magic      = "Cr24"
	sigContext = "CRX3 SignedData\x00"
)

// ---- ID -------------------------------------------------------------------

// ID は、公開鍵（SubjectPublicKeyInfo の DER）から決まる32文字の拡張ID。
//
// SHA-256 の頭16バイトを、16進の代わりに a〜p で書いたもの。
// 鍵が同じなら、いつ・どこで作っても同じ文字列になる。
func ID(spki []byte) string {
	sum := sha256.Sum256(spki)
	out := make([]byte, 32)
	for i := 0; i < 16; i++ {
		out[i*2] = 'a' + (sum[i] >> 4)
		out[i*2+1] = 'a' + (sum[i] & 0x0f)
	}
	return string(out)
}

// ValidID は、32文字の a〜p だけでできているか。
//
// 「32文字のChrome拡張ID」のような、埋め忘れの文字列を先で弾くために使う。
// ここを通らないものをポリシーに書くと、ブラウザは黙って無視する
func ValidID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 'a' || s[i] > 'p' {
			return false
		}
	}
	return true
}

// RawID は、ID を元の16バイトに戻す。CRX3 の SignedData に入れる形
func RawID(spki []byte) []byte {
	sum := sha256.Sum256(spki)
	return sum[:16]
}

// SPKI は、秘密鍵から公開鍵の DER を取り出す
func SPKI(priv *rsa.PrivateKey) ([]byte, error) {
	return x509.MarshalPKIXPublicKey(&priv.PublicKey)
}

// ManifestKey は、manifest.json の "key" に入れる値。
//
// これを入れておくと、.crx にしないで「パッケージ化されていない拡張機能を
// 読み込む」で入れたときも同じ ID になる。入っているか確かめるときに要る
func ManifestKey(spki []byte) string {
	return base64.StdEncoding.EncodeToString(spki)
}

// ---- 鍵 --------------------------------------------------------------------

// NewKey は、拡張用の鍵を作る。2048 で足りる（Chrome の既定も 2048）
func NewKey() (*rsa.PrivateKey, error) {
	return rsa.GenerateKey(rand.Reader, 2048)
}

// EncodeKey は、PKCS#8 の PEM にする。Chrome もこの形を読む
func EncodeKey(priv *rsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

// ParseKey は、PEM の秘密鍵を読む。
//
// openssl の版によって PKCS#1（BEGIN RSA PRIVATE KEY）と
// PKCS#8（BEGIN PRIVATE KEY）のどちらも出てくるので、両方受ける。
// 受けられないものを黙って捨てると、鍵を作り直す羽目になる
func ParseKey(b []byte) (*rsa.PrivateKey, error) {
	blk, _ := pem.Decode(bytes.TrimSpace(b))
	if blk == nil {
		return nil, fmt.Errorf("PEM として読めません（-----BEGIN ... で始まる形が要ります）")
	}
	if k, err := x509.ParsePKCS1PrivateKey(blk.Bytes); err == nil {
		return k, nil
	}
	any, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("秘密鍵として読めません: %w", err)
	}
	k, ok := any.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("RSA の鍵ではありません（%T）", any)
	}
	if k.N.BitLen() < 2048 {
		return nil, fmt.Errorf("鍵が短すぎます（%d ビット）", k.N.BitLen())
	}
	return k, nil
}

// ---- 固める ----------------------------------------------------------------

// Zip は、拡張のフォルダを zip にする。
//
// 並び順と日時を決め打ちにしてあるので、中身が同じなら何度やっても
// 同じ zip になる。「作り直したら別物になった」を避けるため
func Zip(dir string) ([]byte, error) {
	var names []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		names = append(names, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("%s に何もありません", dir)
	}
	sort.Strings(names)

	// manifest.json が無い .crx は、ブラウザが拡張として見てくれない
	found := false
	for _, n := range names {
		if n == "manifest.json" {
			found = true
		}
	}
	if !found {
		return nil, fmt.Errorf("%s に manifest.json がありません", dir)
	}
	if err := CheckFiles(dir); err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fixed := time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, n := range names {
		body, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(n)))
		if err != nil {
			return nil, err
		}
		w, err := zw.CreateHeader(&zip.FileHeader{
			Name:     n,
			Method:   zip.Deflate,
			Modified: fixed,
		})
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(body); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// CheckFiles は、manifest.json が名前を挙げているファイルが実際にあるか見る。
//
// ■ なぜ要るのか
//
//	icons に書いたファイルが無いだけで、ブラウザは拡張を**まるごと**
//	受け取らない。固めることすらできない。
//	それでいて、組み立て自体は最後まで通ってしまう。
//
//	実際に icon128.png が無いまま置かれていて、
//	「EXE はできるのにブラウザ連携だけ入らない」状態になっていた。
//	気づけるのが配ったあとになるので、ここで止める
func CheckFiles(dir string) error {
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return err
	}
	var m struct {
		Icons      map[string]string `json:"icons"`
		Background struct {
			ServiceWorker string `json:"service_worker"`
			Page          string `json:"page"`
		} `json:"background"`
		OptionsPage string `json:"options_page"`
		Action      struct {
			DefaultPopup string            `json:"default_popup"`
			DefaultIcon  map[string]string `json:"default_icon"`
		} `json:"action"`
		ContentScripts []struct {
			JS  []string `json:"js"`
			CSS []string `json:"css"`
		} `json:"content_scripts"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return fmt.Errorf("manifest.json を読めません: %w", err)
	}

	want := map[string]string{}
	add := func(where, p string) {
		if p != "" {
			want[p] = where
		}
	}
	for size, p := range m.Icons {
		add("icons."+size, p)
	}
	for size, p := range m.Action.DefaultIcon {
		add("action.default_icon."+size, p)
	}
	add("background.service_worker", m.Background.ServiceWorker)
	add("background.page", m.Background.Page)
	add("options_page", m.OptionsPage)
	add("action.default_popup", m.Action.DefaultPopup)
	for i, cs := range m.ContentScripts {
		for _, p := range cs.JS {
			add(fmt.Sprintf("content_scripts[%d].js", i), p)
		}
		for _, p := range cs.CSS {
			add(fmt.Sprintf("content_scripts[%d].css", i), p)
		}
	}

	var missing []string
	for p, where := range want {
		if strings.Contains(p, "..") {
			return fmt.Errorf("manifest.json の %s が外を指しています: %s", where, p)
		}
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(p))); err != nil {
			missing = append(missing, fmt.Sprintf("%s → %s", where, p))
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return fmt.Errorf("manifest.json が挙げているファイルがありません:\n    %s\n"+
			"  これがあると、ブラウザは拡張をまるごと受け取りません",
			strings.Join(missing, "\n    "))
	}
	return nil
}

// Pack は、zip と鍵から .crx を作る
func Pack(zipData []byte, priv *rsa.PrivateKey) ([]byte, error) {
	if len(zipData) == 0 {
		return nil, fmt.Errorf("中身が空です")
	}
	spki, err := SPKI(priv)
	if err != nil {
		return nil, err
	}

	// SignedData { crx_id = 先頭16バイト }
	signed := field(1, RawID(spki))

	sum := sha256.New()
	sum.Write([]byte(sigContext))
	var n [4]byte
	binary.LittleEndian.PutUint32(n[:], uint32(len(signed)))
	sum.Write(n[:])
	sum.Write(signed)
	sum.Write(zipData)

	sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, sum.Sum(nil))
	if err != nil {
		return nil, err
	}

	// AsymmetricKeyProof { public_key = 1, signature = 2 }
	proof := append(field(1, spki), field(2, sig)...)
	// CrxFileHeader { sha256_with_rsa = 2, signed_header_data = 10000 }
	header := append(field(2, proof), field(10000, signed)...)

	out := bytes.NewBuffer(make([]byte, 0, len(header)+len(zipData)+12))
	out.WriteString(magic)
	_ = binary.Write(out, binary.LittleEndian, uint32(3))
	_ = binary.Write(out, binary.LittleEndian, uint32(len(header)))
	out.Write(header)
	out.Write(zipData)
	return out.Bytes(), nil
}

// Verify は、.crx を読んで ID を返す。署名が合わなければ返さない。
//
// 自分で作ったものが自分で読めるか、そして Chromium が作ったものも
// 読めるかを、テストで突き合わせるために置いてある
func Verify(b []byte) (string, error) {
	if len(b) > MaxSize {
		return "", fmt.Errorf("大きすぎます（%d バイト）", len(b))
	}
	if len(b) < 16 || string(b[:4]) != magic {
		return "", fmt.Errorf("Cr24 で始まっていません")
	}
	if v := binary.LittleEndian.Uint32(b[4:8]); v != 3 {
		return "", fmt.Errorf("CRX3 ではありません（版 %d）", v)
	}
	hlen := binary.LittleEndian.Uint32(b[8:12])
	if int64(hlen) > int64(len(b))-12 {
		return "", fmt.Errorf("見出しの長さが中身と合いません")
	}
	header, zipData := b[12:12+hlen], b[12+hlen:]

	var proofs [][]byte
	var signed []byte
	if err := each(header, func(num int, val []byte) error {
		switch num {
		case 2:
			proofs = append(proofs, val)
		case 10000:
			signed = val
		}
		return nil
	}); err != nil {
		return "", err
	}
	if signed == nil {
		return "", fmt.Errorf("SignedData がありません")
	}
	if len(proofs) == 0 {
		return "", fmt.Errorf("RSA の署名がありません")
	}

	sum := sha256.New()
	sum.Write([]byte(sigContext))
	var n [4]byte
	binary.LittleEndian.PutUint32(n[:], uint32(len(signed)))
	sum.Write(n[:])
	sum.Write(signed)
	sum.Write(zipData)
	digest := sum.Sum(nil)

	// SignedData に入っている ID
	var want []byte
	if err := each(signed, func(num int, val []byte) error {
		if num == 1 {
			want = val
		}
		return nil
	}); err != nil {
		return "", err
	}
	if len(want) != 16 {
		return "", fmt.Errorf("SignedData の crx_id が16バイトではありません")
	}

	for _, p := range proofs {
		var spki, sig []byte
		if err := each(p, func(num int, val []byte) error {
			switch num {
			case 1:
				spki = val
			case 2:
				sig = val
			}
			return nil
		}); err != nil {
			return "", err
		}
		if spki == nil || sig == nil {
			continue
		}
		pub, err := x509.ParsePKIXPublicKey(spki)
		if err != nil {
			continue
		}
		rp, ok := pub.(*rsa.PublicKey)
		if !ok {
			continue
		}
		if rsa.VerifyPKCS1v15(rp, crypto.SHA256, digest, sig) != nil {
			continue
		}
		// 署名した鍵と、名乗っている ID が同じものか。
		// ここを見ないと、他人の鍵で署名したものに好きな ID を名乗らせられる
		if !bytes.Equal(RawID(spki), want) {
			return "", fmt.Errorf("署名した鍵と crx_id が一致しません")
		}
		return ID(spki), nil
	}
	return "", fmt.Errorf("署名が合いません")
}

// Unzip は、.crx の中の zip を取り出す。確かめ用
func Unzip(b []byte) (map[string][]byte, error) {
	if len(b) < 12 || string(b[:4]) != magic {
		return nil, fmt.Errorf("Cr24 で始まっていません")
	}
	hlen := binary.LittleEndian.Uint32(b[8:12])
	if int64(hlen) > int64(len(b))-12 {
		return nil, fmt.Errorf("見出しの長さが中身と合いません")
	}
	zipData := b[12+hlen:]
	zr, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return nil, err
	}
	out := map[string][]byte{}
	for _, f := range zr.File {
		// zip の中の名前で外へ出ない。固めたものを開くときの定番の穴
		if strings.Contains(f.Name, "..") || strings.HasPrefix(f.Name, "/") {
			return nil, fmt.Errorf("怪しい名前が入っています: %s", f.Name)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(rc, MaxSize))
		rc.Close()
		if err != nil {
			return nil, err
		}
		out[f.Name] = body
	}
	return out, nil
}

// ---- protobuf（要るところだけ）-----------------------------------------------

// field は、長さつきの1項目を書く
func field(num int, val []byte) []byte {
	out := varint(uint64(num)<<3 | 2)
	out = append(out, varint(uint64(len(val)))...)
	return append(out, val...)
}

func varint(v uint64) []byte {
	var out []byte
	for v >= 0x80 {
		out = append(out, byte(v)|0x80)
		v >>= 7
	}
	return append(out, byte(v))
}

// each は、長さつきの項目だけを拾って回る。
// それ以外の形（varint など）は飛ばす
func each(b []byte, fn func(num int, val []byte) error) error {
	for len(b) > 0 {
		tag, n := readVarint(b)
		if n == 0 {
			return fmt.Errorf("protobuf を読めません")
		}
		b = b[n:]
		num, wire := int(tag>>3), int(tag&7)
		switch wire {
		case 0:
			_, n := readVarint(b)
			if n == 0 {
				return fmt.Errorf("protobuf を読めません")
			}
			b = b[n:]
		case 1:
			if len(b) < 8 {
				return fmt.Errorf("protobuf を読めません")
			}
			b = b[8:]
		case 2:
			l, n := readVarint(b)
			if n == 0 || uint64(len(b)-n) < l {
				return fmt.Errorf("protobuf を読めません")
			}
			b = b[n:]
			if err := fn(num, b[:l]); err != nil {
				return err
			}
			b = b[l:]
		case 5:
			if len(b) < 4 {
				return fmt.Errorf("protobuf を読めません")
			}
			b = b[4:]
		default:
			return fmt.Errorf("知らない形です（wire %d）", wire)
		}
	}
	return nil
}

func readVarint(b []byte) (uint64, int) {
	var v uint64
	for i := 0; i < len(b) && i < 10; i++ {
		v |= uint64(b[i]&0x7f) << (7 * i)
		if b[i] < 0x80 {
			return v, i + 1
		}
	}
	return 0, 0
}
