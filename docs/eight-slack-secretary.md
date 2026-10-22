# EIGHT秘書（Slack 社員向けAI窓口）導入・運用手順

社長専用Dotsとは**別アプリ・別権限**です。Dotsの社長個人のメール・Drive・GW接続情報、既存Pちゃん Bot の接続・token は利用しません。
実装: `api/slack/eight-secretary.js`（受信・署名検証・キュー投入）→ Supabase のキュー（`db/147`）→ `api/cron/eight-secretary.js`（毎分）→ `lib/eight-slack-secretary.js` → Slack返信。

> 状態: 実装とモック／ローカルPostgreSQLでの検証まで。Slack Appの作成・権限付与・インストール、実Slack送信、本番DB適用、本番マージは**それぞれ代表の承認後**に行います。
>
> Slack の実際の値（workspace/team ID、代表ユーザーID、代表DMチャンネルID、既存P BotユーザーID、日報チャンネルID など）は**設定名でだけ扱い**、コード・ドキュメント・テストに書きません。テストは架空ID（`T000TEST`・`U000OWNER` など）を使います。日報チャンネルIDはこの窓口では使いません。

## 既定はすべて OFF
- `SLACK_AI_SENDING_ENABLED` が `true` でない間、Cron は Slack にもキューにも触れません（受信はキューに溜まるだけ）。
- `SLACK_AI_AUTO_ANSWER` が `true` でない間（既定）、資料で答えられた質問も**社員へは送らず**、AI回答案・質問者・質問を代表DMへ回し、代表がスレッドで `承認: 回答本文` を送った後にだけ社員へ送ります（宛先＋本文の承認）。
- 代表への報告（判断依頼・承認受付・取消・停止・不明）と社員への回答は別経路です。代表への報告は、この Bot と代表の検証済み1対1 DM にだけ送ります。社員への回答は承認済みのものだけです（本人確認未完了・長すぎる質問・「確認を依頼しました」の受付通知は回答ではない定型文として送ります）。

## 送信前の事前確認（preflight）
Cron は毎回、処理の前に `secretaryPreflight` を実行します（メッセージは送らない）。1つでも満たさなければ `503 preflight_failed` で終了し、キューのイベントも承認済み回答も**保留のまま送信しません**。
1. `auth.test`: トークンの workspace が `SLACK_AI_TEAM_ID` と一致し、Bot ユーザーが `SLACK_AI_BOT_USER_ID` と一致（Bot トークンであること）。`SLACK_P_BOT_USER_ID` と同じなら既存 P Bot のトークン流用として停止。
2. `users.info`（`users:read`）: 代表が同じ workspace の在籍・非ゲスト・非Botの利用者で、`SLACK_AI_OWNER_USER_ID` と一致。
3. GW: 代表の Slack ID が `gw_slack_ai_users` で明示紐付けされた在籍社員（失効なし）で、GW の owner ロールを持つ。
4. `conversations.open`（`im:write`、`return_im`）: この Bot と代表の **1対1 DM**（`is_im` かつ相手が代表だけ）を解決。`SLACK_AI_OWNER_DM_CHANNEL_ID` を設定した場合は解決結果と一致しなければ停止（別 App＝既存 P Bot の DM ID は一致しないので使えない）。既存 DM を返すだけで、メッセージは送りません（DM が無ければ空の DM が作られます）。

承認（`承認:`）は、解決した DM の中の判断依頼スレッドでだけ受け付けます。代表本人でも別 App の DM での承認は無視します。

## できること
- Slackの**EIGHT秘書BotへのDM**で質問。1分周期のジョブで処理します（即時返信ではありません）。
- Slack ID に**明示的に紐付けた**在籍社員の既存GW権限の範囲で `gw_ai_knowledge`（`db/113`）を検索して回答。一般（`all`）に加え、人事（`hr`）・経理（`finance`）・管理者（`admin`）の資料は既存の閲覧権限を持つ社員だけが使えます。
- 依頼された場合は、低リスクで元に戻せる業務改善案を「提案」と明記して返します。
- 根拠が無い質問、社長決裁が必要な質問は**代表のSlack DM**へ判断依頼を送信。
- 代表が**その判断依頼のスレッド内**で `承認: 回答本文` と返信すると、約1〜2分後に質問者のDMスレッドへ `【社長確認済み】` として回答。

## この PR の範囲外（未実装・別途設計）
- Slack公開チャンネル／プライベートチャンネルでの @メンション受付（DMのみ。`app_mentions:read`・`channels:history` 等は付与しない）
- 日報・予定の AI 行動コーチ（MF #167 の別作業）。本人の日報・予定など個人業務データは読みません
- カレンダー連携
- 社長専用DotsとのAPI自動同期
- 承認ボタン（Interactivity）、社員・Slack本人紐付けの管理画面、停止案件の管理画面

## 安全規則（実装済み・モックテスト済み）

| 規則 | 実装 | テスト |
|---|---|---|
| 本人確認：Slack workspace（team ID）＋ tenant ＋ `gw_slack_ai_users` の明示紐付け（Slack user ID ↔ GW employee_id）。表示名では決めない | 受信で `team_id` 照合、処理で紐付け・在籍・GWアカウント・`gwContext` の tenant/社員一致を確認。`revoked_at` 入りの紐付け・別tenant・別workspace・未登録は拒否 | access: 未紐付け・退職・tenant不一致等 8件、approval: `identity:` 4件 |
| 権限の再確認：検索時と**送信直前**の両方。代表の権限で代用しない | 検索は質問者のスコープのみ。即時回答はAI処理後に再照合、承認回答は送信直前に質問時スナップショットと比較 | access: delivery revalidation 7件・immediate-answer 4件、approval: `permission:` |
| 承認は「回答本文・質問・質問者・宛先・承認メッセージ」に結び付く | 承認時に `approval_hash`（SHA-256）を保存し、送信直前に再計算。不一致・欠落は `review_required` | approval: `binding:` 5件 |
| 承認後の編集・削除・重複承認で承認失効 | 承認から60秒は送信を保留。保留中に代表が承認メッセージを編集（`message_changed`）・削除（`message_deleted`）、または別の承認を送ると、承認を取り消して `pending` に戻し、その ts 以前の承認は以後受け付けない（再承認が必要） | approval: `approval:` 7件 |
| 判断依頼を送った代表DMのスレッドだけが承認できる | `owner_dm_channel` + `owner_dm_ts` で照合 | approval: `only the owner DM thread` |
| 二重送信防止 | `event_id` 主キー＋`message_key`（channel:ts）一意索引、キューの CAS 取得、承認送信前に `delivery_attempted` を記録（承認ハッシュ付き CAS） | secretary: duplicate、approval: `dedupe:`、SQL: concurrent workers |
| 結果不明は自動再送しない／`failed`・`review_required` も自動再送しない | 送信例外は `delivery_uncertain`。`failed` イベント・停止案件はジョブが再処理しない | secretary / approval: `delivery_uncertain` 等 |
| 指示注入を権限変更として扱わない | スコープは DB の権限からだけ決定。質問・資料はモデルへ未信頼 JSON として渡す。社員の「承認:」は承認にならない | approval: `injection:` 2件、secretary: prompt |
| キュー保存失敗を成功扱いしない | 判断依頼の保存・代表DM ts の保存・完了記録の失敗は `failed`（または例外）にし、質問者へ「依頼しました」を送らない | access: persistence 2件、approval: `queue:` 2件 |
| 代表向けの報告は代表DMだけ | 判断依頼・承認受付・承認取消・送信停止・送信結果不明の通知は、事前確認で解決したこの Bot と代表の1対1 DM（判断依頼スレッド）へ。チャンネル・代表ユーザーID宛て・別 App の DM へは送らない | preflight: `owner path`・`auto-answer OFF` |
| 送信 OFF 既定・事前確認失敗で保留 | `SLACK_AI_SENDING_ENABLED`、`secretaryPreflight` | preflight: `config:`・`cron:`・`preflight refuses:` 19件 |

補足:
- 承認の保留（60秒）は `DEFAULT_APPROVAL_HOLD_MS`。Cron が1分周期なので、承認から送信まで実際は1〜2分です。送信処理に入った後の編集は取り消せません（代表DMに「編集後の内容は送っていません」と通知）。
- 確認直後の権限変更と外部Slack送信は同一トランザクションにできません。緊急の利用停止時は該当者の紐付けを失効（`revoked_at`）させ、保留中の承認も確認してください。
- スコープ比較は保守的な送信停止であり、代表が書いた回答本文の機密性を自動判定するものではありません。
- 判断依頼には質問本文が含まれ、代表のDMに届きます。機密を質問に書かない運用も周知してください。
- 送信は**EIGHT秘書（AI）Bot名義**。社長本人アカウントは使わず、AIであることを表示名で明示します。

## Slack App（専用・最小権限）

manifest: [`docs/slack/eight-secretary-app-manifest.json`](slack/eight-secretary-app-manifest.json)（Slack の「Create New App → From an app manifest」に貼る）。

| 項目 | 値 | 理由 |
|---|---|---|
| Bot scope `chat:write` | 必須 | 質問者DM・代表DMへの返信 |
| Bot scope `im:history` | 必須 | `message.im` イベント（DMの受信と、代表の承認メッセージの編集・削除）の購読に必要 |
| Bot scope `im:write` | 事前確認に必須 | `conversations.open` で、この Bot と代表の1対1 DM を解決・検証する（別 App の DM は使えないため） |
| Bot scope `users:read` | 事前確認に必須 | `users.info` で代表が同じ workspace の有効な利用者か確認する。メールアドレスは読まない（`users:read.email` は付与しない） |
| Bot event `message.im` | 必須 | DMだけを受け付ける |
| それ以外 | 付与しない | `im:read`（DM IDの解決は `conversations.open` の結果で足りる）・`channels:*`・`app_mentions:read`・`users:read.email`・user scope・Interactivity は不要 |
| Request URL | `https://<GW本番ドメイン>/api/slack/eight-secretary` | プレースホルダ。デプロイと環境変数設定の後に Slack 側で検証 |

- 未検証: 新しい専用 App から各社員との1対1 DM に投稿できるか（既存 P Bot では他メンバーとの1対1 DM 失敗の記録あり）。社員への返信は、社員が Bot に送った DM（イベントの channel）へ返すため追加 scope は想定していません。scope を増やす場合は改めて承認を得ます。
- App Home の Messages タブを有効化（社員が Bot にDMできるようにする）。

## 環境変数（名前のみ。値はVercelのサーバー側Secretに設定し、コード・PR・チャットに書かない）
- `SLACK_AI_SIGNING_SECRET`（Slack Basic Information の Signing Secret）
- `SLACK_AI_BOT_TOKEN`（Bot User OAuth Token）
- `SLACK_AI_TEAM_ID`（対象 Slack Workspace ID）
- `SLACK_AI_OWNER_USER_ID`（代表本人の Slack ユーザーID。承認・編集の判定と事前確認。受信側でも編集イベントの絞り込みに使う）
- `SLACK_AI_TENANT_ID`（mf の `tenants.id`）
- `SLACK_AI_BOT_USER_ID`（この App 自身の Bot ユーザーID。事前確認で `auth.test` と照合。必須）
- `SLACK_P_BOT_USER_ID`（任意。既存 P Bot のユーザーID。このトークンが P Bot のものなら停止）
- `SLACK_AI_OWNER_DM_CHANNEL_ID`（任意。この Bot と代表の1対1 DM の ID。事前確認の解決結果と一致しなければ停止）
- `SLACK_AI_SENDING_ENABLED`（送信の総スイッチ。既定 OFF。`true` のときだけ動く）
- `SLACK_AI_AUTO_ANSWER`（資料に基づく AI 回答を承認なしで送るか。既定 OFF）
- `CRON_SECRET`（既存の Vercel Cron 認証。既にある場合は**変更しない**）

## DB（`db/147_slack_ai_secretary.sql`）
- 前提: `schema.sql`（tenants）、`005_groupware_core.sql`（gw_employees）。回答時に `113_ai_assistant.sql`（`gw_ai_knowledge`）を読むため、113 が本番適用済みであることを先に確認します。
- 表: `gw_slack_ai_users`（明示紐付け・`revoked_at`）、`gw_slack_ai_events`（受信キュー・`message_key` 一意）、`gw_slack_ai_escalations`（判断依頼・承認結び付け・自動回答OFF時のAI回答案 `ai_draft_answer`）。
- RLS 有効・ポリシー無し、`anon` / `authenticated` の表権限を `revoke`（service role のサーバー処理だけが使う）。
- 再実行可能（べき等）。承認結び付けの CHECK 制約は旧データを検証しない `not valid`（旧データはアプリ側で送信せず `review_required`）。
- 確認（読み取りのみ）: `db/check_147_slack_ai_secretary.sql`。戻し: `db/rollback_147_slack_ai_secretary.sql`（記録・未処理イベントがあると中断し、何も消さない）。
- 番号: 147 は main・オープン PR（143: #151/#157/#163、144: #154、148: #167 等）と重複なし。
- ローカル検証: `test/sql/run.sh`（使い捨て PostgreSQL 16。リモートDBには接続しない）で 099→113→147 の適用・再適用、RLS、一意性、CAS、承認結び付け制約、2セッション同時取得、ロールバック安全装置、再適用を確認。

## 導入手順（各段階で承認を得る）
1. **［承認］本番DB適用**: Supabase（mf が使う既存DB）の SQL Editor で `db/113` が適用済みか確認後、`db/147_slack_ai_secretary.sql` を適用し、`db/check_147_slack_ai_secretary.sql` で確認。コードより先に適用する（順序を逆にしない）。
2. **［承認］Slack App作成・インストール**: manifest から専用 App を作成し、ワークスペース管理者がインストールを承認。scope は上表の4つだけ。
3. **［承認］環境変数設定**: 上記の名前で Vercel にサーバー側 Secret を設定。`SLACK_AI_SENDING_ENABLED` はまだ設定しない（OFF）。
3a. 代表の Slack ID を `gw_slack_ai_users` に紐付け（代表は GW の owner ロールが必要）。
3b. **［承認］送信を ON**: `SLACK_AI_SENDING_ENABLED=true`。最初の Cron で事前確認が通ることを Vercel のログ（`preflight_failed` が出ないこと）で確認。失敗時は理由（`team_mismatch`・`owner_dm_not_one_to_one` 等）を見て設定を直す。
4. **［承認］本番マージ・デプロイ** 後、Slack の Event Subscriptions で Request URL を検証。1分間隔 Cron のため Vercel プランが Pro/Enterprise であることを確認。
5. **紐付け登録**: GW の `gw_employees` の在籍社員と Slack ユーザーIDを**人が確認**して `gw_slack_ai_users` に登録（SQL 末尾の例）。氏名だけの自動照合は禁止。退職者・外部参加者は登録しない。失効は `revoked_at` を入れる。
6. `admin-ai.html` で社内ナレッジの内容・公開範囲を確認し、必要分だけ有効化。
7. **［承認］テスト送信**: 送信元（EIGHT秘書（AI））・宛先（同意を得たテスト社員1名と代表）・本文を事前に承認してから、①資料で答えられる質問、②資料の無い質問→代表DM→承認→本人回答、③承認メッセージの編集で承認が取り消されること、を確認。

## 停止・異常時の確認手順（runbook）

自動で再送・状態の巻き戻し・宛先変更はしません。下の照会はすべて**読み取りのみ**です（質問・回答本文は表示しない）。状態の書き換えはせず、記録は監査用にそのまま残します。

```sql
-- 判断依頼の停止・不明・処理中
select id, created_at, status, delivery_error, delivery_attempted_at, approved_at
from public.gw_slack_ai_escalations
where tenant_id = '<対象テナントUUID>'::uuid
  and status in ('review_required', 'delivery_uncertain', 'delivery_attempted')
order by created_at;

-- 受信イベントの失敗・処理中（processing が10分以上続くものは処理落ちの可能性）
select event_id, received_at, state, last_error
from public.gw_slack_ai_events
where slack_team_id = '<対象SlackワークスペースID>'
  and state in ('failed', 'processing')
order by received_at;

-- 承認が取り消された依頼（代表の再承認待ち）
select id, created_at, delivery_error, approval_invalidated_ts
from public.gw_slack_ai_escalations
where tenant_id = '<対象テナントUUID>'::uuid
  and status = 'pending' and delivery_error in ('approval_edited', 'approval_deleted', 'approval_conflict')
order by created_at;
```

| 状態 | 意味 | 手動確認と対応 |
|---|---|---|
| `review_required`（`requester_access_changed` / `requester_scopes_reduced` / `requester_scope_snapshot_missing` / `requester_access_check_failed`） | 承認後に質問者の在籍・紐付け・権限が変わった、または確認できなかった。**送信していない** | 代表DMに通知済み。管理者が質問者の在籍・権限と回答内容の範囲を確認し、必要なら社員に再質問してもらう（新しい依頼として承認を取り直す）。旧承認の流用・宛先変更はしない |
| `review_required`（`approval_binding_mismatch` / `approval_binding_missing`） | 承認後に質問・宛先・回答本文が変わった、または旧データで結び付けが無い。**送信していない** | DB変更の経緯を確認。社員に再質問してもらい、新しい依頼で承認を取り直す |
| `delivery_uncertain` | Slack への送信で通信エラー等。**届いた可能性がある** | 代表DMに通知済み。質問者本人に `【社長確認済み】` が届いたか確認（本人の画面で）。未着なら代表または管理者が人として回答するか、社員に再質問してもらう。自動再送しない |
| `delivery_attempted` が数分以上続く | 送信処理中に処理落ちした可能性。届いた可能性がある | `delivery_uncertain` と同じ扱い |
| イベント `failed` | 受信後の処理で失敗（本人照合の変化、保存失敗、Slack送信失敗など）。返信が届いた可能性もある | `last_error` を確認。質問者に返信の有無を確認し、必要なら再質問してもらう（新しいメッセージは新しいイベント）。`queued` に戻さない |
| イベント `processing` が10分以上 | ワーカーが途中で停止 | Vercel のログと突き合わせ、質問者に返信の有無を確認。`queued` に戻さない |
| Cron が `preflight_failed`（理由付き） | 事前確認に失敗。**何も送っていない**（イベント・承認済み回答は保留） | 理由に応じて設定・紐付け・scope を確認。直れば次の Cron から処理再開。急ぎで止めるなら `SLACK_AI_SENDING_ENABLED` を外す |
| `pending`＋`approval_edited` 等 | 代表が承認メッセージを編集・削除、または承認を複数送ったため承認取消。**送信していない** | 代表DMに通知済み。代表が判断依頼スレッドに新しく `承認: 回答本文` を1件送る |

紐付けの緊急停止は `revoked_at` を入れる（本番での実行は承認後）。Cron（`/api/cron/eight-secretary`）を止めると処理は止まり、受信はキューに溜まります。

## 確認方法（モック・ローカルのみ。実Slack・実DBに接続しない）
```sh
node --experimental-test-module-mocks test/eight-slack-secretary.mjs
node --experimental-test-module-mocks test/eight-slack-secretary-access.mjs
node --experimental-test-module-mocks test/eight-slack-secretary-approval.mjs
node --experimental-test-module-mocks test/eight-slack-secretary-preflight.mjs
node test/run.mjs node
test/sql/run.sh   # root 以外のユーザーで実行（PostgreSQL 16）
```
モックとローカルDBでのPASSは、実Slackでの配信成功や本番DBでの動作の保証ではありません。
