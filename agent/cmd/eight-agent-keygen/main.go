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
//	     -locator 0.3.0/EIGHT-Agent-Setup.exe \
//	     -file dist/EIGHT-Agent-Setup.exe
//	    → そのまま流せる insert 文が出る
//
//	■ 署名の対象は「置き場所」
//
//	  配布物は非公開のバケットに置き、落とすURLはそのつど短時間だけ作る。
//	  毎回変わるURLに署名しても合わないので、変わらないほう
//	  （バケットの中のパス）に署名する。
//	  外の場所に置く版は -url を使う。そのときは URL が置き場所になる。
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
		url     = flag.String("url", "", "外に置く場合の配布先URL（https のみ）")
		locator = flag.String("locator", "", "Storage に置く場合のパス（例 0.3.0/EIGHT-Agent-Setup.exe）")
		file    = flag.String("file", "", "配るファイル（ここから SHA256 と大きさを取る）")
		asJSON  = flag.Bool("json", false, "JSON で出す")
	)
	flag.Parse()

	var err error
	switch {
	case *newKey:
		err = generate(*out, *asJSON)
	default:
		err = sign(*keyPath, *version, *url, *locator, *file, *asJSON)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "エラー:", err)
		os.Exit(1)
	}
}

// ---- 鍵を作る ---------------------------------------------------------------

func generate(out string, asJSON bool) error {
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

	// 秘密鍵は、どちらの出し方でも表に出さない。
	// 画面に出したものは、そのままログに残るため
	if asJSON {
		fmt.Printf("{\"public_key\":%q,\"key_id\":%q,\"path\":%q}\n",
			base64.RawURLEncoding.EncodeToString(pub), release.KeyID(pub), out)
		return nil
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

func sign(keyPath, version, url, locator, file string, asJSON bool) error {
	switch {
	case keyPath == "":
		return fmt.Errorf("-key に秘密鍵を指定してください（-new で作れます）")
	case version == "" || file == "":
		return fmt.Errorf("-version と -file が要ります")
	case url == "" && locator == "":
		return fmt.Errorf("-locator（Storage のパス）か -url のどちらかが要ります")
	case url != "" && !strings.HasPrefix(strings.ToLower(url), "https://"):
		// 平文で配ったものは、エージェント側でも弾く。ここで気づけるように
		return fmt.Errorf("-url は https から始めてください")
	}

	// 署名の対象は「置き場所」。
	// 非公開の置き場から落とすURLは、そのつど短命のものを作るので毎回変わる。
	// 変わるものに署名しても合わない
	at := locator
	if at == "" {
		at = url
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

	sig := release.Sign(priv, version, at, sum, size)
	keyID := release.KeyID(priv.Public().(ed25519.PublicKey))

	// 自分で作った署名が、自分で確かめて通るか。
	// 通らないものを管理画面に貼ってしまうと、全台が黙って更新されなくなる
	in := release.Info{
		Version: version, URL: url, Locator: locator, SHA256: sum,
		SizeBytes: size, Signature: sig, KeyID: keyID,
	}
	// 落とす先は、Storage なら実行のたびに作られる。
	// ここでは形だけ通せばよいので、仮のURLで確かめる
	if in.URL == "" {
		in.URL = "https://example.invalid/" + locator
	}
	pub := base64.RawURLEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
	if err := release.Verify(pub, in); err != nil {
		return fmt.Errorf("作った署名が自分で通りませんでした: %w", err)
	}

	if asJSON {
		fmt.Printf(`{"version":%q,"object_path":%q,"url":%q,"sha256":%q,`+
			`"size_bytes":%d,"signature":%q,"key_id":%q}`+"\n",
			version, locator, url, sum, size, sig, keyID)
		return nil
	}

	where := "URL       " + url
	if locator != "" {
		where = "置き場所   agent/" + locator
	}
	fmt.Printf(`gw_device_releases に、そのまま入れてください。

  版        %s
  %s
  SHA-256   %s
  大きさ     %d
  署名      %s
  鍵の目印   %s

  insert into public.gw_device_releases
    (tenant_id, version, bucket, object_path, url, sha256, size_bytes,
     signature, key_id, published)
  values
    ('<テナントのUUID>', %s, %s, %s, %s, %s, %d, %s, %s, true);

このあと:
  ・%s を置き場所に上げる
  ・署名かハッシュが合わなければ、エージェントは実行しません
`, version, where, sum, size, sig, keyID,
		sqlVal(version), sqlVal(bucketOf(locator)), sqlVal(locator), sqlVal(url),
		sqlVal(sum), size, sqlVal(sig), sqlVal(keyID), file)
	return nil
}

func bucketOf(locator string) string {
	if locator == "" {
		return ""
	}
	return "agent"
}

// sqlVal は、空なら null。貼ってそのまま流せるように
func sqlVal(s string) string {
	if s == "" {
		return "null"
	}
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
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
