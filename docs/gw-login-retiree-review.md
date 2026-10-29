# 退職者の限定ポータルへのログイン復帰

## 承認・切り分け

本人が「①すすめて」と明示承認した限定修正。PR187の新ロゴ/MVVを保持する。退職者に社内機能を開放する変更ではなく、既存の本人専用`/retiree/`へ復帰させる。API/DB/RLS/認証設定/セッション期限/テナント・role付与は変更しない。本番マージ・反映なし。

## 再確認した実契約

- `api/me.js` は `requireUserAllowLeft` を使用し、在籍照合失敗は503。退職者は `gw.left:true`、`gw.stage.key:left`、`gw.employee.status:left`、`appRole:member` と権限を削った応答。
- `api/mfa.js` は `requireUser` を使用。`lib/auth.js` が退職者を403 account_leftで拒否するため、MFAから呼ぶ旧順序では退職者の復帰まで停止した。
- `api/retiree/*` の `requireRetiree` は認証本人IDで社員を取得し全行の退職状態を照合。書類のemployee/tenant境界もサーバで維持する。UIキャッシュは権限ではない。

## 変更

1. `/api/me`を先に呼ぶ。本人ID、既存appRole、gw応答形を検証。部分的・矛盾した退職フラグは停止。
2. 3つの退職フラグが揃った場合だけ、MFAを呼ばず固定`/retiree/`へ。`next`・古いlayout/roleを使わず、member/leftの最小キャッシュだけ保存。
3. その他の正規応答は従来MFA判定を継続。未所属/旧会計環境の正規`gw.available:false`応答もMFAを省略しない。不明・失敗を「MFAなし」と扱わない。
4. MFA後は本人情報を再読取。同一ユーザー確認後に従来の行き先へ。退職へ変わっていたら限定ポータルのみ。別ユーザーなら機密入力を消しreloadし、新しいsessionをlogoutしない。
5. pagehide/storageによる旧応答抑止を維持。

## 検証

- `test/gwlogin.mjs`: 既存16件＋退職者の新規/復帰、next無視、unknown/矛盾、MFA中の退職化、別ユーザー、pagehide/storage/遅延応答 = 24件（未所属/既存roleのMFA継続と別user不正応答も含む）。
- `test/ui/retireeui.mjs`: 実契約に合わせ現役MFA応答、退職者MFA403 mock。退職者next無視/呼出なし、現役MFA呼出ありを確認。
- 既存専用CI対象`test/ui/gwloginui.mjs`: 実ブラウザで退職/現役/MFA異常/不正me/遅い退職応答/別ユーザー応答を合成データで確認するケースを追加。
- 全通信mock。実資格情報、実MFA、実DB、実退職者書類は操作しない。
- 全体CIと専用CIの最終head結果は公開後に確認。既知の全体他領域の失敗を本修正の成功と混同しない。

ローカル最終結果: npm test 206/206 PASS、gwlogin 24/24 PASS、mfatest 47/47 PASS、独立レビュー再確認で重大所見なし。
