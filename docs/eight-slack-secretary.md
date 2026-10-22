# EIGHT秘書（Slack 社員向けAI窓口）導入手順 — MVP

社長専用Dotsとは**別アプリ・別権限**です。Dotsの社長個人のメール・Drive・GW接続情報は利用しません。
実装: `api/slack/eight-secretary.js`（受信）→ Supabase のキュー → `api/cron/eight-secretary.js`（毎分実行）→ Slack返信。

## この段階でできること
- Slackの**EIGHT秘書BotへのDM**で質問。受付した質問は1分周期のジョブで処理します（即時返信ではありません）。
- GWの `gw_ai_knowledge` を、Slack IDに手動で紐付けた社員の既存GW権限に合わせて検索。一般公開 (`all`) に加え、人事 (`hr`)・経理 (`finance`)・管理者 (`admin`) の知識は既存の閲覧権限を持つ社員だけが回答に使えます。
- 資料に基づく回答に加え、依頼された場合は低リスクで元に戻せる業務改善案を「提案」と明記して返します。
- 根拠が無い質問、社長決裁が必要な質問は、森田さんのSlack DMへ質問を送信。
- 森田さんが**そのDMのスレッド内**で `承認: 回答本文` と返信すると、質問者のDMスレッドへ正式回答。
- SlackイベントIDで受信の重複を防止。bot投稿を再処理しない。社内名簿との本人紐付けは手動で厳格に確認。

## 未実装（次の段階）
- Slackの公開チャンネルでの @メンション受付（DMのみ）
- 本人の日報・予定など、GWの個人業務データを直接読んでの個別コーチング
- 社長専用DotsとのAPI自動同期
- Slackの返信が万一失敗した後の再配信管理画面
- 社長が操作しやすい承認ボタン／社員・Slack本人紐付け管理画面

## 管理者が行う作業（機密情報をチャットやGitHubに貼らない）

1. Supabase（`mf` が使用する**既存DB**）のSQL Editorで `db/147_slack_ai_secretary.sql` を適用。
2. [Slack API](https://api.slack.com/apps) で**新規Slack App（From scratch）** を作成。
   - App Display Name: `Pちゃん（EIGHT秘書）`
   - Bot Token Scopes: `chat:write`、`im:history`
   - Event Subscriptions / Subscribe to bot events: `message.im`
   - App Home: メッセージ（DM）を有効化
   - Event Request URL: `https://gw.8grp.co.jp/api/slack/eight-secretary`
   - SlackのRequest URL確認は署名チェックが必要なため、先に環境変数とデプロイを済ませてからURLの検証を行う
   - ワークスペース管理者がインストールを承認する
3. Vercelの`mf`プロジェクトに下記の環境変数を**サーバー側Secret**として設定。コードやPRに値を入れない。
   - `SLACK_AI_SIGNING_SECRET` = Slack Basic Information の Signing Secret
   - `SLACK_AI_BOT_TOKEN` = Slack OAuth Bot User OAuth Token（xoxb-）
   - `SLACK_AI_TEAM_ID` = 実際のSlack Workspace ID（T...）
   - `SLACK_AI_OWNER_USER_ID` = 社長本人のSlackユーザーID（U...）
   - `SLACK_AI_TENANT_ID` = mfの`tenants.id`（UUID）
   - `CRON_SECRET` = 既存のVercel Cron認証シークレット（既にある場合は**変更しない**）
4. GWの `gw_employees` に存在する在籍社員と、Slack本人IDを**人が確認**して `gw_slack_ai_users` に登録。氏名だけの自動マッチは禁止。退職者・外部参加者は登録しない。
5. `admin-ai.html` で社内ナレッジの内容・公開範囲・閲覧可能な社員を確認し、管理者が必要分だけ有効化する。Slack Bot が参照する範囲は質問者の既存GW権限に連動する。
6. PRをレビューし、SQL・Secrets・Slack Appの準備ができた後に、管理者が本番マージ・デプロイを承認。
7. 会社のテストユーザー1人のDMで「日報の書き方は？」等を質問。本人のGW権限内の知識だけに基づく回答を確認。
8. 回答資料のない質問を送り、社長に確認DMが届くことを確認。社長がテスト用の回答を明示して承認し、本人へ届くことを確認。**テスト前に相手の同意を得る**。

## 運用上の注意
- 受信から返信までは最大で約1分＋AI処理時間がかかります。Cron停止時は返信されません。
- Cronには `CRON_SECRET` を必須にしています。受信にはSlackのHMAC署名と5分以内のタイムスタンプが必要。
- Slackに存在するだけでは回答対象になりません。GWの在籍社員・明示したID紐付け・同一テナントを検証します。
- Slack IDからGW社員を解決した後、既存のGWロールとアプリ利用権限から回答対象者の知識スコープを決めます。service role はサーバー内だけで使い、別社員の記録は読みません。
- 質問文とナレッジ本文は未信頼データとしてモデルに渡し、その中の命令に従わず、必要な根拠だけを短く回答するよう指示します。Slackの書式解釈とリンク展開も無効にしています。
- AIは人事評価・懲戒・契約締結・給与・値引きなどの判断を自動実行しません。
- Slackへの送信は**EIGHT秘書Bot名義**。社長本人アカウントを使いません。
- 社長からの承認はBotが投稿した判断依頼メッセージの**Slackスレッドに返信**すること。返信本文の先頭に `承認:` を付けます。
- キュー処理が失敗した場合 `gw_slack_ai_events.state='failed'` に残ります。社長承認後の送信は重複を防ぐため送信前に `delivery_attempted` を記録します。通信結果が曖昧なときは `delivery_uncertain` に止め、Slack上の送信を人が確認するまで自動再送しません。
- 1分ごとのVercel Cronを使うため、対象チームのプランがProまたはEnterpriseであることを確認してください。Hobbyプランでは1分間隔のCronはデプロイできません。
- Botが使う `gw_ai_knowledge` は既存のSQL `db/113_ai_assistant.sql` が必要。利用前に有効な資料を設定してください。
- 社長判断依頼で引用された情報は社長のSlack DMへ送られます。機密を質問に記載しない運用も周知してください。

## 確認方法
```sh
node test/eight-slack-secretary.mjs
npm test
```
