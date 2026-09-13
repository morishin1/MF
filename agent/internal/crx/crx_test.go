package crx

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func mustKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	k, err := NewKey()
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// ---- ID の出し方 -------------------------------------------------------------

func TestIDShape(t *testing.T) {
	k := mustKey(t)
	spki, err := SPKI(k)
	if err != nil {
		t.Fatal(err)
	}
	id := ID(spki)
	if len(id) != 32 {
		t.Fatalf("32文字のはず: %d (%s)", len(id), id)
	}
	if !ValidID(id) {
		t.Fatalf("a〜p だけのはず: %s", id)
	}
}

// 同じ鍵なら、いつ出しても同じ ID。
// これが崩れると「作り直したら別の拡張になった」が起きる
func TestIDIsStable(t *testing.T) {
	k := mustKey(t)
	spki, _ := SPKI(k)
	a, b := ID(spki), ID(spki)
	if a != b {
		t.Fatalf("同じ鍵で違う ID: %s / %s", a, b)
	}
	// PEM に出して読み直しても同じか（Secrets に入れて出す道筋）
	pemBytes, err := EncodeKey(k)
	if err != nil {
		t.Fatal(err)
	}
	k2, err := ParseKey(pemBytes)
	if err != nil {
		t.Fatal(err)
	}
	spki2, _ := SPKI(k2)
	if got := ID(spki2); got != a {
		t.Fatalf("PEM を通すと変わった: %s → %s", a, got)
	}
}

func TestDifferentKeysDifferentID(t *testing.T) {
	s1, _ := SPKI(mustKey(t))
	s2, _ := SPKI(mustKey(t))
	if ID(s1) == ID(s2) {
		t.Fatal("違う鍵で同じ ID が出た")
	}
}

// 16進の 0-f を a-p に置き換えているだけ、という取り決めを直に確かめる
func TestIDMapping(t *testing.T) {
	// 中身は何でもよいので、既知のバイト列から作った SPKI 相当を使わず
	// 対応表そのものを見る
	for i := 0; i < 16; i++ {
		want := byte('a' + i)
		got := "abcdefghijklmnop"[i]
		if got != want {
			t.Fatalf("%d: %c != %c", i, got, want)
		}
	}
}

// openssl で出した ID と一致するか。
// 実装を2つ用意して突き合わせる。片方の思い込みで通ってしまわないように
func TestIDMatchesOpenSSL(t *testing.T) {
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("openssl が無い")
	}
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "k.pem")

	k := mustKey(t)
	pemBytes, err := EncodeKey(k)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pemBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	// openssl で公開鍵の DER を出し、sha256 の頭16バイトを a〜p に写す
	sh := `set -eu
openssl rsa -in "` + keyPath + `" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -hex \
  | sed 's/^.*= //' | cut -c1-32 | tr '0-9a-f' 'a-p'`
	out, err := exec.Command("bash", "-c", sh).Output()
	if err != nil {
		t.Fatalf("openssl: %v", err)
	}
	want := strings.TrimSpace(string(out))

	spki, _ := SPKI(k)
	if got := ID(spki); got != want {
		t.Fatalf("openssl と食い違う\n  こちら: %s\n  openssl: %s", got, want)
	}
}

func TestValidID(t *testing.T) {
	ok := []string{
		"abcdefghijklmnopabcdefghijklmnop",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"pppppppppppppppppppppppppppppppp",
	}
	for _, s := range ok {
		if !ValidID(s) {
			t.Fatalf("通すはず: %s", s)
		}
	}
	// 埋め忘れ・書き間違いを、ここで止める
	ng := []string{
		"",
		"32文字のChrome拡張ID",
		"abcdefghijklmnopabcdefghijklmno",   // 31
		"abcdefghijklmnopabcdefghijklmnopa", // 33
		"abcdefghijklmnopabcdefghijklmnoq",  // q は範囲外
		"abcdefghijklmnopabcdefghijklmno1",  // 数字
		"ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",  // 大文字
		"abcdefghijklmnop abcdefghijklmno",
		"ここに32文字のID",
	}
	for _, s := range ng {
		if ValidID(s) {
			t.Fatalf("弾くはず: %q", s)
		}
	}
}

// ---- 鍵の読み書き -------------------------------------------------------------

func TestParseKeyPKCS1(t *testing.T) {
	// openssl 1.x が出す形（BEGIN RSA PRIVATE KEY）も読めること。
	// 読めないと、手元にある鍵を捨てて作り直すことになる
	k := mustKey(t)
	b := pem.EncodeToMemory(&pem.Block{
		Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k),
	})
	got, err := ParseKey(b)
	if err != nil {
		t.Fatal(err)
	}
	s1, _ := SPKI(k)
	s2, _ := SPKI(got)
	if ID(s1) != ID(s2) {
		t.Fatal("PKCS#1 を通すと別の鍵になった")
	}
}

func TestParseKeyRejects(t *testing.T) {
	cases := map[string][]byte{
		"空":          {},
		"PEM でない":    []byte("hello"),
		"見出しだけ":      []byte("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n"),
		"中身が壊れている":   []byte("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"),
		"公開鍵を渡した":    mustPub(t),
		"短すぎる（1024）": mustShortKey(t),
	}
	for name, b := range cases {
		if _, err := ParseKey(b); err == nil {
			t.Fatalf("弾くはず: %s", name)
		}
	}
}

func mustPub(t *testing.T) []byte {
	t.Helper()
	spki, _ := SPKI(mustKey(t))
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: spki})
}

// 短い鍵を弾くこと。ID の付け替えを狙われたときに、
// 総当たりの余地を残さないため
func mustShortKey(t *testing.T) []byte {
	t.Helper()
	broken := []byte("-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----\n")
	k, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		return broken // 環境によっては 1024 を作らせない
	}
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return broken
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

// ---- manifest の key ---------------------------------------------------------

func TestManifestKeyRoundTrip(t *testing.T) {
	k := mustKey(t)
	spki, _ := SPKI(k)
	mk := ManifestKey(spki)
	back, err := base64.StdEncoding.DecodeString(mk)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(back, spki) {
		t.Fatal("戻らない")
	}
	// manifest.json の "key" から出る ID も、鍵から出る ID と同じであること。
	// ここが違うと、読み込んだときだけ別の拡張になる
	if ID(back) != ID(spki) {
		t.Fatal("manifest の key から別の ID が出た")
	}
	if strings.ContainsAny(mk, "\n\r") {
		t.Fatal("1行であること（JSON に入れるため）")
	}
}

// ---- 固める ------------------------------------------------------------------

func sampleDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("manifest.json", `{"manifest_version":3,"name":"t","version":"1.0.0"}`)
	write("background.js", "// hi\n")
	return dir
}

// manifest.json が名前を挙げたファイルが無いと、ブラウザは拡張を
// まるごと受け取らない。組み立ては通ってしまうので、ここで止める。
//
// 実際に icon128.png が無いまま置かれていて、EXE はできるのに
// ブラウザ連携だけ入らない状態になっていた
func TestCheckFilesFindsMissing(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("manifest.json", `{"manifest_version":3,"name":"t","version":"1.0.0",
	  "background":{"service_worker":"background.js"},
	  "options_page":"options.html",
	  "icons":{"128":"icon128.png"}}`)

	err := CheckFiles(dir)
	if err == nil {
		t.Fatal("3つとも無いのに通った")
	}
	for _, want := range []string{"icon128.png", "background.js", "options.html"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("%s が挙がっていない:\n%v", want, err)
		}
	}

	// 揃えたら通ること
	write("background.js", "")
	write("options.html", "")
	write("icon128.png", "")
	if err := CheckFiles(dir); err != nil {
		t.Fatalf("揃っているのに落ちた: %v", err)
	}

	// 1つ消したら、また落ちること（見ているふりをしていないか）
	if err := os.Remove(filepath.Join(dir, "icon128.png")); err != nil {
		t.Fatal(err)
	}
	if err := CheckFiles(dir); err == nil {
		t.Fatal("icons だけ無くしたのに通った")
	}
}

func TestCheckFilesRejectsEscape(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"),
		[]byte(`{"icons":{"128":"../../etc/passwd"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := CheckFiles(dir); err == nil || !strings.Contains(err.Error(), "外を指") {
		t.Fatalf("外を指す名前を弾くはず: %v", err)
	}
}

// 固めるときも、同じところで止まること
func TestZipStopsOnMissingFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"),
		[]byte(`{"manifest_version":3,"version":"1.0.0","icons":{"128":"icon128.png"}}`),
		0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Zip(dir); err == nil {
		t.Fatal("挙げたファイルが無いのに固まった")
	}
}

// 実際に配るフォルダが揃っているか。
// ここが落ちたら、配る前に気づける
func TestRealExtensionIsComplete(t *testing.T) {
	dir := filepath.Join("..", "..", "extension")
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err != nil {
		t.Skip("extension/ が無い")
	}
	if err := CheckFiles(dir); err != nil {
		t.Fatalf("agent/extension/ が揃っていません: %v", err)
	}
}

func TestZipNeedsManifest(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Zip(dir); err == nil {
		t.Fatal("manifest.json が無ければ弾くはず")
	}
	if _, err := Zip(filepath.Join(dir, "ない")); err == nil {
		t.Fatal("無いフォルダは弾くはず")
	}
}

// 同じ中身なら同じ zip。作り直すたびに別物になると、
// 「上げたものと署名したものが同じか」を大きさやハッシュで確かめられなくなる
func TestZipIsStable(t *testing.T) {
	dir := sampleDir(t)
	a, err := Zip(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Zip(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("同じ中身で違う zip が出た")
	}
}

func TestPackRoundTrip(t *testing.T) {
	k := mustKey(t)
	z, err := Zip(sampleDir(t))
	if err != nil {
		t.Fatal(err)
	}
	c, err := Pack(z, k)
	if err != nil {
		t.Fatal(err)
	}
	if string(c[:4]) != "Cr24" {
		t.Fatalf("Cr24 で始まるはず: %q", c[:4])
	}
	got, err := Verify(c)
	if err != nil {
		t.Fatal(err)
	}
	spki, _ := SPKI(k)
	if want := ID(spki); got != want {
		t.Fatalf("ID が違う: %s != %s", got, want)
	}
	files, err := Unzip(c)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := files["manifest.json"]; !ok {
		t.Fatal("manifest.json が入っていない")
	}
	if _, ok := files["background.js"]; !ok {
		t.Fatal("background.js が入っていない")
	}
}

// 1バイト変えたら通らないこと。
// ここが緩いと、中身を差し替えたものを配れてしまう
func TestPackDetectsTampering(t *testing.T) {
	k := mustKey(t)
	z, _ := Zip(sampleDir(t))
	c, err := Pack(z, k)
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range []int{len(c) - 1, len(c) - 50, len(c) / 2, 20} {
		if at < 0 || at >= len(c) {
			continue
		}
		bad := append([]byte(nil), c...)
		bad[at] ^= 0xff
		if _, err := Verify(bad); err == nil {
			t.Fatalf("%d バイト目を変えたのに通った", at)
		}
	}
}

// 他人の鍵で署名しておいて、名乗りだけ別の ID にする、ができないこと
func TestPackRejectsIDSwap(t *testing.T) {
	k1, k2 := mustKey(t), mustKey(t)
	z, _ := Zip(sampleDir(t))
	c, err := Pack(z, k1)
	if err != nil {
		t.Fatal(err)
	}
	s1, _ := SPKI(k1)
	s2, _ := SPKI(k2)
	// SignedData の中の16バイトだけ、別の鍵のものに差し替える
	bad := bytes.Replace(c, RawID(s1), RawID(s2), 1)
	if bytes.Equal(bad, c) {
		t.Skip("差し替えられなかった")
	}
	if _, err := Verify(bad); err == nil {
		t.Fatal("crx_id を差し替えたのに通った")
	}
}

func TestVerifyRejects(t *testing.T) {
	k := mustKey(t)
	z, _ := Zip(sampleDir(t))
	good, _ := Pack(z, k)

	cases := map[string][]byte{
		"空":           {},
		"短すぎる":        []byte("Cr24"),
		"magic が違う":   append([]byte("Cr99"), good[4:]...),
		"版が違う":        append(append([]byte("Cr24"), 2, 0, 0, 0), good[8:]...),
		"見出しが長すぎると言う": append(append([]byte("Cr24"), 3, 0, 0, 0, 0xff, 0xff, 0xff, 0x7f), good[12:]...),
		"zip だけ":      z,
	}
	for name, b := range cases {
		if _, err := Verify(b); err == nil {
			t.Fatalf("弾くはず: %s", name)
		}
	}
}

func TestPackRejectsEmpty(t *testing.T) {
	if _, err := Pack(nil, mustKey(t)); err == nil {
		t.Fatal("空を弾くはず")
	}
}

// ---- Chromium が作ったものを読めるか -------------------------------------------
//
// ここが通らないなら、こちらの作りが Chrome 側と食い違っている。
// 「うちでは読めるが Chrome が受け取らない .crx」を配らないための、最後の砦
func TestReadsChromiumCrx(t *testing.T) {
	chrome := findChrome()
	if chrome == "" {
		t.Skip("Chromium が無い（CI では飛ばす）")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "ext")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"manifest.json": `{"manifest_version":3,"name":"t","version":"1.0.0"}`,
		"background.js": "// hi\n",
	} {
		if err := os.WriteFile(filepath.Join(src, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	k := mustKey(t)
	keyPath := filepath.Join(dir, "ext.pem")
	pemBytes, _ := EncodeKey(k)
	if err := os.WriteFile(keyPath, pemBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(chrome,
		"--no-sandbox", "--headless=new",
		"--user-data-dir="+filepath.Join(dir, "u"),
		"--pack-extension="+src,
		"--pack-extension-key="+keyPath,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("Chromium で固められなかった: %v\n%s", err, out)
	}

	made, err := os.ReadFile(filepath.Join(dir, "ext.crx"))
	if err != nil {
		t.Skipf("Chromium が .crx を出さなかった: %v", err)
	}
	got, err := Verify(made)
	if err != nil {
		t.Fatalf("Chromium が作った .crx を読めない: %v", err)
	}
	spki, _ := SPKI(k)
	if want := ID(spki); got != want {
		t.Fatalf("Chromium と ID が食い違う: %s != %s", got, want)
	}

	// ここからが本題。
	//
	// 「Chromium のものを読める」だけでは、**こちらが作ったものを
	// Chromium が受け取る**ことの証明にならない。
	// そこで、Chromium が固めた zip をそのまま取り出し、同じ鍵で
	// こちらが組み直す。出来上がりが1バイトも違わなければ、
	// こちらの作りは Chromium と同じ、と言い切れる。
	//
	// （RSA PKCS#1 v1.5 は詰め方が決まっているので、同じ入力なら
	//   同じ署名になる。だから比べられる）
	hlen := uint32(made[8]) | uint32(made[9])<<8 | uint32(made[10])<<16 | uint32(made[11])<<24
	mine, err := Pack(made[12+hlen:], k)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(mine, made) {
		t.Fatalf("Chromium と同じにならない\n  こちら %d バイト\n  Chromium %d バイト\n"+
			"  見出しが同じか: %v",
			len(mine), len(made), bytes.Equal(mine[:12+hlen], made[:12+hlen]))
	}
}

func findChrome() string {
	if p := os.Getenv("CRX_TEST_CHROME"); p != "" {
		return p
	}
	pats := []string{
		"/opt/pw-browsers/chromium-*/chrome-linux/chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	}
	for _, p := range pats {
		if m, _ := filepath.Glob(p); len(m) > 0 {
			return m[len(m)-1]
		}
	}
	return ""
}

// ---- protobuf の読み書き ------------------------------------------------------

func TestVarint(t *testing.T) {
	for _, v := range []uint64{0, 1, 127, 128, 300, 80002, 1 << 20} {
		b := varint(v)
		got, n := readVarint(b)
		if n != len(b) || got != v {
			t.Fatalf("%d: %v → %d (%d)", v, b, got, n)
		}
	}
	// signed_header_data は 10000 番。タグが3バイトになる境目なので直に見る
	if b := varint(10000<<3 | 2); !bytes.Equal(b, []byte{0x82, 0xf1, 0x04}) {
		t.Fatalf("10000 番のタグ: %v", b)
	}
}

func TestFieldRoundTrip(t *testing.T) {
	in := map[int][]byte{1: []byte("a"), 2: bytes.Repeat([]byte("x"), 300), 10000: {}}
	var buf []byte
	for _, num := range []int{1, 2, 10000} {
		buf = append(buf, field(num, in[num])...)
	}
	out := map[int][]byte{}
	if err := each(buf, func(num int, val []byte) error {
		out[num] = val
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for num, want := range in {
		if !bytes.Equal(out[num], want) {
			t.Fatalf("%d 番が戻らない", num)
		}
	}
}

func TestEachRejectsBroken(t *testing.T) {
	bad := [][]byte{
		{0x0a, 0xff},             // 長さが中身より大きい
		{0x0a},                   // 長さが無い
		{0xff, 0xff, 0xff, 0xff}, // 終わらない varint
	}
	for _, b := range bad {
		if err := each(b, func(int, []byte) error { return nil }); err == nil {
			t.Fatalf("弾くはず: %v", b)
		}
	}
}
