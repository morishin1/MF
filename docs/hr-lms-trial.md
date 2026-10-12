# 採用HR × 無限道場 体験（面談のお礼＋体験URL・体験状況）

カジュアル面談のあと、応募者へ「面談のお礼＋無限道場 体験のご案内」を**1通**送り、無限道場（LMS・eight-its/lms）での体験の進み具合を応募者ドロワーで見る。

- 画面：応募者ドロワーの概要タブ、NEXT ACTION の下の「無限道場 体験」（`js/hr-lms-trial.js`）
- API：`api/hr/applicants/lms-trial.js`（採用HRを使える人だけ。無限道場を運営する会社＝`HR_LEAD_TENANT_ID` だけ）
- LMS 側の仕様：eight-its/lms `v3-next/docs/hr-lms-api.md`（`trial-invite` の `send_mail:false` は eight-its/lms#364）
- DB の変更なし（送った記録は db/124 の `gw_hr_mail_sends` を使う）

## 流れ

1. カジュアル面談を実施済みにする（`gw_hr_interviews.kind='casual'`・`conducted_at` あり・キャンセルでない）
2. ［お礼＋無限道場体験を案内］→ 文面を確かめる・直す → 送信
3. サーバーが LMS の `trial-invite`（`action:"issue"`・`send_mail:false`）で本人専用の招待URLを受け取り、本文の `{{無限道場体験URL}}` と `{{体験URLの有効期限}}` に入れて、MF のメール送信（Resend）で1通送る
   - LMS からはメールを送らない（本人に2通届かない）
   - 有効な招待があれば LMS は同じものを返す（reused）。送り直しても招待は増えない
4. 本人が URL から `/mgn/register` で登録 → 45分体験
5. ドロワーを開くと、LMS の `trial-status` をその場で読む（HR には保存しない）

## 二重送信を防ぐ

- 送信の鍵（requestKey）：二度押し・通信のやり直しでは送らず、1回目の結果を返す
- このご案内を送った（送信中・結果不明を含む）記録があれば、［再送する］（`resend:true`）を選んだときだけ送る
- メールが失敗（failed）なら、もう一度送れる（同じ招待URL）
- LMS に登録済みのメールには送らない（409。ログインして体験版を開くよう案内する）

## 残さないもの

招待URL（トークン）・秘密は、送信記録の本文（URL を伏せて保存）・タイムライン・監査ログ・ログに残さない。［URLをコピー］は担当者が手で渡すときだけ使い、画面にも記録にも残さない。

## 体験状況

| 段階 | 条件（LMS の trial-status） |
|---|---|
| 未招待 | 招待なし |
| 招待済み／招待の期限切れ | 招待あり・未登録 |
| 登録済み | LMS のアカウントあり・未開始 |
| 体験中 | 開始した |
| 体験完了 | 6条件（必須レッスン・MVV・AI・3分チャレンジ・成果物・振り返り）がそろった |
| 取得できません | LMS に届かない・認証できない（未完了・未招待とは書かない） |

体験の完了は採用の合格ではない。合否は人が NEXT ACTION から決める。

## 設定（本番の環境変数。値はここに書かない）

| 変数 | 置き場所 | 内容 |
|---|---|---|
| `MUGENDOJO_HR_LMS_SECRET` | MF と LMS の両方 | 同じ値。32文字以上のランダム値 |
| `MUGENDOJO_LMS_BASE_URL` | MF | LMS の URL（https）。メニュー用の `LMS_URL` とは別に持つ |
| `HR_LEAD_TENANT_ID` | MF（既存） | 無限道場を運営する会社。ほかの会社にはパネルを出さない |
| `LMS_TRIAL_COURSE_ID` | LMS（任意） | 体験版のコースを固定する |

どれかが無ければ、パネルに不足している変数名を出し、LMS は呼ばない（503 `not_configured`）。

## テスト

- `test/hrlmstrialapi.mjs`：API（偽の LMS で署名を確かめる・1通だけ・失敗の種類・URL を残さない）
- `test/ui/hrlmstrialui.mjs`：ドロワーのパネルと送信モーダル（320・390px を含む）
