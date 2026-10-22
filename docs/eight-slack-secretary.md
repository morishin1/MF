# EIGHT秘書（Slack 社員向けAI窓口）導入手順 — MVP

社長専用Dotsとは**別アプリ**です。Dotsの社長個人のメール・Drive・GW接続情報は利用しません。
実装: `api/slack/eight-secretary.js`（受信）→ Supabase のキュー → `api/cron/eight-secretary.js`（毎分実行）→ Slack返信。

## この段階でできること
- Slackの**EIGHT秘書BotへのDM**で質問。受付した質問は1分周期のジョブで処理します（即時返信ではありません）。
- GWの `gw_ai_knowledge` から、公開範囲が `all` で管理者が有効化した知識のみ参照してAI回答。
- 根拠が無い質問、社長決裁が必要な質問は、森田さんのSlack DMへ質問を送信。
- 森田さんが**そのDMのスレッド内**で `承認: 回答本文` と返信すると、質問者のDMスレッドへ正式回答。
- SlackイベントIDで受信の重複を防止。bot投稿を再処理しない。社内名簿との本人紐付けは手動で厳格に確認。

## 未実装（次の段階）
- Slackの公開チャンネルでの @メンション受付（意図的にDMだけ）
- 本人のGW日報・予定を直接読んでの個別コーチング（今回は既存の公開ナレッジのQ&Aのみ）
- 社長専用DotsとのAPI自動同期
- Slackの返信が万一失敗した後の再配信管理画面
- 社長が操作しやすい承認ボタン／社員・Slack本人紐付け管理画面

## 管理者が行う作業（機密情報をチャットやGitHubに貼らない）

1. Supabase（`mf` が使用する**既存DB**）のSQL Editorで `db/147_slack_ai_secretary.sql` を適用。
2. [Slack API](https://api.slack.com/apps) で**新規Slack App（From scratch）** を作成。
   - App Display Name: `EIGHT秘書`
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
5. `admin-ai.html` で公開可能な社内ナレッジの内容と `access_scope='all'` を確認し、管理者が必要分だけ有効化する。
6. PRをレビューし、SQL・Secrets・Slack Appの準備ができた後に、管理者が本番マージ・デプロイを承認。
7. 会社のテストユーザー1人のDMで「日報の書き方は？」等を質問。AIが公開知識に基づく回答をすることを確認。
8. 回答資料のない質問を送り、社長に確認DMが届くことを確認。社長がテスト用の回答を明示して承認し、本人へ届くことを確認。**テスト前に相手の同意を得る**。

## 運用上の注意
- 受信から返信までは最大で約1分＋AI処理時間がかかります。Cron停止時は返信されません。
- Cronには `CRON_SECRET` を必須にしています。受信にはSlackのHMAC署名と5分以内のタイムスタンプが必要。
- Slackに存在するだけでは回答対象になりません。GWの在籍社員・明示したID紐付け・同一テナントを検証します。
- AIに渡すのは一般社員向けに明示公開した `all` 資料のみ。HR、経理、管理者限定の知識は参照しません。
- AIは人事評価・懲戒・契約締結・給与・値引きなどの判断を自動実行しません。
- Slackへの送信は**EIGHT秘書Bot名義**。社長本人アカウントを使いません。
- 社長からの承認はBotが投稿した判断依頼メッセージの**Slackスレッドに返信**すること。返信本文の先頭に `承認:` を付けます。
- キュー処理が失敗した場合 `gw_slack_ai_events.state='failed'` に残ります。再処理は安全性を確認のうえ管理者が行います。むやみに queued へ戻すと再送になる可能性があります。
- Botが使う `gw_ai_knowledge` は既存のSQL `db/113_ai_assistant.sql` が必要。利用前に有効な資料を設定してください。
- 社長判断依頼で引用された情報は社長のSlack DMへ送られます。機密を質問に記載しない運用も周知してください。

## 確認方法
```sh
node test/eight-slack-secretary.mjs
npm test
```
