package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

// 本物そっくりの1件を作る。壊すテストは、これを1か所だけ変えて使う
func good(t *testing.T) (pub string, in Info, body []byte) {
	t.Helper()
	p, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	body = bytes.Repeat([]byte("EIGHT"), 400)
	sum := sha256.Sum256(body)
	in = Info{
		Version:   "1.2.3",
		URL:       "https://mf.8grp.co.jp/agent/EIGHT-Agent-Setup.exe",
		SHA256:    hex.EncodeToString(sum[:]),
		SizeBytes: int64(len(body)),
		KeyID:     KeyID(p),
	}
	in.Signature = Sign(priv, in.Version, in.URL, in.SHA256, in.SizeBytes)
	return base64.RawURLEncoding.EncodeToString(p), in, body
}

func TestVerifyOK(t *testing.T) {
	pub, in, _ := good(t)
	if err := Verify(pub, in); err != nil {
		t.Fatalf("正しいものが弾かれた: %v", err)
	}
}

// 署名は4つ全部にかかっている。どれを書き換えても通らないこと。
//
// ハッシュだけに署名していると、同じ中身のまま URL を差し替えられる。
// そこが塞がっているかを見るのが、このテストの目的
func TestVerifyTampered(t *testing.T) {
	cases := map[string]func(*Info){
		"版を書き換え":       func(i *Info) { i.Version = "9.9.9" },
		"配布先を書き換え":     func(i *Info) { i.URL = "https://evil.example.com/x.exe" },
		"ハッシュを書き換え":    func(i *Info) { i.SHA256 = strings.Repeat("a", 64) },
		"大きさを書き換え":     func(i *Info) { i.SizeBytes++ },
		"署名を消す":        func(i *Info) { i.Signature = "" },
		"署名を1文字変える":    func(i *Info) { i.Signature = "A" + i.Signature[1:] },
		"署名が短い":        func(i *Info) { i.Signature = base64.RawURLEncoding.EncodeToString([]byte("short")) },
		"署名がbase64でない": func(i *Info) { i.Signature = "!!!!" },
	}
	for name, break_ := range cases {
		t.Run(name, func(t *testing.T) {
			pub, in, _ := good(t)
			break_(&in)
			if err := Verify(pub, in); err == nil {
				t.Fatal("通ってしまった")
			}
		})
	}
}

func TestVerifyWrongKey(t *testing.T) {
	_, in, _ := good(t)
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	err := Verify(base64.RawURLEncoding.EncodeToString(other), in)
	if !errors.Is(err, ErrBadSig) {
		t.Fatalf("別の鍵で通った: %v", err)
	}
}

// 鍵が焼き込まれていないときは、更新しない（素通しにしない）
func TestVerifyNoKey(t *testing.T) {
	_, in, _ := good(t)
	if err := Verify("", in); !errors.Is(err, ErrNoKey) {
		t.Fatalf("鍵なしで通った: %v", err)
	}
	if err := Verify("   ", in); !errors.Is(err, ErrNoKey) {
		t.Fatalf("空白だけの鍵で通った: %v", err)
	}
	if err := Verify("not-a-key", in); err == nil {
		t.Fatal("読めない鍵で通った")
	}
	short := base64.RawURLEncoding.EncodeToString([]byte("tooshort"))
	if err := Verify(short, in); err == nil {
		t.Fatal("長さの違う鍵で通った")
	}
}

// 平文で落としたものは実行しない
func TestVerifyPlainHTTP(t *testing.T) {
	p, priv, _ := ed25519.GenerateKey(rand.Reader)
	body := []byte("x")
	sum := sha256.Sum256(body)
	in := Info{
		Version:   "1.0.0",
		URL:       "http://mf.8grp.co.jp/agent/EIGHT-Agent-Setup.exe",
		SHA256:    hex.EncodeToString(sum[:]),
		SizeBytes: 1,
	}
	// 正しく署名されていても、https でなければ落としにいかない
	in.Signature = Sign(priv, in.Version, in.URL, in.SHA256, in.SizeBytes)
	if err := Verify(base64.RawURLEncoding.EncodeToString(p), in); err == nil {
		t.Fatal("http で通った")
	}
}

func TestVerifyFields(t *testing.T) {
	cases := map[string]func(*Info){
		"版が空":    func(i *Info) { i.Version = "" },
		"URLが空":  func(i *Info) { i.URL = "" },
		"ハッシュが空": func(i *Info) { i.SHA256 = "" },
		"大きさが0":  func(i *Info) { i.SizeBytes = 0 },
		"大きさが負":  func(i *Info) { i.SizeBytes = -1 },
	}
	for name, break_ := range cases {
		t.Run(name, func(t *testing.T) {
			pub, in, _ := good(t)
			break_(&in)
			if err := Verify(pub, in); !errors.Is(err, ErrBadFields) {
				t.Fatalf("通ってしまった: %v", err)
			}
		})
	}
}

func TestVerifyTooBig(t *testing.T) {
	pub, in, _ := good(t)
	in.SizeBytes = MaxSize + 1
	if err := Verify(pub, in); !errors.Is(err, ErrTooBig) {
		t.Fatalf("大きすぎるものが通った: %v", err)
	}
}

func TestVerifyBadHashShape(t *testing.T) {
	for _, s := range []string{"abc", strings.Repeat("z", 64), strings.Repeat("ab", 40)} {
		pub, in, _ := good(t)
		in.SHA256 = s
		if err := Verify(pub, in); err == nil {
			t.Fatalf("ハッシュの形 %q が通った", s)
		}
	}
}

// 署名を通っても、落ちてきた中身が違えば実行しない
func TestCheckBytes(t *testing.T) {
	_, in, body := good(t)

	got, err := CheckBytes(bytes.NewReader(body), in)
	if err != nil {
		t.Fatalf("正しい中身が弾かれた: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatal("読めた中身が違う")
	}

	// 1バイト違う
	bad := append([]byte(nil), body...)
	bad[10] ^= 0xff
	if _, err := CheckBytes(bytes.NewReader(bad), in); !errors.Is(err, ErrBadHash) {
		t.Fatalf("中身を変えたのに通った: %v", err)
	}
	// 足りない
	if _, err := CheckBytes(bytes.NewReader(body[:len(body)-1]), in); !errors.Is(err, ErrBadHash) {
		t.Fatalf("短いのに通った: %v", err)
	}
	// 多い（言われた大きさ＋1 までしか読まないので、そこで気づく）
	if _, err := CheckBytes(bytes.NewReader(append(body, 'x')), in); !errors.Is(err, ErrBadHash) {
		t.Fatalf("長いのに通った: %v", err)
	}
	// 大きさが無い
	in.SizeBytes = 0
	if _, err := CheckBytes(bytes.NewReader(body), in); !errors.Is(err, ErrTooBig) {
		t.Fatal("大きさ0で通った")
	}
}

func TestParseKeyPadded(t *testing.T) {
	p, _, _ := ed25519.GenerateKey(rand.Reader)
	// = 付きで書いても読めること（手で貼るときに混ざりやすい）
	padded := base64.URLEncoding.EncodeToString(p)
	got, err := ParseKey(padded)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, p) {
		t.Fatal("読んだ鍵が違う")
	}
}

func TestKeyIDStable(t *testing.T) {
	p, _, _ := ed25519.GenerateKey(rand.Reader)
	a, b := KeyID(p), KeyID(p)
	if a != b || len(a) != 8 {
		t.Fatalf("目印が安定しない: %q %q", a, b)
	}
	q, _, _ := ed25519.GenerateKey(rand.Reader)
	if KeyID(q) == a {
		t.Fatal("別の鍵で同じ目印")
	}
}

// 署名の対象は、前後の空白やハッシュの大文字小文字に引きずられないこと。
// 管理画面に貼るときに混ざっても、署名が合わなくなると困る
func TestSignedNormalizes(t *testing.T) {
	a := Signed("1.0.0", "https://x/y", "ABCDEF", 10)
	b := Signed(" 1.0.0 ", " https://x/y ", " abcdef ", 10)
	if a != b {
		t.Fatalf("正規化されていない:\n%q\n%q", a, b)
	}
	if strings.Count(a, "\n") != 3 {
		t.Fatalf("4行になっていない: %q", a)
	}
}
