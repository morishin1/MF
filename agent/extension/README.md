# EIGHT 端末管理 拡張（Chrome / Edge）

ブラウザで「どのサイトをどれだけ見ていたか」を数える。
数えた結果は、このパソコンの中の EIGHT Agent へ渡す。**サーバへは直接つながない。**

社員がこれを自分で入れることはない。`EIGHT-Agent-Setup.exe` が
会社のポリシーとして入れるので、社員から見ればインストーラ1本で終わる。

---

## 1. 読める場所を持たない

`manifest.json` の権限が、そのまま「何ができるか」の上限になる。

| 持っていない権限 | だから、できないこと |
|---|---|
| `host_permissions`（空） | どのページにもコードを差し込めない |
| `content_scripts`（無し） | ページの中身・フォーム・パスワードが読めない |
| `cookies` | Cookie とログインの鍵が読めない |
| `webRequest` | 通信の中身が読めない |
| `history` | 閲覧履歴の全文が読めない |
| `scripting` | あとからコードを差し込むこともできない |
| `tabCapture` / `pageCapture` / `desktopCapture` | 画面もページも取れない |

持っているのは `tabs` `idle` `alarms` `nativeMessaging` の4つだけ。
`tabs` はアドレスを読むために要るが、読んだ先は `keep()` 1か所に集めてあり、
そこで**ドメインとパスだけに削ってから**外へ出す。

`agent/internal/collect/extension_test.go` が、この表と実装を突き合わせている。
危ない権限を足すと **テストが落ちる**。足すときは、先に

1. 本人への告知（`api/devices/me.js` の `AGENT_NOTICE`）
2. 就業規則・端末管理規程

を直すこと。順番を逆にしない。

## 2. URL をどう削るか

```
https://www.google.com/search?q=転職 エージェント#top
        └────────┬────────┘└──┬──┘└──────┬──────┘└┬┘
              ドメイン      パス      ここは捨てる  捨てる
                ↓            ↓
          google.com      /search
```

- `?` から後ろ … 検索語・メールアドレス・一度きりの鍵が入る。**必ず捨てる**
- `#` から後ろ … 同上
- パスの区切りが一度きりのリンクに見えるとき（`/reset/9f3c8a2b…`）は `…` に伏せる
- 区切りは6つまで、全体で120文字まで

同じ削り方を3か所でやっている。どれか1つが緩んでも、次で止まる。

| どこ | 実装 |
|---|---|
| 拡張（いちばん手前） | `background.js` の `keep()` / `pathOf()` |
| 継ぎ役 | `cmd/eight-agent-host/main.go` の `sane()` |
| 常駐ソフト | `internal/collect/category.go` の `HostOnly()` / `PathOnly()` |
| サーバ（最後） | `lib/devices.js` の `cleanHost()` / `cleanPath()` |

## 3. 数え方

- 前面のウィンドウの、選ばれているタブだけ
- 何も触らなくなったら（既定5分）止める
- 1つの滞在は30分で区切る（開きっぱなしのタブを1件にしない）
- 1分ごとに、溜めたぶんを継ぎ役へ渡す
- 渡せなかったら溜めたまま。次に回す（最大500件）

「開いていた」ではなく「見ていた」を数える。裏のタブは数えない。

## 4. 配る手順

社員に入れさせないので、**会社のポリシーで強制的に入れる**形にする。

### 4-1. 鍵を作って ID を決める（最初の1回だけ）

**自分のパソコンには何も入れません。** GitHub Actions でやります。

```
GitHub → Actions → 「EIGHT ブラウザ拡張を初期化」→ Run workflow
  確認の欄に INIT と入れて実行
```

終わると、画面に **32文字の ID** が出ます。Artifacts から鍵を落として、
2つ登録すれば終わりです。

| どこ | 名前 | 中身 |
|---|---|---|
| Variables | `AGENT_EXT_ID` | 出てきた32文字 |
| Secrets | `AGENT_EXT_KEY` | `eight-ext.pem` の中身を丸ごと |

登録したら、**Artifact を消してください**（このリポジトリを読める人なら
誰でも落とせるため）。消し忘れても1日で消えます。

> **この鍵は作り直さないでください。**
> ID は鍵から決まります。鍵を替えると ID が変わり、配ったパソコン全部で
> 拡張が入れ直しになります。

<details>
<summary>手元でやる場合（ふだんは要りません）</summary>

```
cd agent
go run ./cmd/eight-agent-extkey -new -out eight-ext.pem   # 鍵を作る
go run ./cmd/eight-agent-extkey -key eight-ext.pem        # ID を見る
```
</details>

### 4-2. 組み立てる

```
GitHub → Actions → 「EIGHT Agent を組み立てる」→ Run workflow
```

4-1 が済んでいれば、これだけで次の3つができます。

| できるもの | 何か |
|---|---|
| `EIGHT-Agent-Setup.exe` | 社員に配る1本。拡張の ID が焼き込まれている |
| `eight-ext.crx` | ブラウザに入る拡張 |
| `updates.xml` | ブラウザが更新を見にくる先 |

**ID は鍵から決まります。** `AGENT_EXT_ID` も入っていれば突き合わせて、
食い違っていたらそこで止まります（書き写しの間違いを配らないため）。

ID も鍵も無いまま組んでも、インストーラは入ります。
ただしブラウザ連携（WEB利用）だけ設定されません。
PC側の記録（起動終了・ソフト・USB・離席）は、拡張が無くても動きます。

### 4-3. 置き場所を用意する

`mf.8grp.co.jp/ext/` に2つ置く。組み立てで出てきたものをそのまま置くだけ。

- `eight-ext.crx`
- `updates.xml`

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='（鍵から決まった32文字）'>
    <updatecheck codebase='https://mf.8grp.co.jp/ext/eight-ext.crx' version='1.0.0' />
  </app>
</gupdate>
```

> 版を上げるときは `manifest.json` の `version` を直してから組み直す。
> `updates.xml` の版は、そこから自動で入る。

### 4-4. 配り方（商用のコード署名証明書は使わない）

コード署名証明書は買わない。MDM も要らない。1台ごとの利用料もない。
社内PCへ配るだけなので、これでよいと決めた。→ `docs/device-zero-cost.md`

そのぶん、初回に Windows の警告（SmartScreen）が出る。
社員に「警告を無視して実行してください」と覚えさせるのは
社内のセキュリティ教育として逆効果なので、**最初の1回は管理者か社内IT担当が、
対象PCの前で入れる**。社員が押すのは、そのあとブラウザに出る
「このパソコンです」だけ。

2回目からは自動更新で入れ替わる。落としたEXEをそのまま実行するのではなく、
社内の鍵（Ed25519）で署名した版だけを実行する。
署名かハッシュが合わなければ、実行せずに捨てる。

> 将来、証明書を用意したくなったら `signtool` を足せばよい。
> 署名は「必須」ではなく「足せる」。無いことを理由に、組み立ても
> インストールも止めない作りにしてある。

## 5. 入ったか確かめる

配ったあと、そのPCで:

1. `chrome://policy` を開く → `ExtensionInstallForcelist` に ID が出ている
2. `chrome://extensions` → 「EIGHT 端末管理」が**削除できない状態**で入っている
3. 管理画面の端末管理 → そのPCの行に **Chrome ●連携済** が出る

`manifest.json` の `icons` に書いたファイルが1つでも欠けていると、
ブラウザは拡張を**まるごと**受け取らない（固めることすらできない）。
`internal/crx` がそれを見ていて、欠けていれば組み立てが止まる。

> `icon128.png` は `img/logo.svg` から起こしたもの。
> 正式なロゴに差し替えるときは、こちらも作り直すこと。

3が「未連携」のままなら、継ぎ役が呼べていない。
`HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\jp.co.eightgrp.agent` と、
そこが指す JSON の `path` を確かめること。

## 6. Firefox / Brave / Opera

いまは対象にしていない。Firefox はポリシーの仕組みが違い、
Brave と Opera は Chrome のポリシーをそのまま読まない。

これらが入っているPCでは、管理画面に「未導入」と出る。
サイトの記録は取れないが、PC側（起動終了・アプリ・USB）は今までどおり動く。
