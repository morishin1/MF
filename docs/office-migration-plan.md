# /office（月末月初業務管理）migration 案

Phase 0 で確定する案です。**まだどの SQL も本番に適用していません**（099 は作成済み、100 番台は案のみ）。
要件は `office_monthly_operations_requirements.md`、調査結果は Phase 1 のレポートにあります。

## 1. 方針

| # | 方針 | 理由 |
|---|---|---|
| 1 | 月次処理の基準レコードは **`gw_billing_progress`**（対象月×要員×現場契約で一意）。新しい月次進捗テーブルは作らない | 要件 §6。既存の月初作業管理・cron・提出フォームを壊さない |
| 2 | **加算のみ**。既存の列は変更・削除・型変更しない。追加する列は nullable か default 付き | 既存 API・cron の書き込みが、そのまま通る |
| 3 | 全体ステータス（月次完了／対応中／要確認）は**保存せず、各工程の事実から導出**する | 保存すると、工程を直したときに古くなる（二重管理） |
| 4 | 契約条件は **`gw_site_contract_terms`**（適用開始日つき）に持つ。コードに固定しない | 要件 §7・§8・§44（月途中変更） |
| 5 | Office の新しい表は **`gw_is_office`**（099）で RLS を掛ける | 要件 §13。DB でも権限のない人には取得不可 |
| 6 | `gw_month_closings` は使わない。Office の月次完了は別に持つ | 要件 §6。打刻ロックの副作用があるため |
| 7 | 履歴は **`gw_office_events`**（人が読む文＋名前のスナップショット） | 既存の `gw_activity_log` は機械名で、Office の役割では読めない |

## 2. 番号と適用順

適用は Supabase の SQL Editor に貼って Run（べき等に書く）。**SQL を先に流してから、アプリをデプロイする**。

| 番号 | Phase | 内容 | 状態 |
|---|---|---|---|
| 099 | 0 | `gw_is_recruiting` に責任者を追加、`gw_is_office` を新設 | 作成済み（`db/099_access_hr_office.sql`） |
| — | 2 | ダッシュボード・一覧・ドロワー（**DB 変更なし**。既存データを読むだけ） | — |
| 100 | 3 | 履歴表・通知 kind・提出の拡張・月次レコードの拡張（勤務表の状態） | 案 |
| 101 | 3〜4 | 契約条件（適用開始日つき）・現場契約の拡張 | 案 |
| 102 | 3 | 勤務表の読取結果と日別データ | 案 |
| 103 | 5 | 売上請求書 | 案 |
| 104 | 6 | 発注・仕入請求書 | 案 |
| 105 | 7 | 支払 | 案 |
| 106 | 8 | 月次確定（任意。確定後の変更を履歴に残すため） | 案 |

## 3. 各 migration の中身（案）

### 100：履歴・提出・月次レコードの拡張

- **`gw_office_events`**（新設）：`tenant_id`, `billing_progress_id`（null 可＝月全体の出来事）, `kind`, `label`（人が読む文。例「勤務表を確認済みに変更」）, `detail` jsonb（from/to）, `actor_id`, `actor_name`（名前のスナップショット）, `created_at`。追記のみ。RLS は `gw_is_office`
- **`gw_notifications.kind`** の CHECK に `'office'` を足す（db/088 と同じ「値のマージ式」）。
  **これを先に適用しないと、`notify()` が黙って失敗する**（`lib/notify.js` は失敗を握りつぶすため、cron が何も送れないまま 200 になる）
- **`gw_submissions`** に追加：`sha256 text`（重複検知）, `uploaded_by uuid`, `source text default 'external'`（外部提出／管理者アップロード）, `status text default 'submitted'`（submitted / revision_requested / confirmed / superseded）。`(employee_id, site_contract_id, target_month, kind, sha256)` の**部分ユニーク**（`sha256 is not null`）
- **`gw_billing_progress`** に追加（すべて nullable）：
  - 勤務表の確認：`timesheet_confirmed_at`, `timesheet_confirmed_by`, `timesheet_revision_requested_at`
  - 稼働の確定：`work_minutes int`, `work_confirmed_by uuid`
  - 確定時の金額と計算根拠：`billing_amount numeric(12,0)`, `vendor_amount numeric(12,0)`, `calc_snapshot jsonb`（確定時に使った契約条件・丸め・内訳。過去月を現在値で再計算して壊さないため）
  - 担当：`owner_employee_id uuid`

勤務表の状態（未提出／提出済／修正依頼中／確認済）は、**保存せず導出する**：

| 状態 | 条件 |
|---|---|
| 未提出 | 提出が 0 件 |
| 提出済 | 提出あり、かつ確認・修正依頼なし |
| 修正依頼中 | `timesheet_revision_requested_at` が最新の提出より新しい |
| 確認済 | `timesheet_confirmed_at` あり |

### 101：契約条件（適用開始日つき）

- **`gw_site_contract_terms`**（新設）：`site_contract_id`, `valid_from date not null`, `valid_to date`, `sales_unit_price`, `cost_unit_price`, `unit_price_type`（月額／時給／日給）, `settle_min_minutes`, `settle_max_minutes`, `settle_unit_minutes`（15／30）, `rounding`（floor／ceil／round）, `rounding_scope`（day／month）, `over_rate`（超過単価）, `under_rate`（控除単価）, `prorate boolean`（日割り有無）, `tax_rounding`（既定 floor）, `payment_terms`（支払条件）, `note`
  - 期間の重複は入れられない（同一契約で `valid_from` が重ならない制約）
  - 月をまたぐ変更は「期間別に計算してから合算」（要件 §8）
- **`gw_site_contracts`** に追加：`project_name text`（案件名）, `partner_company_id uuid`（BP 会社。現状は要員経由でしか辿れない）
- 既存の `unit_price` と `settlement_condition`（自由記述）は**そのまま残す**（旧データ。移行では自動変換しない）。構造化した条件が未入力の契約は、計算せず「契約条件不足（要確認）」にする

### 102：勤務表の読取（draft → 人が確認 → confirmed）

`lib/contracts.js` と `db/029` の型に合わせる。AI の結果は**自動確定しない**。

- **`gw_office_timesheet_reads`**（新設）：`submission_id`, `status`（pending／processing／completed／failed）, `extracted jsonb`（AI の生値を保持）, `ai_confidence`, `unreadable text[]`, `confirmed_by`, `confirmed_at`
- **`gw_office_timesheet_days`**（新設）：`read_id`, `work_date`, `ai_start/ai_end/ai_break_minutes`, `start/end/break_minutes`（人の確定値）, `worked_minutes`, `needs_review boolean`, `review_reason`。休憩が不明な行は補完せず `needs_review`

### 103：売上請求書

- **`gw_office_sales_invoices`**：`invoice_no`, `customer_name`（客先。現状は `site_company` の文字列）, `billing_month`, `amount_excl_tax`, `tax`, `total`, `tax_rounding`, `invoice_date`, `due_date`, `status`（draft／created／sent／paid）, `file_path`, `sent_at`, `sent_to`, `sent_by`, `subject`
- **`gw_office_sales_invoice_lines`**：`invoice_id`, `billing_progress_id`, `amount`。税は**請求書単位**で計算（要件 §8）
- 実メール送信は入れない（P1）。「送付済みにする」＋送付先・送付者・件名・日時の記録のみ

### 104：発注・仕入請求書

- **`gw_purchase_orders`**：`order_no`, `partner_company_id`, `employee_id`, `site_contract_id`, `period_from/to`, `unit_price`, `settlement_condition`, `payment_terms`, `file_path`
- **`gw_office_vendor_invoices`**：`submission_id`（外部提出の請求書）, `partner_company_id`, `invoice_no`, `billing_month`, `amount`, `invoice_date`, `due_date`, `purchase_order_id`, `status`（received／needs_review／confirmed）, `reviewed_by/at`。`(partner_company_id, invoice_no)` のユニークで重複登録を防ぐ
- 発注額と請求額の差は**保存せず計算**して表示。自動で否認・修正しない

### 105：支払

- **`gw_office_payments`**：`vendor_invoice_id`, `partner_company_id`, `amount`, `scheduled_on`, `status`（unconfirmed／scheduled／processing／paid）, `paid_on`, `paid_by`
- BP 会社の振込口座は持たない（振込 CSV・銀行連携は P1）。口座情報は機微なので、入れるときに別途設計する

### 106：月次確定（任意）

- **`gw_office_month_closes`**：`month`, `closed_by/at`, `snapshot jsonb`, `reopened_by/at`, `reopen_reason`。**`gw_month_closings` とは別**。確定後に金額・時間を変えたときは、履歴に残す

## 4. 既存の月初作業（admin-month-start・cron・提出フォーム）への影響

| 対象 | 影響 | 根拠 |
|---|---|---|
| `api/billing-progress` | なし | 列を `FIELDS` で明示して読み書きしている。新しい列は返らず、書かれもしない |
| `api/billing-submission`（一覧） | なし | 進捗は `select("*")` だが、返す行は明示した項目から組み立てている |
| `api/billing-submission/public.js`（外部提出） | なし | 更新は既存の 2 つの印だけ。新しい列は nullable／default 付き |
| `api/cron/task-events.js` | なし | 行の作成は 4 列だけの upsert。unique 制約は変えない |
| `admin-month-start.html` | なし | 上記 API 経由でしか読まない |
| 既存の行 | 変更なし | 勤務表の状態は導出するので、バックフィルはしない |
| RLS（既存 4 表） | **変更しない** | 下の §5-1 を参照 |

## 5. 決めてほしいこと

1. **既存 4 表（`gw_site_contracts` / `gw_billing_progress` / `gw_submission_links` / `gw_submissions`）の RLS。**
   いまは `is_tenant_staff`（会計の管理者）、月初作業管理の API は `canManageHr`（管理者・人事・経営者）で、範囲が一致しません。
   人事（`hr`）だけの人は、API を通っても RLS で 0 件になります。
   - **A（推奨）** 月初作業管理を `/office` に統合するまで**現状維持**。統合時に、単価・請求額を見られる人を Office の権限（経営者・責任者・経理）に絞る
   - B いま `gw_is_hr` にそろえる。人事の不整合は直るが、要件（人事は Office 不可）とは逆向きに広がる
2. **BP 会社が複数要員を 1 枚の請求書でまとめて請求することはあるか。** ある場合、仕入請求書に明細（要員ごと）の表が要る
3. **売上請求書は、客先単位で複数要員・複数案件を 1 枚にまとめるか。** 103 の明細表はこれを前提にしている
4. **既存の `unit_price` は、売上単価と仕入単価のどちらとして扱っているか。** 移行時に自動で決めない（構造化した条件は人が入力する）
5. **経理・責任者を MFA の対象にするか。** いまの対象は管理者・経営者・人事・社労士（`lib/mfa.js`）。Office は金額を扱う
