# 無限道場リード → 採用HR（/api/hr/leads）

無限道場LP（mugendojo.jp。リポジトリは `eight-its/lms`、Supabase のプロジェクトも別）から入ったリードを、
グループウェアの採用HR（`gw_hr_applicants`）へ自動で登録し、カジュアル面談まで追えるようにする。

**新しいCRMは作らない。** リードは採用候補者と同じ表に入れ、`lead_category` で分ける。
面談（`gw_hr_interviews`）・タイムライン（`gw_hr_timeline`）・TimeRex 連携・通知は既存のものを使う。

```
mugendojo.jp（ブラウザ）
  → lms のサーバー（検証・lms.trial_applications に控え＝outbox）
  → POST /api/hr/leads（HMAC 署名・サーバー間だけ）
  → gw_hr_applicants（lead_category = mugendojo, status = scheduling）
  → TimeRex（無限道場のカジュアル面談の予約枠）
  → /api/hr/timerex/webhook → gw_hr_interviews・status = interview_scheduled
```

## 準備

| 何を | どこで |
|---|---|
| `db/118_hr_leads.sql` を実行 | Supabase の SQL Editor（べき等） |
| `MUGENDOJO_LEAD_SECRET` | MF（Vercel）と lms（Vercel）の両方に**同じ値**。32文字以上のランダムな文字列 |
| `HR_LEAD_TENANT_ID` | MF（Vercel）。リードを入れるテナントの UUID。リクエストからは決めない |
| `TIMEREX_MUGENDOJO_CASUAL_URL` | MF（Vercel）。無限道場のカジュアル面談の予約ページ URL（任意。あれば予約URLを返す） |
| 通知先（運営担当） | `gw_hr_lead_watchers` に社員を登録。未設定なら採用HRの担当（経営者・人事・採用担当）へ届く |

`db/118` を流す前でも、既存の採用HRは今までどおり動く（`/api/hr/leads` だけが `503 not_ready` を返す）。

## リクエスト

`POST /api/hr/leads`（`Content-Type: application/json`）

| ヘッダー | 値 |
|---|---|
| `x-lead-timestamp` | 送った時刻（UNIX 秒）。前後5分を超えると `401 timestamp_out_of_range` |
| `x-lead-signature` | `v1=` + hex( HMAC-SHA256( `MUGENDOJO_LEAD_SECRET`, `${timestamp}.${canonicalJson(body)}` ) ) |

`canonicalJson` は「キーを辞書順に並べ、空白なしで書いた JSON」（`undefined` のキーは落とす）。
実装は `lib/hr-leads.js` の `canonicalJson` が正。lms 側（`src/lib/hr-lead-client.ts`）も同じ並べ方をする。
生の本文ではなくこれに署名するのは、Vercel が本文を先に読んでしまい、生のバイト列を確実には取れないため。

### 本文

| キー | 必須 | 内容 |
|---|---|---|
| `submission_id` | ○ | 送信ごとの一意な ID（lms の `trial_applications.id`）。同じ ID の再送は何も変えない |
| `name` | ○ | 氏名（100文字まで） |
| `email` | ○ | メール。小文字・前後の空白なしにそろえて保存する |
| `phone` | | 電話（任意。数字・`+-() ` のみ） |
| `prefecture` / `occupation` | | 都道府県 / 現在の状況・職業 |
| `ai_experience` / `it_experience` | | AI経験 / IT経験 |
| `interests` | | 興味・目的（文字列の配列、10個まで） |
| `challenge_text` | | 挑戦してみたいこと（1000文字まで） |
| `diagnosis_type` / `diagnosis_label` | | 適性診断の結果（例 `biz` / 「事業・サービスづくりタイプ」） |
| `source_url` / `landing_page` / `referrer` | | 送信したページ / 最初に来たページ / 参照元（http(s) のみ保存） |
| `utm_source` / `utm_medium` / `utm_campaign` / `utm_content` / `utm_term` | | UTM |
| `first_touch_at` | | 最初に LP へ来た時刻（ISO8601） |
| `lead_type` | | 既定 `mugendojo_casual` |

### 返り値

| 状態 | 本文 |
|---|---|
| 200 | `{ ok: true, applicantId, result: "created" \| "updated" \| "replayed", schedulingUrl }` |
| 400 | `{ ok: false, error: "invalid_body", field, detail }` |
| 401 | `unauthorized`（署名なし・違う）/ `timestamp_out_of_range` |
| 429 | `rate_limited`（同じ人10分5回・テナント全体の新規10分60件） |
| 503 | `not_configured`（鍵・テナント未設定）/ `not_ready`（db/118 未実行） |

lms 側は **2xx だけを「送れた」とする。** 4xx の `invalid_body` は直さない限り何度送っても同じなので
再送しない。それ以外（401・429・5xx・通信の失敗）は outbox に残して再送する。

## 保存のされ方

| 列 | 中身 |
|---|---|
| `lead_category` | `mugendojo`（採用は既定の `recruitment`） |
| `stage` / `status` | `applied` / `scheduling`（日程調整中）。予約で `casual_interview` / `interview_scheduled` |
| `source` / `job_title` | `無限道場LP` / `無限道場 カジュアル面談` |
| `utm_source` / `utm_medium` / `utm_campaign` | 最初に来たときの値（媒体別に数える軸） |
| `attribution` | `{ first, last, submission_ids, touches, lead_type, source_type }` |
| `lead_profile` | 都道府県・現在の状況・AI/IT経験・興味・挑戦したいこと・適性診断 |
| `last_contacted_at` | 最終接触日時（送信のたびに更新） |

### 重複

- 同じ人 ＝ テナント ＋ `lead_category = mugendojo` ＋ 小文字のメール。一意索引
  `uq_gw_hr_applicants_mugendojo_email` で DB 側でも止める。
- 同じ人がもう一度送ったら、新しく作らずに更新する（興味は足し合わせ、診断・流入の `last`・最終接触日時は最新、
  空の値では消さない、名前は変えない）。タイムラインに「再送信」を残す。見送り・完了の人でも状態は変えない。
- 同じ `submission_id` の再送は何も変えない（`replayed`）。
- **採用の応募者に同じメールがあっても統合しない。** 無限道場の行を別に作り、タイムラインに
  「同じメールアドレスの応募者が別にいます（統合していません）」と残す。

### 通知

`gw_notifications`（kind = `hr`）に「無限道場の新しいカジュアル面談リードが入りました」。
宛先は `gw_hr_lead_watchers`（`lead_category = mugendojo`）の社員。未設定なら採用HRの担当
（経営者・人事・採用担当）。1リード1件（`dedupe_key = hr_lead:<応募者ID>`）で、再送では同じ通知を最新にする。

### 監査ログ

`gw_activity_log` に `hr.lead_intake`（`result`・`submissionId`・`utmSource`・`utmMedium`）。
メールアドレス・氏名・本文は残さない。

## 手で試す

```bash
BODY='{"submission_id":"manual-0001","name":"テスト 太郎","email":"test@example.jp","utm_source":"manual"}'
TS=$(date +%s)
SIG="v1=$(node -e 'const c=require("crypto");const s=process.argv[1],t=process.argv[2],b=JSON.parse(process.argv[3]);
const cj=v=>v===null||typeof v!=="object"?JSON.stringify(v??null):Array.isArray(v)?"["+v.map(cj).join(",")+"]":"{"+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+":"+cj(v[k])).join(",")+"}";
process.stdout.write(c.createHmac("sha256",s).update(t+"."+cj(b)).digest("hex"))' "$MUGENDOJO_LEAD_SECRET" "$TS" "$BODY")"
curl -sS -X POST https://<MFのドメイン>/api/hr/leads -H 'content-type: application/json' \
  -H "x-lead-timestamp: $TS" -H "x-lead-signature: $SIG" -d "$BODY"
```

テストは `test/hrleadsapi.mjs`（`npm test` に含まれる）。
