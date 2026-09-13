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

### 4-1. 鍵を作って ID を決める

```
# 1回だけ。この鍵は社外に出さない。無くすと ID が変わり、入れ直しになる
openssl genrsa -out eight-ext.pem 2048
```

Chrome で `chrome://extensions` →「デベロッパーモード」→「拡張機能をパッケージ化」
で `dist/extension/` とこの鍵を指定すると `.crx` ができ、**32文字の ID** が決まる。

### 4-2. 置き場所を用意する

`mf.8grp.co.jp/ext/` に2つ置く。

- `eight-ext.crx`
- `updates.xml`

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='ここに32文字のID'>
    <updatecheck codebase='https://mf.8grp.co.jp/ext/eight-ext.crx' version='1.0.0' />
  </app>
</gupdate>
```

> 版を上げるときは `.crx` と `updates.xml` の `version` を両方直す。
> 片方だけ直すと、ブラウザが更新に気づかない。

### 4-3. ID を入れて組み直す

```
EXT_ID=ここに32文字のID ./build.sh
```

ID を入れずに組んでも、インストーラは入る。
ただしブラウザ連携（WEB利用）だけ設定されない。
PC側の記録（起動終了・ソフト・USB・離席）は、拡張が無くても動く。

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

3が「未連携」のままなら、継ぎ役が呼べていない。
`HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\jp.co.eightgrp.agent` と、
そこが指す JSON の `path` を確かめること。

## 6. Firefox / Brave / Opera

いまは対象にしていない。Firefox はポリシーの仕組みが違い、
Brave と Opera は Chrome のポリシーをそのまま読まない。

これらが入っているPCでは、管理画面に「未導入」と出る。
サイトの記録は取れないが、PC側（起動終了・アプリ・USB）は今までどおり動く。
