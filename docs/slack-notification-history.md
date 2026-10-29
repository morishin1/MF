# Slack通知履歴への切替

## 状態と対象

本実装はローカル検証用。未公開・SQL未適用・実Slack投稿の登録未実施。履歴が空であることはメール確認完了の証明ではありません。

HRの「採用メール新着受付」を「Slack通知履歴」に変更し、Office/HR/Sales各ダッシュボードにSlackアイコンの入口を追加します。表示するのは、Pが既にSlackへ送信し、宛先・内容・投稿時刻・正確なpermalinkを確認した非機密要約だけです。過去受信メールを履歴へ移し替えず、既存受信テーブル/API/データを保持します。新画面は旧メールの取込・登録・即時Gmail同期を呼びません。既存の外部GASトリガーや環境設定をこのコードで停止したとは扱いません。

| 履歴 | 固定Slackチャンネル | 情報源 |
| --- | --- | --- |
| HR /hr/inbox.html | C0CCSBTDB1S | hr-mailbox |
| Office /office/slack-history.html | C0CCLMUQZ7G | 権限内GW Office情報のみ |
| Sales /sales/slack-history.html | C0CCQHQN3SM | sales-mailbox |

代表個人メールは本人DMのみ。keieiは現在未接続・取得対象外です。これらのDM、本文、件名、件数、source IDを共有履歴へ保存しません。

## APIと認証

GET /api/slack-history?department=hr|office|sales は既存requireUser/gwContextを使用し、tenantと部門の両方で絞ります。HR canRecruit、Sales canSell、Office canOffice/canOfficeHr/canOfficeFinanceのいずれかを必須とします。Office掲載本文はその共通閲覧者全員に共有可能な非機密内容だけとし、給与・契約・労務の細目を含めません。

POSTは同じ認証に加えて既存ownerロール限定です。request側のtenantや自由なchannelを受け付けません。API自体にSlack送信機能もGmail接続もありません。Pが正常なowner認証画面を利用できなければ登録は停止します。token/hidden stateの読取り、ブラウザの任意fetch、service keyや永続tokenの作成は解決策にしません。

投稿者はSlack履歴を読戻し、固定チャンネル、timestamp、正確なpermalink、送信内容を照合してから通常フォームで登録します。APIは固定宛先・URL/timestamp整合・入力・二重登録を検証しますが、Slackへ問い合わせて投稿実在を独立検証する機能はありません。confirmedSentは本人による照合確認であり、Slack API検証済みという意味ではありません。この前提を満たさない送信予定/失敗/結果不明は登録しません。

## 保存項目と境界

専用表gw_slack_notification_historyに、tenant/部門/対象日JST/枠08・12・17/版、非機密要約、送信日時、固定channel/Slack timestamp/permalink、対象期間、取得状態complete/partial/unavailable、取得不足の説明、許可済み情報源と元レコード識別子、receipt hash、記録者、記録日時だけを保存します。メール全文・添付・給与・候補者詳細を入れません。本文が非機密かは投稿者の照合も必須であり、入力キー制約だけで自由文の機密性を判定できるとは主張しません。

表はRLS有効、public/anon/authenticatedに直接権限なし。既存認証付きAPIが部門境界を検証した後にservice_roleでSELECT/INSERTします。UPDATE/DELETE権限を付与せず証跡を上書きしません。Storage・既存メール表・権限には変更しません。

同一tenant/部門/対象日/枠/版は一意、同一tenant/channel/timestampも一意です。同一receiptの再試行は元IDを返し、違う内容なら409で停止します。Slack投稿の修正を自動反映するものではありません。同じ投稿を別版として登録しようとしても409となるため、訂正履歴の仕様拡張は別途必要です。

## 配信と保存を分ける

今回の既存P自動通知はSlack送信のみで、GW書込みは未許可・未接続として運用します。今回の履歴機能は後から正式フォームで送信済みを記録する経路です。先にGWへ「送信済み」を作ってからSlackへ送信してはいけません。

- Slack送信失敗：履歴へ登録しない。
- Slack結果不明：Slack履歴を照合するまで再送も登録もしない。
- Slack成功、GW保存失敗：Slackを再送せず、同じreceiptだけを再登録。
- GW保存結果不明：履歴を更新して既存投稿を確認。同じreceiptで再試行可、新しい版やキーで重複を作らない。
- 取得不足：実際に送信した不足案内をpartial/unavailableで記録し、0件・確認完了と偽装しない。

日報の朝1回とメール業務の08/12/17通知は別系統のままです。このPR案は定期実行を新規設定しません。

## 本人によるDB準備と開始条件

1. db/check_slack_history_preflight_json.sql（SELECT-onlyの1行JSON）で同名表・制約・権限を本人が確認。既存同名表・indexがある場合は停止して整合をレビューする。本体は名前衝突時に中断し、既存定義・権限を修復/上書きしない。
2. 本人がdb/proposal_slack_notification_history.sqlをレビュー・適用。agentは本番/共有/ローカルSQLを適用していません。
3. db/check_slack_history_postflight_json.sql（SELECT-onlyの1行JSON）でRLS・権限・一意制約・固定宛先を確認。実DBの隔離試験は未実施で、mock試験とは区別。
4. 正規ownerログインのフォーム経路、3部門の閲覧者、非権限者/別tenant拒否、実送信receiptを承認済み試験で確認。
5. コード公開・本人SQL適用・正式認証経路がそろうまで履歴完成とはしない。P自動通知taskからのGW直接書込みは別途確認なしに有効化しない。
