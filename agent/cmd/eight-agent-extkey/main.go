// eight-agent-extkey — Chrome / Edge 拡張の鍵と ID を扱う。
//
// ■ なぜ要るのか
//
//	拡張の ID は、署名に使う鍵から決まる。鍵が同じなら、いつ・どこで
//	作っても同じ 32 文字になる。
//
//	その ID を3か所に焼き込んでいる:
//	  ・会社のポリシー（ExtensionInstallForcelist）
//	  ・継ぎ役の allowed_origins
//	  ・updates.xml の appid
//
//	だから ID は変わってはいけない。鍵は1本きりを作って、
//	GitHub Secrets に置く。作り直すと全PCで入れ直しになる。
//
// ■ 使い方
//
//	鍵を作る（最初の1回だけ。ふだんは Actions の
//	「EIGHT ブラウザ拡張を初期化」が呼ぶ）:
//	  go run ./cmd/eight-agent-extkey -new -out ext.pem
//
//	ID を見る:
//	  go run ./cmd/eight-agent-extkey -key ext.pem
//
//	思っている ID と合っているか確かめる（組み立てのとき）:
//	  go run ./cmd/eight-agent-extkey -key ext.pem -expect abcd...
//
//	配る形に固める:
//	  go run ./cmd/eight-agent-extkey -key ext.pem \
//	     -stamp dist/extension \
//	     -pack dist/extension -out dist/eight-ext.crx \
//	     -updates dist/updates.xml -crx-url https://mf.8grp.co.jp/ext/eight-ext.crx
//
// ■ 秘密鍵を画面に出さない
//
//	このコマンドは、どの経路でも秘密鍵そのものを表示しない。
//	Actions のログは、消せない場所に残るため。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/8grp/eight-agent/internal/crx"
)

func main() {
	var (
		newKey  = flag.Bool("new", false, "鍵を作る")
		out     = flag.String("out", "", "書き出す先（-new なら秘密鍵、-pack なら .crx）")
		keyPath = flag.String("key", "", "秘密鍵")
		expect  = flag.String("expect", "", "この ID と合っているか確かめる")
		stamp   = flag.String("stamp", "", "このフォルダの manifest.json に \"key\" を入れる")
		pack    = flag.String("pack", "", "このフォルダを .crx に固める")
		updates = flag.String("updates", "", "updates.xml の書き出し先")
		crxURL  = flag.String("crx-url", "", "updates.xml に書く .crx の置き場所")
		asJSON  = flag.Bool("json", false, "JSON で出す")
	)
	flag.Parse()

	if err := run(*newKey, *out, *keyPath, *expect, *stamp, *pack,
		*updates, *crxURL, *asJSON); err != nil {
		fmt.Fprintln(os.Stderr, "エラー:", err)
		os.Exit(1)
	}
}

func run(newKey bool, out, keyPath, expect, stamp, pack, updates, crxURL string, asJSON bool) error {
	if newKey {
		if keyPath != "" {
			return fmt.Errorf("-new と -key は一緒に使えません")
		}
		if out == "" {
			return fmt.Errorf("-out に秘密鍵の置き場所を指定してください")
		}
		// 上書きしない。作り直すと ID が変わり、全PCで入れ直しになる
		if _, err := os.Stat(out); err == nil {
			return fmt.Errorf("%s は既にあります（消してよいか確かめてから消してください）", out)
		}
		k, err := crx.NewKey()
		if err != nil {
			return err
		}
		body, err := crx.EncodeKey(k)
		if err != nil {
			return err
		}
		// 0600。ほかの人が読めるところに置かない
		if err := os.WriteFile(out, body, 0o600); err != nil {
			return err
		}
		keyPath = out
	}

	if keyPath == "" {
		return fmt.Errorf("-key に秘密鍵を指定してください（-new で作れます）")
	}
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		return fmt.Errorf("秘密鍵を読めません: %w", err)
	}
	key, err := crx.ParseKey(raw)
	if err != nil {
		return err
	}
	spki, err := crx.SPKI(key)
	if err != nil {
		return err
	}
	id := crx.ID(spki)

	// 思っている ID と違うなら、ここで止める。
	// 違うまま配ると、ポリシーに書いた ID と実物が食い違い、
	// ブラウザは何も言わずに拡張を入れない
	if expect != "" && expect != id {
		return fmt.Errorf("ID が食い違います\n  鍵から出た ID: %s\n  渡された ID  : %s\n"+
			"  → GitHub Variables の AGENT_EXT_ID を直すか、鍵を取り違えていないか確かめてください",
			id, expect)
	}

	if stamp != "" {
		if err := stampManifest(stamp, spki); err != nil {
			return err
		}
	}

	var crxPath string
	var extVersion string
	if pack != "" {
		if out == "" || newKey {
			return fmt.Errorf("-pack には -out（.crx の書き出し先）が要ります")
		}
		zipped, err := crx.Zip(pack)
		if err != nil {
			return err
		}
		body, err := crx.Pack(zipped, key)
		if err != nil {
			return err
		}
		// 作ったものを、その場で読み直す。
		// 読めないものを配ると、入れた先で黙って失敗する
		got, err := crx.Verify(body)
		if err != nil {
			return fmt.Errorf("作った .crx を自分で読めませんでした: %w", err)
		}
		if got != id {
			return fmt.Errorf("作った .crx の ID が違います: %s != %s", got, id)
		}
		if err := os.WriteFile(out, body, 0o644); err != nil {
			return err
		}
		crxPath = out
		extVersion, err = versionOf(pack)
		if err != nil {
			return err
		}
	}

	if updates != "" {
		if crxURL == "" {
			return fmt.Errorf("-updates には -crx-url が要ります")
		}
		if extVersion == "" {
			if extVersion, err = versionOf(pack); err != nil {
				return fmt.Errorf("-updates には -pack が要ります（版を manifest.json から取るため）")
			}
		}
		if err := writeUpdates(updates, id, extVersion, crxURL); err != nil {
			return err
		}
	}

	if asJSON {
		b, _ := json.Marshal(map[string]string{
			"id": id, "manifest_key": crx.ManifestKey(spki),
			"crx": crxPath, "version": extVersion,
		})
		fmt.Println(string(b))
		return nil
	}

	fmt.Printf("拡張の ID   %s\n", id)
	if newKey {
		fmt.Printf("秘密鍵      %s （0600。Git に入れない、人に渡さない）\n", keyPath)
	}
	if crxPath != "" {
		fmt.Printf("crx         %s （版 %s）\n", crxPath, extVersion)
	}
	if updates != "" {
		fmt.Printf("updates.xml %s\n", updates)
	}
	return nil
}

// versionOf は、manifest.json の version を読む。
// updates.xml と .crx で版が食い違うと、ブラウザが更新に気づかない
func versionOf(dir string) (string, error) {
	if dir == "" {
		return "", fmt.Errorf("フォルダが指定されていません")
	}
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return "", err
	}
	var m struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return "", fmt.Errorf("manifest.json を読めません: %w", err)
	}
	if m.Version == "" {
		return "", fmt.Errorf("manifest.json に version がありません")
	}
	return m.Version, nil
}

var keyLine = regexp.MustCompile(`(?m)^\s*"key"\s*:\s*"[^"]*"\s*,?\s*\n`)

// stampManifest は、manifest.json に "key" を入れる。
//
// これが入っていると、.crx にせず「パッケージ化されていない拡張機能を
// 読み込む」で入れたときも同じ ID になる。入ったか確かめるときに要る。
//
// 中身を JSON として組み直すと並びが変わって差分が読めなくなるので、
// 頭に1行足すだけにしてある
func stampManifest(dir string, spki []byte) error {
	path := filepath.Join(dir, "manifest.json")
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	s := string(b)

	// 既に入っていれば、いったん外してから入れ直す。
	// 古い鍵のものが残っていると、ブラウザが .crx を受け取らない
	s = keyLine.ReplaceAllString(s, "")

	i := strings.Index(s, "{")
	if i < 0 {
		return fmt.Errorf("%s が JSON に見えません", path)
	}
	line := fmt.Sprintf("\n  \"key\": %q,", crx.ManifestKey(spki))
	s = s[:i+1] + line + s[i+1:]

	// 組み直したものが JSON として読めるか。読めないものを配らない
	var probe map[string]any
	if err := json.Unmarshal([]byte(s), &probe); err != nil {
		return fmt.Errorf("manifest.json を壊しました: %w", err)
	}
	if probe["key"] != crx.ManifestKey(spki) {
		return fmt.Errorf("manifest.json に key が入りませんでした")
	}
	return os.WriteFile(path, []byte(s), 0o644)
}

// writeUpdates は、ブラウザが更新を見にくる updates.xml を書く
func writeUpdates(path, id, version, url string) error {
	if !crx.ValidID(id) {
		return fmt.Errorf("ID の形が違います: %q", id)
	}
	body := fmt.Sprintf(`<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='%s'>
    <updatecheck codebase='%s' version='%s' />
  </app>
</gupdate>
`, id, escapeXML(url), escapeXML(version))
	return os.WriteFile(path, []byte(body), 0o644)
}

// escapeXML は、属性に入れてよい形にする。
// & や ' がそのまま入ると、ブラウザが XML を読めずに更新が止まる
func escapeXML(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")
	return r.Replace(s)
}
