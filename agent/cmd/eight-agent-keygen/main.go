// eight-agent-keygen — 更新ファイルに署名するための、社内用の鍵。
//
// ■ これは何の代わりか
//
//	商用のコード署名証明書は買わない。
//	そのぶん「配っているEXEが、うちが作ったものか」を自分で確かめる。
//
//	Windows の SmartScreen は、これでは黙らない（初回に警告が出る）。
//	黙らせるためのものではなく、**自動更新で変なものを実行しない**ためのもの。
//
// ■ 使い方
//
//	鍵を作る（最初の1回だけ）:
//	  go run ./cmd/eight-agent-keygen -new -out ~/eight-update.key
//	    → 公開鍵が出る。build.sh の UPDATE_KEY に入れる
//	    → 秘密鍵は ~/eight-update.key。リポジトリに入れない
//
//	リリースに署名する（版を配るたび）:
//	  go run ./cmd/eight-agent-keygen \
//	     -key ~/eight-update.key \
//	     -version 0.3.0 \
//	     -url https://mf.8grp.co.jp/agent/EIGHT-Agent-Setup.exe \
//	     -file dist/EIGHT-Agent-Setup.exe
//	    → 版・URL・SHA256・大きさ・署名・鍵の目印 が出る
//	    → そのまま管理画面の「端末管理 → 配布」に貼る
//
// ■ 秘密鍵の置き場所
//
//	社内の1人が持つ1本だけ。Git に入れない、Slack に貼らない。
//	無くしたら新しい鍵を作り、build.sh の公開鍵を入れ替えて
//	エージェントを配り直す（古い鍵で署名した版は通らなくなる）。
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/8grp/eight-agent/internal/release"
)

func main() {
	var (
		newKey  = flag.Bool("new", false, "鍵を作る")
		out     = flag.String("out", "", "作った秘密鍵の置き場所")
		keyPath = flag.String("key", "", "署名に使う秘密鍵")
		version = flag.String("version", "", "配る版（例 0.3.0）")
		url     = flag.String("url", "", "配布先のURL（https のみ）")
		file    = flag.String("file", "", "配るファイル（ここから SHA256 と大きさを取る）")
		asJSON  = flag.Bool("json", false, "JSON で出す")
	)
	flag.Parse()

	var err error
	switch {
	case *newKey:
		err = generate(*out)
	default:
		err = sign(*keyPath, *version, *url, *file, *asJSON)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "エラー:", err)
		os.Exit(1)
	}
}

// ---- 鍵を作る ---------------------------------------------------------------

func generate(out string) error {
	if out == "" {
		return fmt.Errorf("-out に秘密鍵の置き場所を指定してください")
	}
	// 上書きしない。既にある鍵を潰すと、配った全台が更新できなくなる
	if _, err := os.Stat(out); err == nil {
		return fmt.Errorf("%s は既にあります（消してよいか確かめてから消してください）", out)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	// 0600。他の人が読めるところに置かない
	body := base64.RawURLEncoding.EncodeToString(priv) + "\n"
	if err := os.WriteFile(out, []byte(body), 0o600); err != nil {
		return err
	}

	fmt.Printf(`鍵を作りました。

  秘密鍵: %s （0600。Git に入れない、人に渡さない）
  公開鍵: %s
  目印  : %s

次にやること:

  1. build.sh に渡す公開鍵として控える
       UPDATE_KEY=%s ./build.sh
  2. 秘密鍵は、社内で1人が持つ場所へ移す
  3. この鍵で署名していない更新ファイルは、エージェントが実行しません
`, out, base64.RawURLEncoding.EncodeToString(pub), release.KeyID(pub),
		base64.RawURLEncoding.EncodeToString(pub))
	return nil
}

// ---- 署名する ---------------------------------------------------------------

func sign(keyPath, version, url, file string, asJSON bool) error {
	switch {
	case keyPath == "":
		return fmt.Errorf("-key に秘密鍵を指定してください（-new で作れます）")
	case version == "" || url == "" || file == "":
		return fmt.Errorf("-version, -url, -file の3つが要ります")
	case !strings.HasPrefix(strings.ToLower(url), "https://"):
		// 平文で配ったものは、エージェント側でも弾く。ここで気づけるように
		return fmt.Errorf("-url は https から始めてください")
	}

	priv, err := readKey(keyPath)
	if err != nil {
		return err
	}

	sum, size, err := hashFile(file)
	if err != nil {
		return err
	}
	if size > release.MaxSize {
		return fmt.Errorf("ファイルが大きすぎます（%d バイト、上限 %d）", size, release.MaxSize)
	}

	sig := release.Sign(priv, version, url, sum, size)
	keyID := release.KeyID(priv.Public().(ed25519.PublicKey))

	// 自分で作った署名が、自分で確かめて通るか。
	// 通らないものを管理画面に貼ってしまうと、全台が黙って更新されなくなる
	in := release.Info{
		Version: version, URL: url, SHA256: sum,
		SizeBytes: size, Signature: sig, KeyID: keyID,
	}
	pub := base64.RawURLEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
	if err := release.Verify(pub, in); err != nil {
		return fmt.Errorf("作った署名が自分で通りませんでした: %w", err)
	}

	if asJSON {
		fmt.Printf(`{"version":%q,"url":%q,"sha256":%q,"size_bytes":%d,"signature":%q,"key_id":%q}`+"\n",
			version, url, sum, size, sig, keyID)
		return nil
	}
	fmt.Printf(`管理画面の「端末管理 → 配布」に、そのまま貼ってください。

  版        %s
  URL       %s
  SHA-256   %s
  大きさ     %d
  署名      %s
  鍵の目印   %s

このあと:
  ・%s を上のURLに置く
  ・管理画面で「公開する」に変える
  ・署名かハッシュが合わなければ、エージェントは実行しません
`, version, url, sum, size, sig, keyID, file)
	return nil
}

func readKey(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("秘密鍵を読めません: %w", err)
	}
	s := strings.TrimSpace(string(b))
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		raw, err = base64.URLEncoding.DecodeString(s)
	}
	if err != nil {
		return nil, fmt.Errorf("秘密鍵の形が違います: %w", err)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("秘密鍵の長さが違います: %d バイト", len(raw))
	}
	return ed25519.PrivateKey(raw), nil
}

func hashFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, fmt.Errorf("配るファイルを開けません: %w", err)
	}
	defer f.Close()

	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	if n == 0 {
		return "", 0, fmt.Errorf("中身が空です: %s", path)
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
