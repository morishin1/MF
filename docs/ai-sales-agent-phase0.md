# AI営業エージェント Phase 0 調査報告・差分・設計案

- 調査日: 2026-10-10 / 対象: `morishin1/MF` の `/sales`（HEAD `a24b8b0`）
- 位置づけ: 「AI営業エージェント 機能要件定義書 v1.0」（2026-10-09）§14 の **手順1（調査）と手順2（差分と設計の提示）**。コードは1行も変えていない。
- 調査方法: コードとSQLを読んで確かめた。**本番DBの実データと、どのマイグレーションが本番に当たっているかは確認できていない**（§9 の読み取り専用SQLで確認できる）。推測は「推測」と書いた。
- 参考: `morishin1/enger_new` の `/sl` には、企業HPを取得してAIに営業文を書かせる仕組み（`docs/ops/20260910_ai_sales_api.md`）が既にある。DBも作りも別システムなので、コードは流用せず、考え方だけ借りる（§4.6）。

---

## 0. 結論（先に）

1. **対象は MF の `/sales`（`gw_sales_*`）**。企業マスタ・アタック記録・クリック計測・営業禁止（NG）・30日の重複ガード・商談・案件・分析は、すでにある。**新しい企業マスタや営業ステータスは作らず、これらに足す**。
2. **`/sales` にAIは一つもない。外部への自動送信（メール・フォーム）も一つもない**。いまのフォームアタックは「人が別タブでフォームに貼って送り、戻って［送信完了］を押す」。
   → 要件の Phase 1（自動送信は無効）は、**AIが分析と下書きを作る → 人が確認・承認する → いまの手動フローで送る**、で実現できる。送信の仕組みは新しく作らなくてよい。
3. **足りないもの**：公開情報の取得（複数ページ）、AI分析・スコア・商材の判定、AI文面、送信可否の記録、承認、AI営業の設定と緊急停止、AIの利用量と費用。
   DBは **新しい表3つ（分析・文面・設定）と、アタック記録に列を1つ** が最小（§4.2）。
4. **AIを入れる前に知っておくべき既存の穴**（AIと関係なくある）：
   - 画面とAPIは「Sales のアプリ権限」で通すのに、DBのRLSは「ロール（owner/manager/sales）」で通す。人によって「APIは通るのにDBで止まる」「その逆」が起きうる（§6-R1）。
   - いまの `gw_sales_*` のRLSは「営業なら全部読み書きできる」。**承認のような列を同じ作りで置くと、営業担当が自分の下書きを自分で「承認済み」に書き換えられる**。新しい表は「読むだけRLS＋書くのはサーバーだけ」にする（§4.5）。
   - 既存のAI呼び出し（`lib/ai.js` ほか）は、すべて「強制ツール呼び出し」（`tool_choice: {type:"tool"}`）。**Claude Opus 5.5 / Sonnet 5.5 ではこれが 400 になる**。いまの既定 `claude-opus-5` では動くが、`ANTHROPIC_MODEL` を 5.5 系に変えると既存のAI機能がまとめて止まる。AI営業は別の書き方（構造化出力）にする。
   - `lib/ai-json.js askJson` は `OPENAI_API_KEY` があると黙って OpenAI に切り替わる。AI営業では使わない。
5. **KGI の「有効企業」「本命案件」は、まだ定義がない**（`lib/keiei-targets.js` で「定義未決」）。AIスコアで「有効企業」を定義する案を出す（§8-5）。
6. 実装に入る前に **決めていただきたいことが8つ** ある（§8）。決まれば Phase 1 を **PR 3本** に分けて小さく出す（§5）。

---

## 1. 調査範囲

| 範囲 | 見たもの |
|---|---|
| DB | `db/088` `090` `094` `096` `097` `098` `101` `108` `116`（`gw_sales_*` を作る・変えるもの全部）、`119` `120` `126`（権限の関数）、`005`（`gw_activity_log`） |
| API | `api/sales/**` の全エンドポイント、`lib/sales*.js`、`lib/gw.js`、`lib/app-grants.js`、`lib/gw-audit.js`、`lib/notify.js`、`lib/mail/*`、`vercel.json` |
| 画面 | `sales/*.html`（7画面＋プレビュー）、`js/sales-layout.js`、`js/sales-detail.js`、`js/api-client.js` の Sales 関数 |
| AI基盤 | `lib/claude.js`、`lib/ai.js`、`lib/ai-json.js` ほかAIを呼ぶ所すべて、`test/aiguard.mjs` |
| KPI | `sales/analytics.html`、`lib/sales-dashboard.js`、`lib/keiei-sales.js`、`lib/keiei-targets.js` |
| テスト | `test/salesapi.mjs`、`test/ui/salesui.mjs`、`test/salesassets.mjs`、`test/sharedassets.mjs`、`test/assethash.mjs` |

---

## 2. いまある仕組み（棚卸し）

### 2.1 データ（`gw_sales_*`。RLS はすべて `gw_is_sales(tenant_id)`）

| 表 | 役割 | AI営業で使うところ |
|---|---|---|
| `gw_sales_companies` | 企業マスタ（1社1行）。`domain` はテナント内で一意（`088:194`）。`site_url` `form_url` `industry` `region` `size` `service`（提案商材）`owner_id` `status` `ng_reason` `hidden_at` `emails[]` など | **企業の正**。AI分析はこの `id` にぶら下げる |
| `gw_sales_approaches` | アタック1回＝1行（上書きしない）。`channel` `service` `subject` `body`（送った文面の写し）`employee_id`（送った人）`template_id` `campaign_id` `tracking_token` `sent_at` `failed_at` `send_failed_reason` `click_count` | **接触の正**。AI文面で送ったものも、ここに同じように記録する |
| `gw_sales_click_events` | クリックのログ（ボット・重複を除外） | そのまま |
| `gw_sales_events` | 企業のタイムライン（返信・電話・メモ・ステータス変更など。`event_key` に制約なし） | AI分析・承認をタイムラインに出す |
| `gw_sales_templates` | 営業文テンプレート（`{{company}} {{sender}} {{url}} {{service}}`） | AI文面の「型」と、AIが失敗したときの代わり |
| `gw_sales_campaigns` | キャンペーン | そのまま |
| `gw_sales_master_options` | 業種・提案サービス（商材）の選択肢。種類は `industry` と `service` の2つだけ | **商材マッチングの候補** |
| `gw_sales_meetings` / `gw_sales_deals` / `gw_sales_deal_history` | 商談（TimeRex）・案件（金額・段階） | 成果の追跡にそのまま使う |
| `gw_activity_log` | 監査ログ（`gwLog`。service_role だけが書く） | AIの操作も `sales.ai_*` で残す |

- **ステータス**：`untouched` → `attacked` → `clicked` → `replied` → `meeting` → `proposal` → `won`、ほかに `reattack_wait` `lost` `excluded`。**後戻りしない**（`lib/sales.js` `statusRank`）。
- **営業禁止**：別の表は無く、企業の `ng_reason`（`no_sales` `unsubscribed` `no_form_sales` `partner` `customer` `competitor` `other`）。NG の企業にはアタックを準備した時点で 403（`api/sales/approaches/index.js` `guard`）。
- **非表示**：`hidden_at`（理由 `link_broken` `no_info` `closed` `not_target` `duplicate` `other`）。アタックは 409。
- **重複ガード**：同じチャネルで30日以内に送っていれば 409（上書きは経営者・管理者だけ）。別チャネルでも警告。
- **二重送信の防止**：［送信完了］は `sent_at is null and failed_at is null` の行だけを更新する1回の UPDATE。2回押しても2件にならない。
- **設定の表・ジョブの表・キューは無い**。冪等キーも会計の `journals` にしか無い。

### 2.2 画面

`/sales` は独自ヘッダー（`js/sales-layout.js`）で、タブは **ダッシュボード／企業／アタック／リード／分析** の5つ。テンプレートとキャンペーンはユーザーメニューの中。

- **企業**（`companies.html`）：絞り込み11種、一括操作（ステータス・担当・提案サービス・キャンペーン・非表示・営業禁止・削除）、URLから追加（社名・フォームURL・電話・住所を自動で埋める）。詳細は右のドロワー、操作は中央のモーダル（`js/sales-detail.js`）。
- **アタック**（`attack.html` → 新しいタブで `companies.html?attack=<id>`）：テンプレートを選ぶ → 計測URLを発行 → ①サイトを開く ②フォームを開く ③営業文をコピー → 人が送る → ［送信完了］／［送信できなかった］／［送らなかった］。
- **分析**（`analytics.html`）：アタック→クリック→返信→商談→成約（いずれも**社数**）、受注額・見込額、チャネル・営業文・サービス・業種・担当者別。担当者別フォームアタック数。
- スマホ：390px で横にはみ出さないことをテストで確認している（`test/ui/salesui.mjs`）。

### 2.3 権限

- API の入口：`canSell` ＝ 経営者（owner）または Sales のアプリ権限（`lib/gw.js:182`）。
- DB の RLS：`gw_is_sales` ＝ owner・manager・sales のロール（`db/094:45`）。**アプリ権限は見ていない**。
- **担当で見える範囲を分けていない**（営業なら全社が見える。「自分の担当」は絞り込みだけ）。
- 上位の権限が要る操作は「30日以内の再アタックを強行する」だけ（経営者・管理者）。一括削除・マスタ編集・テンプレート編集は営業なら誰でもできる。

### 2.4 外部とのつながり

| もの | いまの状態 |
|---|---|
| 企業サイトの取得 | `lib/sales-lookup.js`（URLから追加用）。SSRF 対策あり・3回までリダイレクト・6秒×最大800KB。**トップページ1枚だけ**。robots.txt は見ていない。メールアドレス・「営業お断り」は拾わない |
| メール送信 | `lib/mail`（Resend）。HR と入社案内だけが使う。`MAIL_SEND_ENABLED=1` で初めて送る。**Sales は使っていない** |
| フォーム自動送信 | 無い |
| AI | Sales では使っていない。他の機能は `lib/claude.js`（既定 `claude-opus-5`、SDK `@anthropic-ai/sdk 0.39.0`）。**AIの利用量・費用の記録はほぼ無い** |
| 定期実行 | `vercel.json` の cron に Sales の分は無い。関数の `maxDuration` は `api/office/timesheet.js` の60秒だけ |
| 通知 | クリック時にベル通知と Slack。Sales はスマホのプッシュ対象外 |

### 2.5 KPI の定義（いまの正）

- `/sales/analytics`：期間内にアタックした企業を母集団に、アタック・クリック・返信・商談・成約を**社数**で数える。
- `/keiei`（`lib/keiei-sales.js`）：接触＝今月送った件数（送信できなかったものは除く）、商談＝今月案件ができた社数、提案＝提案以降に進んだ社数、有料契約＝今月成約した社数。
- 目標（`lib/keiei-targets.js`、2026年10月）：**4,000接触 → 100有効企業 → 30商談 → 15提案 → 10有料契約 → 3本命案件**。**有効企業・本命案件は「定義未決」**。

---

## 3. 要件との差分表

凡例：○ある ／ △一部ある ／ × 無い。「Phase」は本書の提案。

| ID | 機能 | いま | 再利用するもの・足すもの | Phase |
|---|---|---|---|---|
| F-01 | アタックリスト連携 | ○ | `gw_sales_companies` をそのまま使う。CSV・URL取込も既存 | 1 |
| F-02 | 企業情報整備 | △ | ドメイン正規化・ドメイン一意・CSV重複除外は既存。**URL有効性**は分析時の取得結果で記録 | 1 |
| F-03 | 公開情報調査 | △ | `lib/sales-lookup.js`（SSRF対策済み）を広げる：同じサイトの数ページ・robots.txt・取得日時と URL を保存 | 1 |
| F-04 | AI営業スコア | × | 新規。0〜100点・内訳・根拠・不確実性 | 1 |
| F-05 | 商材マッチング | × | 商材の候補は既存の `gw_sales_master_options`（service）。第1・第2候補と理由 | 1 |
| F-06 | 提案文生成 | × | 新規。既存テンプレートを「型・署名・禁止表現」の土台にする | 1 |
| F-07 | フォーム検出 | △ | `sales-lookup` が問い合わせリンクを1つ拾う。項目の識別（社名・メール等）は Phase 2 | 1（URL）／2（項目） |
| F-08 | 送信可否判定 | △ | NG・非表示・30日ガード・`send_failed_reason`（captcha・login_required・ng_notice）は既存。**「営業お断り」の検出と、判定と理由の記録**を足す | 1 |
| F-09 | 承認ワークフロー | × | 新規（文面の表に承認の列） | 1 |
| F-10 | 安全な送信実行 | × | 自動送信は作らない（Phase 2 以降） | 2 |
| F-11 | 送信証跡・状態管理 | △ | 手動分は既存（`gw_sales_approaches`）。AI文面との結び付けを足す | 1（手動）／2（自動） |
| F-12 | 反応・営業ステータス | ○ | 既存（返信・商談・案件・成約）。新しいステータスは作らない | 1 |
| F-13 | ダッシュボード | △ | 既存の分析に「AI分」の内訳を足す＋AI営業の画面 | 1 |
| F-14 | 除外・停止リスト | △ | 企業単位は既存の NG（ドメインは企業に一意なのでドメイン単位も兼ねる）。**AI全体の緊急停止**を足す | 1 |
| F-15 | AIフォロー案 | × | | 2 |
| F-16 | 反応データによる改善 | △ | 分析の内訳は既存。スコア配点の見直しは Phase 4 | 4 |
| F-17 | 担当者への引継ぎ | △ | クリック時の通知・NEXT は既存。返信検出は Phase 2 | 2 |
| F-18 | 監査・費用・品質 | △ | 監査ログ（`gwLog`）は既存。**AIのモデル・プロンプト版・トークン・費用**を足す | 1 |

---

## 4. 設計案

### 4.1 流れ（いまのフローへのはめ込み）

```
既存の企業（gw_sales_companies）
  └ ［AI分析］ ─ サイト取得（同じサイトの数ページ）→ ルール判定（営業お断り・フォーム有無）→ AI
       └ 分析結果（新：gw_sales_ai_analyses）… 要約・事実と出典URL・推測・スコア・推奨商材・送信可否
  └ ［AI文面を作る］ ─ 分析結果＋テンプレート（型）→ AI
       └ 下書き（新：gw_sales_ai_drafts）… 件名・本文・商材・理由
  └ ［承認］（人）… 承認／修正依頼／却下。承認時の本文のハッシュを残す
  └ いまのアタック画面で、承認済みの本文を使う → 人がフォームに貼って送る → ［送信完了］
       └ アタック記録（既存：gw_sales_approaches）に ai_draft_id を付けて残す（本文が承認時と同じか照合）
  └ クリック・返信・商談・案件・成約（すべて既存）
```

**状態は混ぜない**（要件 §6.1 の注意）：分析の状態は分析の表、文面の状態は文面の表、送信の状態は `gw_sales_approaches`、営業の状態は企業の `status` と案件。**企業の `status` にAI用の値は足さない**。

### 4.2 データ（新しい表3つ＋列1つ。どれも足すだけ）

**`gw_sales_ai_analyses`**（企業ごとの分析。履歴を残す。最新は `created_at` が最大の行）

| 列 | 内容 |
|---|---|
| `id` `tenant_id` `company_id` | 企業は既存の `gw_sales_companies.id`（cascade） |
| `status` | `ok` / `site_unreachable` / `ai_failed` |
| `summary` | 企業概要（公開情報だけ） |
| `facts` jsonb | `[{text, source_url}]`。**出典URLのない事実は保存しない**（サーバーで落とす） |
| `hypotheses` jsonb | 推測（「推測」として別に持つ） |
| `uncertainties` jsonb | 追加で確認すること |
| `score` smallint (0..100)・`score_detail` jsonb | 配点ごとの点と理由。重みは分析した時点のものを写して残す（あとで重みを変えても再現できる） |
| `priority` | `high` / `mid` / `low` |
| `services` jsonb | `[{service, rank, reason}]`。`service` は商材マスタの値 |
| `send_check` | `blocked` / `manual_review` / `ok_manual`（§4.8） |
| `send_check_reasons` jsonb | 判定の理由（例：「営業お断り」の記載・該当ページURL） |
| `pages` jsonb | 取得したページ `[{url, fetched_at, ok, status, bytes}]` |
| `model` `prompt_version` `input_tokens` `output_tokens` `cost_usd` | 再現と費用 |
| `created_by` `created_at` | |

**`gw_sales_ai_drafts`**（AI文面。版を残す）

| 列 | 内容 |
|---|---|
| `id` `tenant_id` `company_id` `analysis_id` `template_id` | |
| `channel` | まずは `form` のみ |
| `service` `subject` `body` `rationale` | 商材・件名・本文・社内向けの理由 |
| `version` | 再生成・手直しのたびに増やす |
| `status` | `draft` → `pending` → `approved` / `rejected` → `used`（送った）/ `superseded`（新しい版に置き換え） |
| `edited_by` `edited_at` | 人が手直ししたか（AIの値と人が確定した値を分ける） |
| `requested_by` `requested_at` | 承認の申請 |
| `decided_by` `decided_at` `decision_note` | 承認・却下 |
| `approved_body_hash` | 承認したときの本文のハッシュ。**送るときに照合し、違えば再承認** |
| `approach_id` | 送ったアタック（既存）への結び付け |
| `model` `prompt_version` `input_tokens` `output_tokens` `cost_usd` `created_by` `created_at` | |

- 一意制約：1社につき `pending` と `approved` の下書きは1つまで（部分インデックス）。重複して承認待ちが積まれない。

**`gw_sales_ai_settings`**（テナントに1行）

| 列 | 内容 |
|---|---|
| `tenant_id` (PK) | |
| `enabled` | AI営業を使うか（既定 false）。**false＝緊急停止**。分析・文面・承認のAPIがすべて止まる |
| `score_weights` jsonb | 既定は要件の仮置き（商材適合35・課題の兆候25・業種規模15・地域10・既存接点10・鮮度5） |
| `service_priority` jsonb | 商材の優先度 |
| `daily_limit` `monthly_budget_usd` | 1日の分析件数・月の費用の上限（超えたら止まる） |
| `self_approval` | 自分の下書きを自分で承認してよいか |
| `signature` `banned_phrases` jsonb | 署名・禁止表現 |
| `updated_by` `updated_at` | |

**既存への列追加（1つ）**：`gw_sales_approaches.ai_draft_id`（null可）。AI文面で送ったアタックを見分ける。**接触の数え方は変えない**（AIで送っても人が送っても1件。§4.9）。

**作らないもの**：企業マスタ（既存）／営業ステータス（既存）／除外リストの表（企業の NG で足りる。ドメインは企業に一意）／送信ジョブ・送信試行の表（自動送信は Phase 2）／AIの利用量の表（分析と文面の行にトークンと費用を持たせ、合計で上限を見る）。

**RLS**：3表とも **SELECT だけを `gw_is_sales(tenant_id)` で許可し、INSERT・UPDATE・DELETE のポリシーは置かない**。書き込みはAPIが権限を確かめてから service_role で行う。承認の列を営業担当が直接書き換えられないようにするため（§0-4）。陰性テスト（見えてはいけない・書けてはいけない）を足す。

### 4.3 API（`api/sales/ai/*`。どれも `canSell` を通したうえで設定 `enabled` を確認）

| API | 内容 |
|---|---|
| `GET /api/sales/ai/analysis?companyId=` | 最新の分析と履歴 |
| `POST /api/sales/ai/analysis {companyId}` | 1社を分析（同期。取得＋AIで最大60秒。`maxDuration: 60`） |
| `POST /api/sales/ai/drafts {companyId, templateId?}` | 文面を作る・作り直す |
| `PATCH /api/sales/ai/drafts {id, action: edit / request / approve / reject}` | 手直し・承認申請・承認・却下 |
| `GET /api/sales/ai/queue` | 承認待ち・承認済み・却下の一覧（AI営業の画面） |
| `GET/PATCH /api/sales/ai/settings` | 設定・緊急停止（経営者・管理者だけ） |
| 既存 `POST/PATCH /api/sales/approaches` | `aiDraftId` を受け取る。準備時に「承認済みか・停止中でないか・NGでないか」を**もう一度**確かめ、［送信完了］で本文のハッシュを照合する |

まとめて分析するのは、Phase 1 では **画面から1社ずつ順番に呼ぶ（同時2件まで・上限件数あり）**。キューの表は作らない。数百社を夜に回すなら Phase 1.5 で cron＋Batch API（費用が半分。§7）。

### 4.4 画面

- **企業の詳細ドロワー**に「AI分析」の欄：スコア・推奨商材・要約・**事実（出典リンク付き）と推測を分けて表示**・送信可否と理由・取得日時。［AI分析する］［作り直す］。
- **アタック画面**：テンプレートの選択肢に「AI文面（承認済み）」を足す。承認待ちならその旨を出し、送れない。
- **新しい画面「AI営業」**（タブを1つ足す）：
  - 一覧：未分析／分析済み／文面あり／承認待ち／承認済み／却下（担当・スコア・商材で絞り込み）
  - 承認：相手企業・根拠URL・文面プレビュー・手直し・［承認］［修正依頼］［却下］
  - 数字：分析数・承認数・送信数（AI分）・クリック・返信・商談・成約・今月のAI費用
  - 設定（経営者・管理者）：有効／停止、配点、商材の優先度、上限、署名、禁止表現
- スマホでは「承認」と「停止」を押せることを優先（要件 §13）。
- 共有の js・css を変えるときは版（`?v=`）を上げる（`test/assethash.mjs`）。`/sales` の画面数は `test/salesassets.mjs` が「7つ」で見ているので、画面を足すならそこも直す。

### 4.5 権限

| 操作 | 誰が |
|---|---|
| 分析を見る・分析する・文面を作る・手直し・承認申請 | 営業（`canSell`） |
| 承認・却下 | **経営者・責任者（owner / manager）**。自己承認は設定で許したときだけ（決めていただきたい。§8-2） |
| 設定・緊急停止 | 経営者・管理者 |

判定はサーバーで行う（画面で隠すだけにしない）。新しい関数（例：`canApproveAiSales`）は `lib/gw.js` に置き、テストで「営業担当は承認できない」を確かめる。

### 4.6 AI

- **モデル**：既定は **Claude Opus 5.5**（`claude-opus-5-5`）。安くするなら Sonnet 5.5 / Haiku 5.5（費用は §7。**選ぶのは決めていただきたい**。§8-3）。環境変数で切り替えられるようにする（`SALES_AI_MODEL`）。
- **出力**：構造化出力（JSON スキーマ）。Opus 5.5 / Sonnet 5.5 は強制ツール呼び出しが 400 なので、既存の `lib/ai.js` の書き方は使わない。返ってきた JSON はコードでもう一度検証し、範囲外の点数・マスタに無い商材・出典URLが取得したページに無い「事実」は落とす。
- **SDK**：いまの `@anthropic-ai/sdk 0.39.0` が構造化出力に対応しているかを PR1 の最初に確かめる。上げる場合は、既存のAI機能のテストを全部回す。
- **AIにWeb検索をさせない**：サーバーで取得したページ本文だけを渡す。enger_new の経験では、URLを渡して「調べて」と頼むと、HPに無い実績や規模を作文する。
- **プロンプトインジェクション対策**：ページ本文は「データ」として区切って渡し、本文中の指示には従わないとシステムプロンプトに書く。AIに何かを実行させる道具は渡さない（出力はJSONだけ）。
- **プロンプトの版**（`prompt_version`）を分析・文面の行に残す（既存の `nippo-eval` などと同じ）。
- **失敗したとき**：分析は「失敗」として残し、文面は既存テンプレートで代わりに出せるようにする（AIが無くても営業は止まらない）。
- **断られたとき**（`stop_reason: refusal`）：記録して失敗扱い。Opus 5.5 ではサーバー側の代替（`fallbacks: "default"`）を付ける。

### 4.7 公開情報の取得

`lib/sales-lookup.js`（SSRF 対策・文字コード対応済み）を広げる：

- トップページ＋同じサイトの **会社概要・事業内容・お問い合わせ** を最大3ページ（リンク文字とURLで選ぶ）。他のサイトには行かない。
- **robots.txt を確認**し、拒否されたページは取らない（取れなかった理由を残す）。
- 1ページ6秒・800KBまで（いまと同じ）。合計の上限も持つ。
- ログイン・CAPTCHA・アクセス制限は**回避しない**（取れなければ「取れなかった」と記録）。
- 取得したURLと日時を `pages` に残す。

### 4.8 送信可否の判定

いまは人が手で送るので、判定は **「手動で送ってよいか」** と **「自動で送ってよいか」** を分ける。

| 判定 | 条件 | Phase 1 の扱い |
|---|---|---|
| `blocked` | 企業が NG・非表示・成約/失注/対象外／サイトに「営業お断り」「売り込み禁止」等の記載（ルールで検出＋AIで確認）／過去に断られた | 文面は作れても**送れない**（アタックの準備で止める） |
| `manual_review` | 判断できない（ページが取れない、規約が読めない、記載があいまい） | 人が確認して `ok_manual` か `blocked` を選ぶ |
| `ok_manual` | 上のどれにも当たらない | **人が手で送ってよい**（いまの運用と同じ） |
| （自動送信可） | 営業利用と自動操作を認める根拠を確認済み | **Phase 1 では誰も選べない**（要件 §5.3 の `allowed`。Phase 2 で検討） |

「営業お断り」を検出したら、企業に `ng_reason = 'no_sales'` を付けるかを人に聞く（自動では付けない）。

### 4.9 KPI（二重計上しない）

- **接触**はいまと同じ `gw_sales_approaches`（送信完了）で数える。AI文面で送っても1件。`ai_draft_id` があるものを「AI分」として内訳に出すだけ。
- 返信・商談・成約は既存の定義のまま。AI分析の数・承認数・AI費用は AI営業の画面で別に出す。
- 「承認した」「分析した」は接触ではない（数えない）。

---

## 5. Phase 1 の実装順（PR 3本。どれも外部送信なし・本番DBは手動で適用）

| PR | 中身 | 確かめること |
|---|---|---|
| **PR1 分析** | マイグレーション（3表＋列、読むだけRLS）、取得の拡張、ルール判定、AI分析API、企業ドロワーの「AI分析」欄、設定の `enabled`（既定 off） | AIを偽物に差し替えたテスト（出典の無い事実を落とす・範囲外の点・停止中は 403・費用上限）、SSRF・robots、RLS の陰性テスト、1280/768/390 |
| **PR2 文面と承認** | 文面API・承認・アタック画面との結び付け・本文ハッシュの照合 | 未承認では送れない／承認後に本文を変えたら再承認／NG・停止中は準備で止まる／自己承認の可否／二重送信が起きない |
| **PR3 AI営業の画面** | 一覧・承認・数字・設定・緊急停止 | 権限外は設定を開けない（サーバーで 403）、スマホで承認と停止、既存の分析の数字が変わらない |

各PRで：マイグレーション案と確認SQL・画面URL（Preview）・テスト結果・既存機能への影響を出す。**本番DBへの適用・マージ・本番反映は、別に承認をいただいてから**（要件 §14-6）。

---

## 6. リスクと対策

| # | リスク | 対策 |
|---|---|---|
| R1 | API と RLS で営業権限の判定が違う（アプリ権限 vs ロール） | 新しい表は読むだけRLS＋サーバー書き込みにして影響を受けにくくする。ズレそのものの是正（RLS をアプリ権限に合わせる）は別PRで提案 |
| R2 | 承認の列を営業担当が直接書き換える | §4.2 の RLS（書き込みポリシーを置かない） |
| R3 | AIの作り話（実績・規模・課題の断定） | 取得した本文だけを渡す／出典URL必須／推測は別欄／人の承認 |
| R4 | プロンプトインジェクション | 本文はデータとして区切る／AIに実行の道具を渡さない／出力はスキーマ検証 |
| R5 | 費用の暴走 | 1日の件数・月の予算の上限、行ごとのトークンと費用、超えたら止まる |
| R6 | 関数の時間切れ（取得4ページ＋AI） | `maxDuration: 60`、ページと合計の時間上限、AIの出力上限 |
| R7 | 既存AIの強制ツール呼び出しが 5.5 系で 400 | AI営業は構造化出力で書く。既存側は `ANTHROPIC_MODEL` を 5.5 系に変えないよう注意（変えるなら別PRで移行） |
| R8 | 共有の js・css の1年キャッシュ | 版を上げる（`test/assethash.mjs` `test/salesassets.mjs` `test/sharedassets.mjs`） |
| R9 | `gw_sales_company_list`（db/098）の `c.*` は作った時点の列で固定 | 企業に列を足しても一覧のビューには出ない（今回は企業に列を足さない） |
| R10 | 法令・規約 | 自動送信は作らない。Phase 2 の前に専門家の確認（要件 §11-10） |

---

## 7. 費用の概算（2026-10 時点の公開価格。為替は含めない）

1社あたり：分析＝入力 約1万トークン（ページ本文＋指示）・出力 約3千トークン（JSON＋思考）、文面＝入力 約4千・出力 約2千、として。

| モデル | 価格（入力／出力・100万トークンあたり） | 1社（分析＋文面） | 1,000社 |
|---|---|---|---|
| Claude Opus 5.5 | $4 ／ $20 | 約 $0.16 | 約 $160 |
| Claude Sonnet 5.5 | $2 ／ $10 | 約 $0.08 | 約 $80 |
| Claude Haiku 5.5 | $0.10 ／ $0.50 | 約 $0.004 | 約 $4 |

- 思考の量で出力は増減する（概算）。実際の値は分析・文面の行に残すトークンで分かる。
- 夜にまとめて回す（Batch API）と約半額。指示の部分はキャッシュで安くなる（ただし最小の長さに満たないと効かない）。
- 例：月に1,000社を分析すると Opus 5.5 で約 $160。4,000社なら約 $640。

---

## 8. 決めていただきたいこと

| # | 決めること | 提案（このままでよければ「OK」で進めます） |
|---|---|---|
| 1 | **商材の一覧**：要件の7つ（8EC／8RENT／ENGER・SES／AI・DX診断・受託開発／無限道場・AI教育／EIGHT SPACE／地方創生・地域DX）と、いまの提案サービスのマスタ（AI / DX・システム開発・PCレンタル・ホームページ改善・地方創生・ENGER・その他）が合っていない | マスタに **8EC・8RENT・無限道場・EIGHT SPACE** を足す。「PCレンタル→8RENT」「ENGER→ENGER/SES」のように名前を変えるかは別に決める（名前の変更は、その商材の企業すべてに反映される）。本番の一覧は §9 のSQLで確認 |
| 2 | **承認する人**：自己承認を許すか | 承認は **経営者・責任者**。営業担当の自己承認は **最初は許さない**（設定で変えられる） |
| 3 | **AIのモデルと月の予算** | 既定は **Claude Opus 5.5**。予算の上限は月 **$200**（約1,200社分）から。安くしたいなら Sonnet 5.5 |
| 4 | **送る人の名前・署名・返信の受け皿** | 本文の差出人は送る本人の名前（いまの `{{sender}}`）。会社の署名（社名・住所・電話・URL）は設定で1つ持つ |
| 5 | **「有効企業」の定義**（KGI の100社） | 「AIスコアが閾値（例 60点）以上で、送信可否が `ok_manual`、かつ今月アタックした企業」。本命案件は別に決める |
| 6 | **配点** | 要件の仮置き（35/25/15/10/10/5）で始め、Phase 4 で成約実績から見直す |
| 7 | **取得するページ** | トップ＋会社概要・事業内容・お問い合わせの最大3ページ、robots.txt に従う |
| 8 | **最初に試す対象** | 1つの商材・1つのキャンペーンで、20〜50社から |

---

## 9. 本番で確かめること（読み取り専用のSQL）

どのマイグレーションが本番に入っているか、と商材マスタの中身。**書き込みはしない**。

```sql
-- 1) Sales の表と列（096/097/098/101/108/116 が入っているか）
select table_name, count(*) as columns
  from information_schema.columns
 where table_schema = 'public' and table_name like 'gw_sales_%'
 group by table_name order by table_name;

select column_name from information_schema.columns
 where table_name = 'gw_sales_companies'
   and column_name in ('hidden_at','contacts','last_sent_at','click_count','status_rank','last_click_at','emails');

-- 2) 提案サービス（商材）のマスタ
select kind, label, archived_at is not null as archived
  from gw_sales_master_options order by kind, sort_order, label;

-- 3) 企業の数と、ステータス・NG・提案サービスの内訳
select status, count(*) from gw_sales_companies group by status order by 2 desc;
select coalesce(ng_reason,'(なし)') as ng, count(*) from gw_sales_companies group by 1 order by 2 desc;
select coalesce(service,'(なし)') as service, count(*) from gw_sales_companies group by 1 order by 2 desc;

-- 4) サイトURL・フォームURLが入っている企業の数（AI分析の対象になりうる数）
select count(*) filter (where site_url is not null) as with_site,
       count(*) filter (where form_url is not null) as with_form,
       count(*) as total
  from gw_sales_companies where hidden_at is null and ng_reason is null;
```
