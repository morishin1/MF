# 二段階認証の登録画面（QR コード）

`mypage.html#mfa` の「登録を始める」で、QR コードが画像欠落アイコンになる不具合の原因と、直し方の記録。

## 不具合の原因

- サーバ（`api/mfa.js`）は Supabase Auth（GoTrue）の REST `POST /auth/v1/factors` を**直接**呼ぶ。
- GoTrue の応答の `totp.qr_code` は、`<?xml …><svg …>` の**生の SVG 文字列**（GoTrue のソース `internal/api/mfa.go` の `QRCode: buf.String()`）。
- 公式クライアント（`@supabase/auth-js`）は、その先頭に `data:image/svg+xml;utf-8,` を**付け足してから**返す（`GoTrueClient.ts` の `_enroll`）。REST を直接呼ぶこのアプリは付け足しておらず、`<img src="<?xml …">` が不正な URL になって、画像欠落アイコンになっていた。
- 手入力キー（`secret`）と 6 桁の入力欄は、QR とは別の値なので、正常に出ていた。
- 導入は `e83d9d1`（2026-09-24）。`main` にあった不具合で、PR #39・#46 は関係しない。
- CSP は、リポジトリにも `vercel.json` にも設定がない。

再現: 生の SVG（GoTrue の応答そのまま）を `<img src>` に入れると `naturalWidth=0`（画像欠落）、`data:image/svg+xml;utf-8,` を付けると 120 になる（実ブラウザで確認）。

## 直し方

1. **QR は、ブラウザの中だけで作る**（`js/qr.js`）。GoTrue の SVG の形（プレフィックスの有無）に頼らず、`uri`（`otpauth://…`）から、同梱のライブラリ（`js/vendor/qrcode-generator.js`、MIT）で作る。
   - **外部の QR 生成サービス（Google Chart API など）へは、秘密の情報を送らない。**
   - 画面には、`<img>` ではなく**インライン SVG** で出す（外部の画像・`data:` の画像が CSP で止まっても影響しない）。
   - **UTF-8 で符号化**する（同梱ライブラリの既定は ISO-8859-1 で、日本語を壊す）。日本語・記号を含む issuer・アカウント名でも読み取れる。
   - **登録を始めたときだけ読み込む**（`mypage.html` の `loadQr()`）。ふだんのマイページでは、56KB のライブラリを読まない。版（`?v=`）は、同じページの `js/layout.js` と同じものを使う（サイト全体で版を1つにそろえる決まり `test/speedcheck.mjs` のため、QR まわりに版の文字列を書かない）。読み込めなければ、手入力の案内に切り替える。
2. **サーバは `{ id, totp: { secret, uri } }` だけを返す**（`lib/mfa.js` の `enrollBody`）。GoTrue の `qr_code` は渡さない。応答には `Cache-Control: no-store`。応答が欠けたら、内容を出さずに 502。
3. **QR を作れないとき**は、画像欠落アイコンを出さず、「QRコードを表示できませんでした。下のセットアップキーを認証アプリに手入力してください。」を出し、手順を手入力向けにする。次のとき、QR を作らずこの案内にする:
   - URI が長すぎて QR に入らない／`uri` が無い／`otpauth://totp/` の形ではない
   - `uri` の secret が、手入力キーと食い違う（QR で登録すると 6 桁が合わなくなるため）
   - `js/qr.js` が読み込めない
4. 通常時は QR を第一手段とし、QR の下に「Google Authenticator / Microsoft Authenticator などで読み取ってください」を出す。

## 秘密の情報の扱い（守ること）

秘密の情報 = セットアップキー（`secret`）・`otpauth://` の URI・QR の画像。

- `console.*` に出さない（QR が作れなかったときのログは、固定の1行だけ。URI・例外の中身は出さない）
- サーバのログ・監査ログに入れない（`mfa.enroll_start` の detail は `factorId` だけ）
- エラーの応答に入れない（GoTrue の応答本文をそのまま返さない）
- URL（クエリ）に載せない。GoTrue への通信も、秘密の情報は本文だけ
- 外部のサービスへ送らない（`js/qr.js` に `fetch`・外部 URL・`console` が無いことを、テストが静的に確認する）
- 登録が済むと、画面（DOM）からセットアップキーも QR も消える（マイページの再描画）

**すでに画面共有・スクリーンショットなどで秘密の情報が見えてしまった場合**は、その登録を使い続けない。登録済みなら「登録を外す」→「登録を始める」で、新しい秘密鍵で登録し直す（登録は毎回、新しい鍵になる）。

## 同梱ライブラリ

`js/vendor/README.md`（出どころ・版・ライセンス・SHA-256）。差し替えるときは、SHA-256 を直し、`test/qrcode.mjs` と `test/ui/mfaenrollui.mjs` を通す。

## テスト

| ファイル | 内容 |
|---|---|
| `test/qrcode.mjs` | 作った QR を jsQR で読み取り、元の URI に戻る（日本語・記号・長い URI）／SVG の安全性／例外に URI が入らない／ログ・通信なし／同梱ライブラリの SHA-256 |
| `test/mfaenrollapi.mjs` | 応答は `{id, totp:{secret, uri}}` だけ・`no-store`・URI の形・毎回新しい鍵・6 桁の成功／失敗・登録済み・欠けた応答・**ログ／監査／URL／エラーに秘密の情報が出ない** |
| `test/ui/mfaenrollui.mjs` | 実ブラウザで、登録の最後まで（QR 表示→**画面の QR を読み取り**→otpauth の secret と手入力キーが一致→6 桁計算→登録→「登録済み」→再読み込み）。QR を作れない 5 パターンの代替表示、欠けた応答、PC／390px／360px |
| `test/fixtures/totp.mjs` | RFC 6238 の TOTP と、GoTrue の模擬（応答は実物の形＝生の SVG） |

実際の認証アプリでの確認は、Supabase の本番プロジェクトが必要なので、テストでは行えない。テストは、認証アプリの代わりに、画面に描画された QR を ZXing・OpenCV・jsQR の 3 つのデコーダで読み取り、その secret から計算した 6 桁で登録まで通している。
