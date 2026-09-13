# EIGHT Agent を配るまで

**自分のパソコンには何も入れません。** Go も Git Bash も OpenSSL も要りません。
組み立ては GitHub Actions が行います。

---

## 1. 組み立てる（GitHub Actions）

```
GitHub → Actions → 「EIGHT Agent を組み立てる」→ Run workflow
  版: 0.3.0
  → Run workflow を押す
```

3〜5分で終わります。終わったら、そのページの下にある **Artifacts** から落とせます。

| 落ちてくるもの | 中身 |
|---|---|
| `EIGHT-Agent-Setup-0.3.0` | `EIGHT-Agent-Setup.exe` と、ブラウザ拡張一式 |
| `release-0.3.0` | SHA-256 と、次の手順で使う値 |

実行結果のページ（Summary）に、版・大きさ・SHA-256 が表で出ます。次で使います。

### 先に決めておく設定

GitHub → Settings → Secrets and variables → Actions → **Variables**

| 名前 | 中身 | 空だとどうなるか |
|---|---|---|
| `AGENT_EXT_ID` | ブラウザ拡張のID（32文字） | ブラウザ連携（WEB利用）が入らない |
| `AGENT_UPDATE_KEY` | 更新を確かめる**公開**鍵 | エージェントが自動更新をしない |
| `AGENT_BASE_URL` | 省略可（既定 `https://mf.8grp.co.jp`） | 既定を使う |

どれも秘密ではありません（**秘密鍵は入れません**）。
空のままでも組み立ては通り、Actions の画面に警告が出ます。

拡張のIDの出し方は `agent/extension/README.md`、
更新用の鍵の作り方は `docs/device-zero-cost.md` にあります。

---

## 2. 置く（Supabase Storage）

```
Supabase → Storage → agent バケット
  → 0.3.0/ というフォルダを作る
  → EIGHT-Agent-Setup.exe を上げる
```

置き場所は `agent/0.3.0/EIGHT-Agent-Setup.exe` になります。
**バケットは非公開のままにしてください。** 落とすときは、
サーバが5分だけ有効なURLをそのつど作ります。

---

## 3. 署名して登録する

更新で配るものは、社内の鍵で署名します。署名かハッシュが合わないものを
エージェントは実行しません（`docs/device-zero-cost.md`）。

いまはこの手順だけ、鍵を持っている人の手元で行います。

```
cd agent
go run ./cmd/eight-agent-keygen \
   -key <秘密鍵> \
   -version 0.3.0 \
   -locator 0.3.0/EIGHT-Agent-Setup.exe \
   -file <落としてきた EIGHT-Agent-Setup.exe>
```

そのまま流せる `insert` 文が出るので、Supabase の SQL Editor に貼って実行します。
`<テナントのUUID>` だけ埋めてください。

> **上げたファイルと、署名したファイルが同じものか確かめてください。**
> `release-0.3.0` に入っている SHA-256 と、keygen が出す SHA-256 が
> 一致していれば同じものです。

---

## 4. 確かめる

```sql
select version, bucket, object_path, size_bytes, key_id, published
  from public.gw_device_releases order by created_at desc limit 3;
```

そのあと、社員のマイページ →「会社PCのセキュリティ設定」→
「この会社PCを設定する」で落ちてくれば通っています。

---

## まだ自動になっていないところ

| | いま | 自動にするのに要るもの |
|---|---|---|
| 1 組み立て | **Actions** | — |
| 2 Storage へ上げる | 人 | `SUPABASE_URL` と service_role の鍵 |
| 3 署名 | 人 | 更新用の**秘密**鍵 |
| 4 DB へ登録 | 人 | 2 と同じ鍵 |

2〜4 を Actions に寄せると、**service_role の鍵と更新用の秘密鍵を
GitHub に置く**ことになります。

- service_role の鍵は、持っていれば全テーブルを読み書きできます
- 更新用の秘密鍵は、持っていれば全台に配る版を署名できます

どちらも「便利だから置く」で決めてよいものではありません。
置くなら、次を決めてからにしてください。

- Environment の承認を挟むか（誰かが承認しないと動かない形にできます）
- 誰がワークフローを実行できるか（リポジトリの権限そのもの）
- 鍵を替えるときの手順

決まれば、`.github/workflows/agent-build.yml` の末尾にコメントで書いてある
5〜7 を足します。

---

## 困ったとき

| 症状 | 見るところ |
|---|---|
| 組み立てが赤くなる | Actions のログ。単体テストと `go vet` も走るので、そこで落ちていることが多い |
| `EXT_ID が空です` の警告 | Variables の `AGENT_EXT_ID`。空でも組めるが、ブラウザ連携は入らない |
| `UPDATE_KEY が空です` の警告 | Variables の `AGENT_UPDATE_KEY`。空だと自動更新をしない |
| 落としても EXE が無い | Artifacts は14日で消えます。組み直してください |
| 社員の画面で落とせない | `gw_device_releases` に `published = true` の行があるか |
