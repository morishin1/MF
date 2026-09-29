# /office（月末月初業務管理）migration 案

**未適用のものは、まだどの SQL も本番に適用していません**（`db/099`・`db/100` は作成済みで未適用、101 番台は案のみ）。
要件は `office_monthly_operations_requirements.md`、調査結果は Phase 1 のレポートにあります。

## 1. 方針（決定済み）

| # | 方針 | 理由 |
|---|---|---|
| 1 | 月次処理の基準レコードは **`gw_billing_progress`**（対象月×要員×現場契約で一意）。新しい月次進捗テーブルは作らない | 要件 §6。既存の月初作業管理・cron・提出フォームを壊さない |
| 2 | **加算のみ**。既存の列は変更・削除・型変更しない。追加する列は nullable か default 付き | 既存 API・cron の書き込みが、そのまま通る |
| 3 | 全体ステータス（月次完了／対応中／要確認）は**保存せず、各工程の事実から導出**する（`lib/office.js`） | 保存すると、工程を直したときに古くなる（二重管理） |
| 4 | 契約条件は **`gw_site_contract_terms`**（適用開始日つき）に持つ。コードに固定しない | 要件 §7・§8・§44（月途中変更） |
| 5 | **請求書は「1請求書＝1要員」にしない。請求書ヘッダ＋請求明細**（売上・仕入とも）。`gw_billing_progress` 1行と請求書1枚を1対1で固定しない | §3 |
| 6 | Office の新しい表は **`gw_is_office`** で RLS を掛ける | 要件 §13。DB でも権限のない人には取得不可 |
| 7 | `gw_month_closings` は使わない。Office の月次完了は別に持つ | 要件 §6。打刻ロックの副作用があるため |
| 8 | 履歴は **`gw_office_events`**（人が読む文＋名前のスナップショット） | 既存の `gw_activity_log` は機械名で、Office の役割では読めない |
| 9 | **既存 `unit_price` の意味は、確認できるまで変更しない**。新設する単価は `sales_unit_price` / `purchase_unit_price` に分ける | §4 |
| 10 | **既存の月初4表の RLS は、`/office` に統合するまで広げない（方針A）**。人事が請求額・単価・仕入額まで見える方向にはしない | §2 |

## 2. 権限：4つのシステムを混同しない

| 権限（メンバー管理の社内権限） | HR | Sales | Office | 経営 `/keiei` |
|---|:-:|:-:|:-:|:-:|
| 経営者（owner） | ○ | ○ | ○ | ○ |
| 責任者（manager） | ○ | ○ | ○ | **×** |
| 人事（hr） | ○ | × | × | × |
| 採用担当（recruiter） | ○ | × | × | × |
| 営業担当（sales） | × | ○ | × | × |
| 経理（finance） | × | × | ○ | × |
| IT・管理（it）／社労士／会計側の管理者だけ／一般メンバー | × | × | × | × |

- 判定は `lib/gw.js` の `canAccessHr` / `canAccessSales` / `canAccessOffice` / `canAccessKeiei` に集約。DB は `gw_is_recruiting` / `gw_is_sales` / `gw_is_office` / `gw_is_keiei`。画面は `/api/me` の `access` だけで出し分ける（役割名を持たない）。`test/accessparity.mjs` が一致を機械で見る
- **二段階認証**：Office・`/keiei` に入れる役割（経営者・責任者・経理）は、すべて MFA 対象。Office・`/keiei` の API は、強制日（2026-10-01）を待たず**最初から aal2 必須**（`requireMfa(…, { strict: true })`）。新しい機能で、猶予を与える相手がいないため
- **`/keiei` はこれから作る**。責任者にも公開しない。**HR から給与・人件費など経営情報が見えないことは、`/keiei` を実装するときに必ず分離する**（HR の `gw_is_recruiting` と別の関数・別の表で持つ。HR の権限で読める表に、経営情報を置かない）

## 3. 番号と適用順

適用は Supabase の SQL Editor に貼って Run（べき等に書く）。**SQL を先に流してから、アプリをデプロイする**。

| 番号 | Phase | 内容 | 状態 |
|---|---|---|---|
| 099 | 0 | `gw_is_recruiting` に責任者を追加、`gw_is_office` を新設 | 作成済み・未適用 |
| 100 | 2 | `gw_is_keiei` を新設。`/office` 一覧が読む4表に、`gw_is_office` の**読み取りだけ**のポリシーを足す | 作成済み・未適用 |
| 101 | 3 | 履歴表・通知 kind・提出の拡張・月次レコードの拡張（勤務表の状態） | 案 |
| 102 | 3〜4 | 契約条件（適用開始日つき）・現場契約の拡張 | 案 |
| 103 | 3 | 勤務表の読取結果と日別データ | 案 |
| 104 | 5 | 売上請求書（ヘッダ＋明細） | 案 |
| 105 | 6 | 発注・仕入請求書（ヘッダ＋明細） | 案 |
| 106 | 7 | 支払 | 案 |
| 107 | 8 | 月次確定（任意。確定後の変更を履歴に残すため） | 案 |

**Phase 2 が動くための条件**：099 → 100 → デプロイ。100 を先に流さないと、責任者・経理は `/office` を開けても一覧が空になる
（`/api/office` は、その状態を検知して「権限の設定が未適用」と画面に出す。「今月は何も無い」と見間違えない）。

## 4. 各 migration の中身（案）

### 099・100：権限（作成済み）

- 099：`gw_is_recruiting` に manager を追加（HR：経営者・責任者・人事・採用担当）、`gw_is_office`（経営者・責任者・経理）を新設
- 100：`gw_is_keiei`（経営者のみ）を新設。`gw_site_contracts` / `gw_billing_progress` / `gw_submissions` / `gw_partner_companies` に `gw_is_office` の SELECT ポリシーを**足す**。既存ポリシー（`is_tenant_staff`）は変えない。書き込みは足さない。人事には広げない

### 101：履歴・提出・月次レコードの拡張

- **`gw_office_events`**（新設）：`tenant_id`, `billing_progress_id`（null 可＝月全体の出来事）, `kind`, `label`（人が読む文。例「勤務表を確認済みに変更」）, `detail` jsonb（from/to）, `actor_id`, `actor_name`（名前のスナップショット）, `created_at`。追記のみ。RLS は `gw_is_office`
- **`gw_notifications.kind`** の CHECK に `'office'` を足す（db/088 と同じ「値のマージ式」）。
  **これを先に適用しないと、`notify()` が黙って失敗する**（`lib/notify.js` は失敗を握りつぶすため、cron が何も送れないまま 200 になる）
- **`gw_submissions`** に追加：`sha256 text`（重複検知）, `uploaded_by uuid`, `source text default 'external'`（外部提出／管理者アップロード）, `status text default 'submitted'`（submitted / revision_requested / confirmed / superseded）。`(employee_id, site_contract_id, target_month, kind, sha256)` の**部分ユニーク**（`sha256 is not null`）
- **`gw_billing_progress`** に追加（すべて nullable）：
  - 勤務表の確認：`timesheet_confirmed_at`, `timesheet_confirmed_by`, `timesheet_revision_requested_at`
  - 稼働の確定：`work_minutes int`, `work_confirmed_by uuid`
  - 確定時の計算根拠：`calc_snapshot jsonb`（確定時に使った契約条件・丸め・内訳。過去月を現在値で再計算して壊さないため）
  - 担当：`owner_employee_id uuid`
  - **請求額・仕入額はここに持たない**。請求書の明細（104・105）に持つ（1請求書に複数行が入るため）

勤務表の状態（未提出／提出済／修正依頼中／確認済）は、**保存せず導出する**：

| 状態 | 条件 |
|---|---|
| 未提出 | 提出が 0 件 |
| 提出済 | 提出あり、かつ確認・修正依頼なし |
| 修正依頼中 | `timesheet_revision_requested_at` が最新の提出より新しい |
| 確認済 | `timesheet_confirmed_at` あり |

### 102：契約条件（適用開始日つき）

- **`gw_site_contract_terms`**（新設）：`site_contract_id`, `valid_from date not null`, `valid_to date`,
  **`sales_unit_price`（売上単価）・`purchase_unit_price`（仕入単価）**, `unit_price_type`（月額／時給／日給）,
  `settle_min_minutes`, `settle_max_minutes`, `settle_unit_minutes`（15／30）, `rounding`（floor／ceil／round）, `rounding_scope`（day／month）,
  `over_rate`（超過単価）, `under_rate`（控除単価）, `prorate boolean`（日割り有無）, `tax_rounding`（既定 floor）, `payment_terms`（支払条件）, `note`
  - 期間の重複は入れられない（同一契約で `valid_from` が重ならない制約）
  - 月をまたぐ変更は「期間別に計算してから合算」（要件 §8）
- **`gw_site_contracts`** に追加：`project_name text`（案件名）, `partner_company_id uuid`（BP 会社。現状は要員経由でしか辿れない）
- **既存の `unit_price` / `unit_price_type` / `settlement_condition` は、そのまま残し、意味を変更しない**。新しい単価列へは、**意味を確認してから**移行する（§6）。移行するまで、構造化した条件が未入力の契約は、計算せず「契約条件不足（要確認）」にする

### 103：勤務表の読取（draft → 人が確認 → confirmed）

`lib/contracts.js` と `db/029` の型に合わせる。AI の結果は**自動確定しない**。

- **`gw_office_timesheet_reads`**（新設）：`submission_id`, `status`（pending／processing／completed／failed）, `extracted jsonb`（AI の生値を保持）, `ai_confidence`, `unreadable text[]`, `confirmed_by`, `confirmed_at`
- **`gw_office_timesheet_days`**（新設）：`read_id`, `work_date`, `ai_start/ai_end/ai_break_minutes`, `start/end/break_minutes`（人の確定値）, `worked_minutes`, `needs_review boolean`, `review_reason`。休憩が不明な行は補完せず `needs_review`

### 104・105：請求書は「ヘッダ＋明細」（1請求書＝1要員にしない）

実務では、次の**両方**がある。どちらも、1枚の請求書に複数の要員・複数の案件が入る。

```
仕入請求書（BP会社 → 自社）                    売上請求書（自社 → 客先）
├ Aさん / ○○案件 / 160h                        ├ Aさん / ○○案件 / 160h
├ Bさん / ○○案件 / 152h                        ├ Bさん / △△案件 / 152h
└ Cさん / △△案件 / 168h                        └ Cさん / ○○案件 / 168h
```

**関係**（`gw_billing_progress` は「要員×契約×月」の1行。請求書とは1対1にしない）：

- 請求書（ヘッダ）1 ── n 明細
- 明細は `billing_progress_id` で、月次レコードの1行を指す
- 月次レコード1行は、売上側に 0〜n 個・仕入側に 0〜n 個の明細を持ちうる（再発行・分割・訂正）
- 二重請求を防ぐため、同じ月次レコードが**有効な売上請求書**に載るのは1回だけ（明細の部分ユニーク。取り消した請求書は数えない）

**`gw_office_sales_invoices`（ヘッダ）**：`invoice_no`, `customer_name`（客先。いまは `site_company` の文字列）, `billing_month`, `invoice_date`, `due_date`, `amount_excl_tax`, `tax`, `total`, `tax_rounding`, `status`（draft／created／sent／paid／void）, `file_path`, `sent_at`, `sent_to`, `sent_by`, `subject`
**`gw_office_sales_invoice_lines`（明細）**：`invoice_id`, `billing_progress_id`, `description`, `work_minutes`, `unit_price`, `amount`。税は**請求書単位**で計算（要件 §8）

**`gw_office_vendor_invoices`（ヘッダ）**：`partner_company_id`, `invoice_no`, `billing_month`, `invoice_date`, `due_date`, `amount_excl_tax`, `tax`, `total`（請求書に書かれた額）, `status`（received／needs_review／confirmed）, `submission_id`（外部提出のファイル）, `reviewed_by/at`。`(partner_company_id, invoice_no)` のユニークで重複登録を防ぐ
**`gw_office_vendor_invoice_lines`（明細）**：`invoice_id`, `billing_progress_id`, `purchase_order_id`（発注。null 可）, `description`, `work_minutes`, `amount`

- 発注額と請求額の差は**保存せず、明細ごと・請求書ごとに計算**して表示する。自動で否認・修正しない
- 請求書の合計（ヘッダの `total`）と明細の合計が合わないときは「要確認」にする（その請求書だけ。他は止めない）
- 実メール送信は入れない（P1）。「送付済みにする」＋送付先・送付者・件名・日時の記録のみ
- **`lib/office.js` は、この設計に合わせてある**：一覧の行の売上請求・仕入請求の状態は「この行の印から見た状態」で、請求書番号・請求書IDを行に持たせていない。Phase 5・6 で、明細が指す請求書の状態から導く形に置き換える

### 105（続き）：発注

- **`gw_purchase_orders`**：`order_no`, `partner_company_id`, `employee_id`, `site_contract_id`, `period_from/to`, `purchase_unit_price`, `settlement_condition`, `payment_terms`, `file_path`
- 複数要員を1通で発注する運用があるなら、発注も「ヘッダ＋明細」にする（要確認）

### 106：支払

- **`gw_office_payments`**：`vendor_invoice_id`（**請求書ヘッダ**に対して1件。要員ごとではない）, `partner_company_id`, `amount`, `scheduled_on`, `status`（unconfirmed／scheduled／processing／paid）, `paid_on`, `paid_by`
- BP 会社の振込口座は持たない（振込 CSV・銀行連携は P1）。口座情報は機微なので、入れるときに別途設計する

### 107：月次確定（任意）

- **`gw_office_month_closes`**：`month`, `closed_by/at`, `snapshot jsonb`, `reopened_by/at`, `reopen_reason`。**`gw_month_closings` とは別**。確定後に金額・時間を変えたときは、履歴に残す

## 5. 既存の月初作業（admin-month-start・cron・提出フォーム）への影響

| 対象 | 影響 | 根拠 |
|---|---|---|
| `api/billing-progress` | なし | 列を `FIELDS` で明示して読み書きしている。新しい列は返らず、書かれもしない |
| `api/billing-submission`（一覧） | なし | 進捗は `select("*")` だが、返す行は明示した項目から組み立てている |
| `api/billing-submission/public.js`（外部提出） | なし | 更新は既存の 2 つの印だけ。新しい列は nullable／default 付き |
| `api/cron/task-events.js` | なし | 行の作成は 4 列だけの upsert。unique 制約は変えない |
| `admin-month-start.html` | なし | 上記 API 経由でしか読まない |
| 既存の行 | 変更なし | 勤務表の状態は導出するので、バックフィルはしない |
| RLS（既存 4 表） | **変更しない**（方針A） | 足すのは `db/100` の Office 読み取りだけ |

## 6. 既存 `unit_price` の調査結果（意味は決めていない）

**結論：コード・画面・DB・テスト・文書のどこにも、売上単価か仕入単価かを決めている記述は無い。実データでの確認が要る。**

確認した事実：

- 列は `unit_price numeric(12,2)` と `unit_price_type`（月額／時給／日給）だけ（`db/076_site_contracts.sql:55-57`）
- 登録フォーム（`admin-members.html`）は「単価」「単価の種類」の2項目だけ。**PP と BP で表記も扱いも同じ**（`engagement_kind` で意味も文言も変わらない）
- 検証（`lib/site-contracts.js`）は「0以上の数値」と種類の3値だけ。売上／仕入の区別なし
- 契約行の相手は「所属会社（常駐先）」＝客先（`site_company`）と上位会社（`prime_company`）。BP 会社は、契約行ではなく要員（`gw_employees.partner_company_id`）にぶら下がる。
  そのため BP 契約の単価が「客先への売上単価」か「BP 会社への仕入単価」かは、構造からは決まらない
- テストの例は、すべて `700000` 月額。意味の手がかりにならない
- 導入時のコミットは一括取り込みで、意図が残っていない
- `db/076` は「単価・精算条件は、本人には見せない情報（他の社員の給与を見せないのと同じ）」と書くが、これは機微性の説明で、意味の定義ではない
- 契約によって意味が混在していても、**システムには検出する列が無い**（人が入力した意味に依存する）

**したがって**：Phase 2 の `/office` は `unit_price` を読まない・出さない（API が select しない。テストで固定）。
新設する単価は `sales_unit_price` / `purchase_unit_price`（102）。既存値からの移行は、**意味を確認してから**行う。

確認のための SQL（Supabase の SQL Editor。読み取りのみ。件数と分布だけで、氏名は出さない）：

```sql
-- 区分ごとの単価の分布
select engagement_kind                                         as 区分,
       unit_price_type                                         as 種類,
       count(*)                                                as 件数,
       count(*) filter (where unit_price is null)              as 単価未入力,
       min(unit_price)                                         as 最小,
       percentile_cont(0.5) within group (order by unit_price) as 中央値,
       max(unit_price)                                         as 最大,
       count(*) filter (where coalesce(settlement_condition, '') <> '') as 精算条件あり
  from public.gw_site_contracts
 group by 1, 2 order by 1, 2;

-- 同じ客先に PP と BP の契約があるとき、単価の水準を比べる（BP が売上なら PP と近く、
-- 仕入なら PP より低くなるはず。あくまで手がかり）
select site_company                                   as 客先,
       round(avg(unit_price) filter (where engagement_kind = 'pp')) as PP平均,
       round(avg(unit_price) filter (where engagement_kind = 'bp')) as BP平均,
       count(*) filter (where engagement_kind = 'pp')  as PP件数,
       count(*) filter (where engagement_kind = 'bp')  as BP件数
  from public.gw_site_contracts
 where unit_price_type = '月額'
 group by 1
having count(*) filter (where engagement_kind = 'pp') > 0
   and count(*) filter (where engagement_kind = 'bp') > 0;
```

最終的には、**登録している人・運用している人に「BP の単価欄に何を入れているか」を聞くのが確実**。

## 7. Phase 2 の到達点と、これから

**Phase 2（実装済み）**：`/office` の月次ダッシュボード（数字カード・今日やること・月次進捗・案件一覧・絞り込み・右ドロワー・提出ファイル閲覧）。
DB は増やさない。既存の5つの印と届いたファイルから、現在工程・要対応を導く。印の更新は、当面これまでどおり月初作業管理で行う。

**まだ無いもの**（画面にも「今後追加します」と出している）：稼働時間の計算（Phase 3）、売上請求・仕入請求の金額と請求書（Phase 5・6）、発注（Phase 6）、支払（Phase 7）、月次完了の確定（Phase 8）。
支払の記録が無いので、BP は「支払準備」までで「完了」にしない。

## 8. 決めてほしいこと

1. **`unit_price` の意味**（§6）。SQL の結果、または運用している人の回答
2. **経理・責任者の MFA 登録**：Office は最初から MFA 必須なので、`/office` を使う前に、対象の人が二段階認証を登録している必要がある（登録は マイページ）
3. **売上請求書の単位**：1客先につき月に何枚か（客先ごとに1枚にまとめるか、案件ごとか）。`billing_month` と客先の組で1枚、を既定にする案
4. **発注**：複数要員を1通で発注する運用があるか
