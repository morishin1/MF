# 日報・予定 AI 行動コーチ（Draft / 全機能 既定OFF）

前勤務日の日報と、当日・次勤務日の計画を照合し、代表レビュー用の確認結果と下書きを作る。
**本番DB適用・本番マージ/公開・Slack App 権限付与・実 Slack 送信は、どれも未実施で別承認**。コードは入っているが、DB と環境変数の両方で既定 OFF。

- 基点：PR #167（`feat/behavior-coach-owner-review` 6384161）に main `cfd034c` を取り込んだ `handoff/coach-review`。取り込みの競合なし。
- PR159（Slack 秘書 Q&A）・Issue147（提出通知）とは別機能。カレンダー UI/API・請求書アップロード・既存の日報保存 API・Vercel cron は変更しない。
- AI 分析・自動判定だけを人事評価・懲戒の根拠にしない。未確認は本人の問題ではない。

## 1. できたこと（ローカル検証済み）

| 部品 | ファイル | 内容 |
|---|---|---|
| 勤務日 | `lib/behavior-coach-days.js` | 人別の勤務曜日（`gw_reminder_prefs.workdays`）・会社休日（`lib/holidays.js`）・承認済み全日休暇・入社/退職日から、前/次の勤務日。**曜日設定が無ければ null（月〜金を補わない）**。申請中の休暇・休日表の範囲外も null。提出済み日報がある日は勤務日 |
| GW adapter | `lib/behavior-coach-morning.js` `readCheckInputs` / `lib/behavior-coach.js` `readCoachSources` | 名簿全員（社員・アルバイト・委託・役員）。日報は `submitted_at` のある行だけを提出扱い（版＝`updated_at`）。予定は `source='self'` かつ `category<>'private'`、**body は読まない**（定時確認の一括読みは title も読まない）。休暇は日付・種類・状態だけ、契約は種類・期間だけ。tenant_id + employee_id で結び、user→社員が全テナントで1件でなければ照合を止める |
| 定時確認 | `runCoachCheck` | 名簿全員を 順調 / 要確認 / 要対応 / 未確認 / 対象外 に分類。提出イベントで拾えない未提出者もここで見つかる。提出済み日報にはルール下書き（AI なし）を付ける。同じ版なら候補を作らない |
| 定量目標 | `lib/behavior-coach-goals.js` | 引継ぎの goal-review（合成27テスト）を統合。数量は本人登録値（日報行の target+unit）だけ、無ければ null。行動量/成果物/事業成果の種類は記録に無いので null＋不足。カレンダー枠は実所要にしない。実所要の記録は GW に無いので時間差は常に未確認 |
| 外部呼び出し口 | `lib/behavior-coach-api.js` | P の定時タスク用の機械認証つき API（§3）。owner ログインとは別 |
| 代表レビュー画面 | `admin-nippo-coach.html` | 分類・理由・根拠（ID/版/時刻）・不足情報・下書き・宛先全員・承認。PC/390px。送信ボタンは置かない |
| 送信アダプタ | `lib/behavior-coach-delivery.js` | 代表DM・日報チャンネル・本人グループ。Slack preflight（読み取りのみ）。既定 OFF（§5） |
| SQL | `db/148_behavior_coach.sql` ＋ `check_148` ＋ `rollback_148` | 確認行・送信箱・実行 lease・設定欄を追加（§6） |

### 分類の規則

| 分類 | 主な理由（理由コード） |
|---|---|
| 対象外 | 退職確認済み（`left`、または退職日を過ぎた `leaving`）、入社前、暫定確認で本日が勤務日でない |
| 未確認 | 在籍状態不明・招待中・ログイン対応なし、本人対応が複数、勤務曜日未設定（直近7日に提出も無い）、休暇申請中、記録を読めない、暫定確認で期限前、委託・役員・雇用形態不明の未提出（提出が契約範囲か未確認） |
| 要対応 | 確認日より前が期限の未完了タスクがある |
| 要確認 | 正社員・契約社員・パート・アルバイトで、確定した勤務日の日報の提出を確認できない（「違反」とは言わない）、次勤務日の計画が見当たらない、未完了の理由が未記入、契約期間外の可能性、次勤務日を決められない |
| 順調 | 上のどれでもない（本人報告ベース。成果物は未照合） |

`名簿 = 順調 + 要確認 + 要対応（確認済み）+ 未確認 + 対象外` を常に満たす（`summary.consistent`）。

## 2. 下書きと承認

- 下書き（`model:"rules-only"`）は最大3点：良かった行動 / 次勤務日に変える1つ / 次回振り返り。根拠 ID は `readCoachSources` の facts に実在するものだけ（`validateAdvice`）。
- 順調で変える点が無い人は `no_action`（本人への連絡なし）。要確認・要対応で変える点がある人だけ `owner_review`。
- 本人への助言は、代表が**下書き ID・本文・宛先 hash**を個別承認した後だけ。根拠（日報・予定・在籍）・宛先・本文のどれかが変われば世代が進み、承認は失効（SQL 側で `approval=null`）。
- 既存の AI 草案（`action:"analyze"`、`ai_enabled` が必要）はそのまま残す。今回は実 AI を呼んでいない。
- payload は常に `productionReady:false / semanticEvidenceVerified:false / sendEnabled:false`。

## 3. P の定時タスクからの呼び出し仕様

既存の定期確認は **P（AI 秘書）の ChatGPT 定時タスク**：毎日 08:00 JST（前勤務日の日報＋当日・次勤務日の計画）、平日 17:30 JST（暫定＋翌日準備）、月曜 08:00 JST（週次）。現在 P はこの API を呼んでいない。**新しい cron・GitHub Actions・Vercel cron は作らない**（13:00 の ITS 停滞確認は対象外）。

### 呼び出し

```
POST /api/nippo/coach
Content-Type: application/json
x-nippo-coach-key: <環境変数 NIPPO_COACH_ROUTINE_KEY の値>

{"action":"morning","mode":"morning","date":"YYYY-MM-DD","idempotencyKey":"p-morning-YYYY-MM-DD","dryRun":false}
```

| 項目 | 必須 | 内容 |
|---|---|---|
| `action` | ○ | `"morning"` だけ（承認・送信などは機械認証では一切できない） |
| `mode` | | `morning`（既定）/ `provisional`（17:30）/ `weekly`（月曜）|
| `date` | | 確認日。省略時は JST の今日。**今日〜7日前だけ**（未来・それより古い日は 400）|
| `idempotencyKey` | ○（dryRun 以外）| `[A-Za-z0-9._:-]{8,128}`。推奨：`p-<mode>-<date>`。再送時は同じ値 |
| `dryRun` | | true なら読むだけ（行を書かない・lease も取らない）。結果の形は同じ |

- 認証：ヘッダの値と `NIPPO_COACH_ROUTINE_KEY`（32文字以上）を SHA-256 後に定数時間比較。未設定・短い場合は機能ごと無効（503 `routine_disabled`）。
- テナントは環境変数 `NIPPO_COACH_TENANT_ID` だけ。body の tenant 指定は無視する。
- DB の `gw_coach_config.enabled` と `morning_enabled` が両方 true でなければ 503 `coach_disabled`。

### 応答（200）

```json
{"checkDate":"2026-10-22","mode":"morning","dryRun":false,"replay":false,"idempotencyKey":"…",
 "summary":{"total":13,"ok":2,"check":3,"action":1,"unconfirmed":4,"excluded":3,"checked":6,"consistent":true},
 "created":13,"changed":0,"unchanged":0,"reviewsWritten":4,"reviewsUnchanged":0,"reviewErrors":0,
 "outbox":{"owner_report":"created","team_advice":"created"},
 "persons":[{"employeeId":"…","name":"…","status":"check","statusLabel":"要確認",
   "reasons":[{"code":"report_not_submitted","label":"日報の提出を確認できない（理由は未確認）"}],
   "reportDate":"2026-10-21","nextWorkday":"2026-10-22","workdayBasis":null,"weekly":null,
   "refs":[{"id":"report:2026-10-21","source":"tc_nippo","targetDate":"2026-10-21","submittedAt":null,"updatedAt":null,"version":null}],
   "check":"created","review":null,"reviewId":null}],
 "deliveryEnabled":false,"productionReady":false,"semanticEvidenceVerified":false,"sendEnabled":false}
```

- `check`：`created`（初回）/ `changed`（根拠の版が変わった）/ `unchanged`（同じ版。確認時刻だけ更新）。
- `review`：`written`（下書きを新規作成または再レビュー化。旧承認は失効）/ `unchanged` / null（下書き対象外）。
- `refs` は ID・元の表・対象日・提出/更新時刻・版だけ。日報・予定の本文は返さない（名前は返す。P はこれを代表へ報告してよいが、本人へは送らない）。

### 誤り

| HTTP | `error` | `retryable` | 意味・対応 |
|---|---|---|---|
| 401 | `unauthorized` | false | 鍵の不一致。再送しない |
| 503 | `routine_disabled` | false | 環境変数未設定（機能 OFF） |
| 503 | `coach_disabled` | false | DB の enabled / morning_enabled が false |
| 400 | `invalid_request` | false | action・date・mode・idempotencyKey・dryRun の形が不正 |
| 405 | `method_not_allowed` | false | POST 以外 |
| 409 | `run_in_progress` | true | 同じ日・同じ mode を別の呼び出しが実行中（lease 5分）。`retryAfterSec` 後に同じ鍵で再送 |
| 503 | `roster_unreadable` / `coach_store_unavailable` / `coach_unavailable` | true | 一時的な読み書き失敗。`partial:true` のときは途中まで書いた行がある |

**途中失敗の扱い**：1人ずつの書き込みはそれぞれ冪等（同じ版なら unchanged）。失敗した実行は lease が `failed` になり、同じ鍵で再送すると最初から流し直して残りを終える（済んだ人は unchanged）。

### 冪等・重複防止

- 同じ `date + mode + 根拠の版` → 新しい候補を作らない（確認行は `unchanged`、下書きの世代・承認はそのまま）。
- 根拠が変わった人だけ `changed`／下書きは再レビュー（世代+1、旧承認失効）。final（翌朝）を provisional に戻さない。
- 同時呼び出し：`gw_coach_runs` の lease（5分）で1つだけ実行、もう一方は 409。lease が切れた実行は次の呼び出しが引き継ぐ。
- 実行完了後に**同じ鍵**で再送 → 保存した結果をそのまま返す（`replay:true`、再計算しない）。**別の鍵** → 再計算（変わっていなければ全員 unchanged）。

### 量・制限

- 名簿は最大 40,000 行まで分割読み（`lib/pg-read.js`）。1人あたり予定 200・タスク 100＋古い未完了 50・休暇 50 を超えると「未確認（読み切れない）」。
- 1回の実行で DB 呼び出しは「表ごとの一括読み 9本 ＋ 1人1回の記録 RPC ＋ 版が変わった提出者ごとに根拠の読み直し」。
- 定時は 08:00・17:30・月曜 08:00 の各1回を想定。P 側は失敗時のみ、`retryable:true` のときに同じ鍵で最大3回まで再送する運用を推奨。

### P のタスクに足す手順（代表の承認後）

1. 環境変数を設定（§7）。値は P の秘密情報欄だけに置き、プロンプト本文・GitHub・チャットに貼らない。
2. まず `dryRun:true` で数日、P 自身の読み取り結果と分類が一致するかを代表が確認。
3. 一致を確認してから `morning_enabled=true` と dryRun なしの呼び出しに切り替える。初回の定時実行が成功したかは、その実行後に `check_148` の 8) で確かめる（事前に成功と断定しない）。

## 4. 代表レビュー画面

`admin-nippo-coach.html`（代表＝`gw_coach_config.owner_user_id` の本人だけ。API が 403 で止める）。確認日・種類を選び、名簿の数と一致、要対応・要確認（既定）／未確認／全員、各人の理由・根拠の版・不足情報・下書き・宛先全員・承認ボタン、送信候補（代表DM・日報チャンネル）とその承認。送信が無効な理由を上に出す。送信ボタンは置かない（送信は §5 の条件と別承認の後に API で）。KEIEI #150（未マージ）には依存しない。

## 5. 送信の設計（実装済み・既定OFF・実送信なし）

| 種類 | 宛先 | 本文 | 条件 |
|---|---|---|---|
| 代表向け報告 | 代表とこの bot の 1:1 DM（`owner_dm_channel_id`） | 名簿の数・名前・分類・理由の定型文・画面の場所。日報/予定の本文なし | 代表の承認（本文・宛先・世代） |
| チーム向け助言 | 承認済みの日報チャンネル（`team_channel_id`） | 2人以上に共通する傾向の定型文だけ。名前・件数・数字・メールなし（`assertTeamSafe` で作成時と送信直前に検査） | 代表の承認 |
| 本人向け助言 | 照合済み限定グループ（代表＋本人＋P、`gw_coach_recipients`） | 下書き本文 | 代表の個別承認（下書きID・本文・宛先hash）、送信直前に根拠と宛先全員を読み直し |

送信は次が全部そろったときだけ（`deliveryBlock`）：DB `enabled`・`delivery_enabled`、環境変数 `NIPPO_COACH_SEND_ENABLED=1`・bot トークン・workspace ID、DB の workspace と一致、**Slack preflight が ok で、その後 Slack 設定が変わっていない**。送る前に attempt を DB に記録（同時押しでも1回）。timeout・通信断・Slack のエラーは `delivery_unknown` にして**自動再送しない**（Slack 側で人が確認。手動解消の画面は未実装）。送信済み・不明の行は書き換えない。

### Slack preflight（読み取りのみ）

`POST /api/nippo/coach {action:"preflight"}`（代表のみ）。`auth.test` / `conversations.info` / `users.info` だけを呼び、メッセージ送信・DM 作成はしない。結果を `gw_coach_config.slack_preflight` に保存。

1. `auth.test`：workspace が `slack_team_id`、bot の user ID が `slack_bot_user_id` と一致
2. 日報チャンネル：bot がメンバー、アーカイブでない、DM でない
3. 代表の Slack ユーザー：同じ workspace、削除・bot でない、プロフィールのメールが GW の代表（`owner_user_id` の社員のメール）と一致（`users:read.email` が必要）
4. 代表 DM：`owner_dm_channel_id` がこの bot から見える `is_im` で、相手が代表だけ

注意：**別の Slack App は、既存の P bot の DM には投稿できない**。コーチ用に P と同じ bot を使うか、コーチ用 bot と代表の DM を代表が開き、その ID を設定してから preflight を通す。preflight が1つでも落ちれば送信は止まったまま。

## 6. SQL（db/148）

| ファイル | 用途 |
|---|---|
| `db/148_behavior_coach.sql` | 新規作成用（再実行は duplicate で止まる。既存表を落とさない）。表：`gw_coach_config / recipients / reviews / events / checks / outbox / runs`。全て RLS 有効・service_role のみ・authenticated/anon は表も関数も不可。トリガは日報・予定の保存時にイベント（ID のみ）を追記するだけ |
| `db/check_148_behavior_coach.sql` | 読み取り専用の点検（RLS・権限・フラグ・preflight・トリガ・送信状態・実行履歴） |
| `db/rollback_148_behavior_coach.sql` | トリガ→関数→表の順に削除。送信の記録（attempted/unknown/sent）が1件でもあれば中断。急ぎでトリガだけ外す手順を冒頭に記載 |

採番：main は 145/146 まで。open PR の使用は 143（#151/#157/#163）・144（#154）・147（#159）・148（#167＝本件）。

### ローカル PostgreSQL 16 での検証（使い捨てクラスタ・合成データのみ。リモート DB には接続していない）

- `test/sql/148_behavior_coach.sql`：78件 PASS。初期 OFF、RLS/権限、トリガ（設定 OFF/未提出/本人対応が複数では記録しない、イベント追記が失敗しても日報保存は成功）、定時確認（同じ版は unchanged・承認保持、変更で世代+1・旧承認失効、final を provisional に戻さない、別テナント拒否）、実行 lease（busy・replay・lease 切れ引継ぎ）、CAS（古い世代/token 拒否、10分 lease 切れ再取得）、送信箱（承認の束縛・変更で失効・attempt 先行・二重 attempt 拒否・unknown 固定）、check→rollback（送信記録があれば中断）→保存可→再適用。
- `test/sql/148_concurrency.sh`：11件 PASS（2セッション）。同時 claim は片方、同時記録は行1つ・世代1回、設定行をロック中でも日報保存は待たない、同時 attempt は1回、同時実行 lease は片方。
- `test/sql/run.sh` 全体：PASS 966 / FAIL 0（148 追加前 887）。

## 7. 設定（名前だけ。値はここに書かない）

環境変数（PR159 の `SLACK_AI_*` とは別名）：

| 名前 | 用途 |
|---|---|
| `NIPPO_COACH_ROUTINE_KEY` | P の定時タスクの機械認証（32文字以上のランダム値） |
| `NIPPO_COACH_TENANT_ID` | 定時確認の対象テナント |
| `NIPPO_COACH_SEND_ENABLED` | `1` のときだけ送信を許す（既定は未設定＝送らない） |
| `NIPPO_COACH_SLACK_BOT_TOKEN` | 送信・preflight に使う bot トークン（scope：`chat:write`、`channels:read`/`groups:read`/`im:read`、`users:read`、`users:read.email`） |
| `NIPPO_COACH_SLACK_TEAM_ID` | トークンの workspace（DB の `slack_team_id` と一致が必要） |

DB `gw_coach_config`（テナントごと、全部既定 false/NULL）：`enabled`、`ai_enabled`、`morning_enabled`、`delivery_enabled`、`owner_user_id`（代表の GW ユーザー）、`slack_team_id`（workspace）、`slack_bot_user_id`（送信に使う bot の user ID）、`team_channel_id`（日報チャンネル）、`owner_slack_user_id`（代表の Slack user ID）、`owner_dm_channel_id`（代表と bot の 1:1 DM）。本人グループは `gw_coach_recipients`（人が照合した送信元・代表・本人・会話 ID・3名の参加者）。

## 8. テスト

- `node test/run.mjs node`：すべて通過（新規 `behaviorcoachmorning.mjs` 29件、`behaviorcoachgoals.mjs` 27件、既存 `behaviorcoach.mjs` 29件）。日報コーチの3本は `TZ=UTC` / `Asia/Tokyo` / `America/Los_Angeles` と別パスの clone で通過を確認。時計は注入、絶対パス・固定ポートなし、Slack・AI・ネットワークは偽物だけ。
- UI：`test/ui/nippocoachui.mjs`（1280/390、承認が本文・宛先 hash に束縛、送信 API を呼ばない）。スクリーンショットは `test/_shot.mjs` の一時領域（`COACH_SHOT_DIR` で変更可）。
- モックの PASS は実 DB / 実 Slack / 本番の成功の保証ではない。

## 9. 未検証・残り

- 実データでの分類の妥当性（勤務曜日の登録率が低いと「未確認」が多くなる。これは仕様どおりだが運用で要確認）。シフト・実勤務・契約上の業務範囲の照合は記録が無く常に不足扱い。
- Sales/ENGER 等の成果物の独立照合、実所要時間の記録元（GW に無い）、本人の目標合意の保存先。
- 下書き文と原文の意味的整合（`semanticEvidenceVerified:false`）。AI 草案は未実行。
- 本物の Slack での preflight・送信、`delivery_unknown` の手動解消画面、P 側タスクへの組み込み。
- 本番相当の負荷・ロック待ち（ローカルの同時実行のみ確認）。Preview が本番 DB を見る場合は書き込みテストをしない。

## 10. 必要な承認（個別）

1. **SQL**：`db/148_behavior_coach.sql` を本番 Supabase に適用（先に隔離 DB で `check_148` を確認）。取り消しは `rollback_148`。
2. **定時確認の有効化**：環境変数 `NIPPO_COACH_ROUTINE_KEY`・`NIPPO_COACH_TENANT_ID` の設定、`gw_coach_config` の `enabled`・`morning_enabled`・`owner_user_id` 設定、P の 08:00 / 17:30 / 月曜タスクへの呼び出し追加（まず dryRun）。
3. **Slack**：使う bot（P と同じか専用か）と scope の付与、`slack_team_id`・`slack_bot_user_id`・`team_channel_id`（日報チャンネル）・`owner_slack_user_id`・`owner_dm_channel_id` の設定、preflight 実行。
4. **送信の有効化**：`delivery_enabled=true` と `NIPPO_COACH_SEND_ENABLED=1`。代表 DM・日報チャンネル・本人グループのそれぞれについて、最初の1通は送信元・全宛先・本文を代表が承認してから。
5. **AI 草案**（任意）：`ai_enabled=true`（実データを AI に渡すことの承認）。
6. マージ・本番公開。

## 計画の扱い（変更なし）

前日の終業時に次勤務日の計画を立て、当日朝に微調整し、次の日報で変更理由と成果を振り返る。計画は「何をする」「何を完了する」「最優先」を確認する。翌日分を実績日報とは呼ばない。計画変更自体を問題としない。全員への一律 DM・契約や勤務日を無視した一律義務は設定しない。
