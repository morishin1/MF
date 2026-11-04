# Slackの依頼をグループウェアの本人タスクへ取り込む

## 目的

Slackで本人へ届いた明示的な依頼を、`home.html` の未完了タスクに1件ずつ登録する。元メッセージへのリンクをタスクに残し、Gmail/Slackにワンクリックで戻れるようにする。

## すぐ使える機能（Slackアプリの追加接続なし）

ホーム → **Slack依頼を追加** → タスク名とSlackメッセージのURLを入力 → 登録。本人の未完了タスクに表示され、一覧の「Slackを開く」または詳細の「関連URL」から元メッセージへ移動できる。GmailのURLでも同じ。

この操作はSlackの内容を勝手に読み込んだり、Slackでの完了通知を送ったりしない。

## 自動取込の条件

Slackアプリの **Events API** で `https://gw.8grp.co.jp/api/slack/task-events` にHTTPイベントを送る。次の環境変数をVercel `mf` プロジェクトのProductionに設定する（値はリポジトリやChatGPTに貼らない）。

| 変数 | 内容 |
| --- | --- |
| `SLACK_TASK_SIGNING_SECRET` | Slack App > Basic Information > Signing Secret（必須・秘密） |
| `SLACK_TASK_TEAM_ID` | 許可するSlackワークスペースのTeam ID |
| `SLACK_TASK_OWNER_SLACK_USER_ID` | タスク対象者本人のSlack User ID |
| `SLACK_TASK_OWNER_EMPLOYEE_ID` | 本人の `gw_employees.id`（同一テナントの在籍社員） |
| `SLACK_TASK_ALLOWED_CHANNEL_IDS` | 監視を明示的に許可したチャンネルIDをカンマ区切りで設定（空は不可） |

手順：

1. Slackアプリに `message.channels` / `message.groups` を購読させる。必要なOAuth権限はSlack公式ドキュメントで確認する。
2. 許可チャンネルにアプリを招待する。プライベートチャンネルは招待と適切な権限が必要。
3. Signing SecretとマッピングをVercelのProduction環境変数へ設定し、**必要なときだけ**再デプロイする。
4. Slack Events APIでRequest URLの検証を行う。署名検証済みの `url_verification` だけに応答する。
5. テストチャンネルで本人へのメンション付き `確認してください` などの依頼を送り、ホームの未完了一覧と元メッセージリンクを確認する。

## 自動登録の判定・権限

- 指定ワークスペースかつ許可チャンネルだけ。
- 本人へ明示メンションがあり、「確認」「対応」「依頼」「お願い」など仕事の依頼文言が含まれる通常投稿だけ。
- 本人の発言・ボットの投稿・編集イベント・雑談・未許可チャンネルは取り込まない。
- 元メッセージのタイムスタンプとチャンネルIDを `gw_tasks.occ_key` へ登録。既存ユニーク索引でSlackの再配送による二重登録を防止。
- 既存 `gw_tasks` の本人担当タスクとして作成。DB変更は不要。
- HTTPリクエストの **生本文** に対してSlack署名を検証し、5分超の古い署名を拒否。
- メッセージ全文は複製せずタスク名の短い抜粋とSlack permalinkだけを保存。内容の閲覧はSlack側のアクセス権限に従う。
- 既存タスクの完了・ステータス変更はSlackメッセージ自体の状態を変更しない。

### 対象外

個人間DM・グループDM・ボットが参加していないチャンネルのメッセージは、この方式だけでは全件を取得できない。DMまで自動同期するにはSlack側の追加の許可と適切な連携方式の設計が必要。ChatGPTのSlackコネクターが接続されていても、**グループウェアのVercel実行環境にSlack Appの権限が引き継がれるわけではない**。

## テスト

`node test/slack-task-ingest.mjs` — HTTP署名、入力制限、本人メンション、許可チャンネル、重複キー、関連URLリンクの単体テスト。
