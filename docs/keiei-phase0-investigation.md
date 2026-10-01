# /keiei 新設・入社オンボーディング Phase 0 調査報告

> **更新（実装後）**: この報告は着手前の調査。決定を受けた実装の現在地・決めていただきたいこと・本番へ反映する前の確認は
> [`keiei-implementation-status.md`](keiei-implementation-status.md) にある。権限・給与・ヘッダーに関する記述は、そちらが新しい。
> `gw_site_contracts.unit_price` の確認方法は [`keiei-unit-price.md`](keiei-unit-price.md)。

- 調査日: 2026-09-29 / 対象: `morishin1/MF`（HEAD `266c238`、最新マイグレーション `db/098`）
- 位置づけ: 指示書 2 本（`/keiei` 経営ダッシュボード新設、入社オンボーディング設計）の **Phase 0（調査のみ）**。コードは 1 行も変更していない。
- 調査方法: コードとSQLの静読。**本番DBの実データ・適用済みマイグレーションは確認できていない**（「未確認事項」参照）。推測は「推測」と明記した。
- 主要な数値・権限の主張は、実コードで再確認済み（後述「裏取り済み」）。

---

## 0. 結論（先に）

1. **「経営者」の実体は `gw_role_grants.role = 'owner'`**。新しいロールは作らずに済む。ただし「owner だけ」で守っている画面・APIは現状ゼロ。既存の owner 判定はほぼ「管理者 ∨ 経営者」。`canKeiei`（owner のみ）と SQL の `gw_is_owner()` を新設する必要がある。
2. **「経営者のみ」を実効にするには、owner の付与を塞ぐ必要がある。** 現状、管理者・人事なら誰でも自分に owner を付けられる（§2-3）。これを直さないと `/keiei` の権限は名目だけになる。
3. **給与情報は現状、責任者・採用担当・人事・管理者から読める。** 特に「採用担当が候補者の給与を読み書きできる」「責任者が部下の給与を API で取れる」は高リスク（§7）。指示書の「給与を HR・採用担当へ漏らさない」は、`/keiei` を作るだけでは達成できず、既存 API と RLS の是正が要る。
4. **売上・仕入・粗利・入金・キャッシュ残高を金額で持つデータは、リポジトリに存在しない。** 正確に出せるのは経費・成約件数・稼働時間・請求進捗・契約更新など。売上系は新しいデータ源（MF連携 / 請求・入金テーブル / 契約の原価単価）を決めない限り出せない（§8）。
5. **依頼文と現実のズレ**: 「HR ｜ Sales ｜ Office」の切替ヘッダーは存在しない。実際は `js/layout.js` の近道（採用HR / Sales の2つ）のみ。「会計」の行き先は `admin.html`（独立UI）（§3）。
6. **入社の「6ステップ」は既に3系統ある**。4つ目を作らず、既存判定への表示写像にするのが安全（付録A）。
7. **メール送信基盤が無い**。入社案内を「メールで送る」には基盤の新設が前提（付録A）。
8. **2026-10-01（2日後）から owner に二段階認証が強制される**。`/keiei` の API に `requireMfa` を付ける前提で設計し、経営者は 9/30 までに登録が必要。

---

## 1. 依頼文と現実のズレ

| 依頼文の前提 | 実際 | 根拠 |
|---|---|---|
| ヘッダーは `HR ｜ Sales ｜ Office` | 「Office」という語は grep 0 件。近道は **採用HR(`/hr/`) と Sales(`/sales/`) の2つ**。`/hr` `/sales` 側のヘッダーに切替リンクは無く「GWへ戻る」のみ | `js/layout.js:298-301`、`js/hr-layout.js:73`、`js/sales-layout.js:196` |
| サイドメニューは3グループ | **4グループ**（ホーム / 人事・労務 / 業務・経理 / 管理・設定）、18項目 | `js/layout.js:141-242`、`test/navcheck.mjs:56` |
| 「会計」= 経営数値に直結する画面 | メニュー「会計」→ `admin.html`。KessanPilot 時代の独立UI（`layout.js` を読み込まない）。**試算表は「当アプリで承認済みの仕訳のみ・期首残高なし」と画面自身が明記** | `js/layout.js:217`、`admin.html:129` |
| CLAUDE.md / README の `data/*.json` 運用 | **`data/` はリポジトリに存在しない**（.gitignore 対象）。旧デモ画面は `mock-data.js` の架空データで `.vercelignore` により本番配信外 | `.gitignore:9`、`.vercelignore` |
| MF連携で試算表・残高が取れる | **MF連携は OAuth トークン保管まで**。取得スコープは `mfc/admin/office.read` のみ、`getValidAccessToken` はどこからも呼ばれず、送信 `sendViaHttp` は例外を投げる | `lib/mf-oauth.js:22,148`、`lib/mf-adapter.js:103` |

> CLAUDE.md / README.md はコードと乖離した古い運用（Claude Code + MF MCP の月次コマンド）を書いている。実装の参照にはコードを正とすること。

---

## 2. 権限（調査項目 1・10）

### 2-1. 画面の名称 → DB → 判定

メンバー管理の「経営者」チェックは `API.setEmployeeRole`（`js/api-client.js:501`）→ `POST /api/employees/roles`（`api/employees/roles.js`）→ `gw_role_grants` の upsert/delete。

| 画面の名称 | 実体（`gw_role_grants.role`） | サーバ判定 | RLS関数 |
|---|---|---|---|
| **経営者** | `owner` | `ctx.roles.includes("owner")`、`/api/me` の `gw.isOwner` | `gw_has_role(t,'owner')`（db/005:136） |
| 人事 | `hr` | `ctx.isHr`（hr ∨ owner）、`canManageHr = isAdmin ∨ isHr`（`lib/gw.js`） | `gw_is_hr`（hr ∨ owner ∨ **is_tenant_staff**、db/041:35-47） |
| 責任者 | `manager` | `SALES_ROLES` に含む、`canManageCareer` | `gw_is_sales`、`gw_is_internal_staff` |
| 採用担当 | `recruiter` | `canRecruit`（owner/hr/recruiter） | `gw_is_recruiting`（db/094:34-40） |
| 営業担当 | `sales` | `canSell`（owner/manager/sales） | `gw_is_sales`（db/094:50-56） |
| 経理 / IT・管理 | `finance` / `it` | **判定関数なし**（入退社の担当者割当のみ） | なし |
| 社労士 | `labor_advisor` | `ctx.isAdvisor`。`appRole` は **sr が owner より優先** | `gw_is_advisor`（db/008:93） |
| （管理者） | `memberships.role in ('admin','staff')` | `ctx.isAdmin` | `is_tenant_staff` |

### 2-2. 「経営者だけ」を表す判定は無い

- `canDecideHire` / `canWipeDevice` / `canManageSeals` / `canDecideCareer` はいずれも `isAdmin ∨ owner`（管理者を含む）。
- owner のみで分岐しているのは、経費・稟議の2段階承認 `pending_owner` だけ（`api/expenses/decide.js:53`、`api/requests/decide.js:53`）。
- `db/005:77-83` のコメントも「owner … 管理者と同じ画面を見る」で、owner ≈ admin の前提。
- ⇒ **新設**: `KEIEI_ROLES = ["owner"]` / `canKeiei(ctx)`（`isAdmin` を含めない）、SQL `gw_is_owner(p_tenant)`（`gw_has_role(..,'owner')` のみ、`is_tenant_staff` を含めない）。
- 注意（社労士兼務）: `appRole` は labor_advisor があると `sr` になる（`api/me.js:131-136`）。画面側は `appRole` ではなく `access.keiei`（`gw.roles` 由来）で判定すること。

### 2-3. 最重要リスク: owner は誰でも付与できる（裏取り済み）

| 経路 | 内容 |
|---|---|
| API | `api/employees/roles.js` の権限は `canManageHr`（admin/hr/owner）だけ。**role が owner のときに owner 限定にする条件が無い**。あるのは「最後の owner を外せない」保護のみ |
| RLS | `gw_role_grants_hr_write` は `gw_is_hr`（= hr ∨ owner ∨ **会計の管理者**）。ブラウザから PostgREST を直接叩いても書ける |

⇒ 管理者・人事が自分に `owner` を付ければ `/keiei` に入れる。**Phase 1 で `roles.js` と RLS の両方を「owner の付与・剥奪は現 owner のみ」に変える**必要がある。

### 2-3b. 二段階認証

対象は admin / owner / hr / labor_advisor。強制は **2026-10-01**、登録期限は 2026-09-30（`lib/mfa.js:28-32`、環境変数で前後可）。`/keiei` の API は `requireMfa` を通す（前例: `api/site-contracts/index.js:34`、`api/hr/payroll.js:33`）。

### 2-4. アクセス制御3層の現状と、`/keiei` の設計

| 層 | 現状 | `/keiei` でやること |
|---|---|---|
| ① ヘッダー表示 | `/api/me` の `access`（`accessOf`）をそのまま `showsFor` に渡す。役割の並びを画面側で持たない設計 | `accessOf` に `keiei` を追加 → `SHORTCUTS`・`showsFor` に追加 |
| ② ページ | **サーバ側ガードは無い**（middleware 0件、HTMLは静的配信）。ガードはクライアントJSのみ（未許可は `../home.html` 等へ送り返す） | 同じ型。HTML/JSに機密値を埋めない。`noindex` を付ける |
| ③ API + RLS | `requireUser` → `gwContext` → `canX(ctx)`。`userClient` は RLS が効くが、`admin()`（service_role）は API の `if` が唯一の関門 | 全 `/api/keiei/*` の入口に `canKeiei` + `requireMfa`。表は `gw_is_owner` の RLS |

- RLS の落とし穴: 既存の `gw_site_contracts` / `gw_billing_progress` / `gw_submissions` は `is_tenant_staff` のみ。**owner ロールだけで admin/staff 所属が無い人は `userClient` では読めない**。集計は既存（`api/closing`・`api/timecard`）と同様に `admin()` + API層の `canKeiei` が確実。
- 4か所（サーバ関数・`/api/me`・画面・RLS）を揃える既存の型は `test/accessparity.mjs`。

---

## 3. ヘッダーとメニュー（調査項目 2）

### 3-1. 現在の構造

- 近道（`SHORTCUTS`）: `js/layout.js:298-301`。描画 `shortcutsHtml`（303-313）、差し込み `renderTopbar` 331行。表示条件は `showsFor()`（826-849）で `me.access.recruit` / `me.access.sell`。
- 狭幅は「HR」「Sales」に縮む（`css/layout.css:545-558`）。近道の数に依存しない作りなので、3つ目を足しても CSS はほぼ変更不要。
- `/hr`・`/sales` は別ヘッダー（`js/hr-layout.js`、`js/sales-layout.js`）で、入口判定は `me.access.*`。
- 管理者サイドメニュー `ADMIN_GROUPS`（`layout.js:141-242`）の制約（`test/navcheck.mjs`）: 4グループ固定、各6項目まで、全体24項目まで、ラベル9字以内、**`/hr/` `/sales/` を左メニューに置かない**（入口はヘッダー近道だけという既存方針）。管理者メニューには `when`（条件付き表示）の仕組みが無い。

### 3-2. 「経営」を足す場合に触る箇所（推奨: ヘッダー近道方式）

| # | 場所 | 内容 |
|---|---|---|
| 1 | `lib/gw.js` | `KEIEI_ROLES`、`canKeiei`、`accessOf` に `keiei` |
| 2 | `api/me.js:45-47` | `accessOf` を返す形なので自動反映（`accessparity.mjs:58` の正規表現を壊さない） |
| 3 | `js/layout.js:298-301` | `SHORTCUTS` に `{key:"keiei", href:"/keiei/", label:"経営", short:"経営"}` |
| 4 | `js/layout.js:826-849` | `showsFor` に `keiei: me?.access ? Boolean(me.access.keiei) : gwRoles.includes("owner")` |
| 5 | 新規 | `keiei/index.html`、`js/keiei-layout.js`（`hr-layout.js` の型）、`vercel.json` の rewrite（`/keiei` → `/keiei/index.html`） |
| 6 | 新規 | `api/keiei/index.js`（1ファイルで `view=` 切替。既存 `api/career/index.js` の型）、`db/099_*.sql` |
| 7 | `.github/workflows/web-test.yml:24-27` | `paths` に `keiei/**` を追加（現状 `hr/**` `css/**` も無い） |

**コスト（重要）**: `js/layout.js` を変えると、`layout.js?v=20260929b` を読む**約61画面**の `?v=` と `api/health.js` の `assetVersion` を揃えて上げる必要がある（`test/sharedassets.mjs`、`test/speedcheck.mjs` が強制）。`api-client.js` は変更せず `API.api("/api/keiei/...")`（汎用関数）を使えば版管理を避けられる。

### 3-3. 依頼文 §21 のヘッダー構成について

`ホーム ｜ HR ｜ Sales ｜ Office ｜ 経営` のうち「Office」は実在の画面群ではなく、実質は管理画面（`admin-*.html`）全体。**「経営」を近道の3つ目として足す**のが最小変更。「Office」というラベルの導入は別判断（§12 決定事項）。

---

## 4. 「会計」（調査項目 3）

| 項目 | 内容 |
|---|---|
| URL | メニュー「会計」= `admin.html`（`layout.js:217`）。メンバー向け「会計書類」= `app.html`（`layout.js:110`） |
| 実態 | 書類アップロード（`app.html`）→ Claude API で種別判定・仕訳ドラフト → 承認（`admin.html`）。試算表は `journals.lines` を科目名の文字列で集計するだけ（`lib/reports.js:47-76`） |
| DB | `tenants`（実質1行）、`clients`（実質1行「エイト」）、`memberships`、`documents`、`journals`（total_amount 税込合計、lines jsonb）、`accounting_credentials` |
| API | `/api/clients`、`/api/journals`（RLSのみ、200件上限）、`/api/journals/approve`、`/api/reports/trial-balance`、`/api/reports/advice`、`/api/mf/*` |
| 依存 | `admin.html` ⇄ `app.html` 相互リンク、`api/mf/oauth/callback.js:13` が `/admin.html` へ戻す、`admin-settings.html:73-76` が案内 |
| データ品質 | 勘定科目マスタ無し（科目名はAI自由記述）、補助科目・BS/PL区分・税額列なし、期首残高なし、**MFへの送信は未実装** |
| 旧デモ | `dashboard.html` / `journal-approval.html` / `closing-check.html` / `report-generator.html` / `client-report.html` / `review.html` は架空データで本番配信外 |

### 権限の落とし穴（裏取り済み）

- 社員登録時に**全員へ `memberships.role='client'`**（`client_id` = 唯一の取引先）が付く（`lib/accounts.js:194-213`）。
- `canAccessClient` は client ロールも通す（`lib/auth.js:39-46`）。
- ⇒ `/api/reports/trial-balance`・`/api/reports/advice` は**全社員に開いている**（`api/reports/trial-balance.js:24`）。`/api/journals`・`/api/documents` も RLS で client 紐づけ者に開いている。
- 画面のメニュー「会計」は staff/admin にしか出さない（`layout.js:844`）。**隠しているだけで、APIは閉じていない。**

### `/keiei` への移行方針

- 「会計」を `/keiei` の項目にするのは妥当。ただし**現状の会計データは経営数値の一次情報として不十分**（網羅性・科目・期首残高）ため、`/keiei` 上では「当アプリ捕捉分のみ（暫定）」と明示する。
- `admin.html` は独立UIで部品流用は困難。**削除せず残し、リンク移設のみ**。メニューから外すのは `/keiei` 側が動いた後。
- `/api/reports/*` の client 開放は `/keiei` の有無にかかわらず塞ぐべき（別作業として提案）。
- MFの実試算表・預金残高を出すには **MF連携の本実装が前提**（§8）。

---

## 5. 「経費精算」（調査項目 4）

| 項目 | 内容 |
|---|---|
| 画面 | `expenses.html`（本人）、`admin-expenses.html`（承認・支払・CSV。`roles:["admin","owner"]`） |
| API | `api/expenses/{index,decide,settings,upload}.js`、`lib/expenses.js` |
| テーブル | `gw_expense_reports`（employee_id, period 'YYYY-MM' **nullable**, payment_method personal/corporate_card, total_amount, status pending/pending_owner/approved/paid/rejected/cancelled, approved_at, owner_approved_at, paid_on）／`gw_expense_lines`（spent_on, category, amount, tax_rate 0/8/10, invoice_registered） |
| 承認 | 管理部が1段目、しきい値（既定10万円）以上は owner が2段目（`decide.js:73-83`）。**承認しても自動で仕訳にならない**（CSV書き出し運用）。`journals` と単純合算すると二重計上の恐れ |
| 権限 | RLS `gw_expense_can_review`（staff ∨ hr ∨ owner）または本人。API の `scope` 既定は権限者なら `all` |
| 部門 | 部門マスタ無し。`gw_employees.department`（自由記述、現在値のみ・履歴なし）を join |

**集計可否: 正確に可能**（確定 = `approved + paid`、見込み = `pending*`）。月別・科目別・社員別・部門別（現在部署のスナップショット）・立替/カード別・前月比・支払待ち（`approved` かつ `personal`）。月境界は `lines.spent_on` が厳密（`period` は null あり）。

**注意**: 税込/税抜の明記はコード上に無い（領収書額=税込と解釈されるが未確認）。既存 `GET` は `.limit(500)` なので、集計は既存 API ではなく **`/keiei` 専用のクエリ**（`lib/` に集計関数）を作る。既存の月集計の前例は `api/closing/index.js:174-222`。

**方針（依頼 §7-2 どおり）**: 申請・承認は現行のまま Office 側に残し、`/keiei/expenses` は集計表示のみ（同じデータを二重登録しない）。

---

## 6. 「月次業務」と請求まわり（調査項目 5）

「月次業務」は2画面: `admin-closing.html`（月次締め = **給与計算の前段**の未承認ゼロ確認。会計の決算ではない）と `admin-month-start.html`（月初作業管理 = BP の勤務表・請求書回収）。

### 依頼文の7段階に対する現状

| 段階 | 現状 | 実体 |
|---|---|---|
| ① 勤務表回収 | 実装済み | `gw_submission_links` / `gw_submissions`（kind='timesheet'）。cron が月初に **BP のみ** 回収タスクを生成 |
| ② 稼働計算 | **未実装**（人の確認フラグのみ） | `gw_billing_progress.work_confirmed`。BP の勤務表は数値化していない（D2 として明記、`db/080:12`） |
| ③ 案件紐付け | 実装済み（1契約=1人） | `gw_site_contracts` |
| ④ 請求 | **フラグのみ** | `board_created` / `sent`。**請求金額・番号・期日は持たない**。請求書は外部ツール Board（連携コード無し） |
| ⑤ 仕入請求書回収 | 受領フラグ + ファイル | `bp_invoice_received`、`gw_submissions.kind='invoice'`。**金額は読み取らない** |
| ⑥ 発注照合 | **無い** | 発注書テーブルなし（`gw_doc_orders` は労務書類の作成依頼で無関係） |
| ⑦ 支払準備 | **無い** | BP・外注の支払テーブルなし |

### 案件マスタ = `gw_site_contracts`（`db/076`）

「案件」という独立エンティティは無く、**1人×1現場契約の行**が相当する。`site_company`・`prime_company` は自由記述（顧客マスタ無し）、`unit_price` は**1列のみで顧客請求か BP 支払かの区別が無い**、`settlement_condition` は自由記述、部門・サービス区分は契約に無い。

---

## 7. 給与・人件費の保存と漏れ（調査項目 6・7）

### 7-1. 根本前提

- 本当の境界は API ではなく **RLS と Storage policy**。ブラウザに anon key と JWT が渡っており、PostgREST / Storage を直接叩ける。**API 側だけで給与を隠しても、RLS を通る人は迂回して読める**。RLS に MFA(aal) 判定は無い。
- 「人事」の実体は広い: DB `gw_is_hr` = hr ∨ owner ∨ **会計の管理者**（db/041）。管理者は人事と同格。

### 7-2. 給与の所在

| 所在 | 読める人 | 書ける人 |
|---|---|---|
| `gw_contracts.wage_type/wage_amount/wage_note`（+ `extracted` jsonb に AI生値） | 管理者・人事・owner（`/api/contracts`、MFA有）、本人は自分の分。RLS: `gw_is_hr ∨ 本人`（db/035） | 同左（締結済みは `correction:true` + 理由必須） |
| `gw_hr_applicants` / `gw_hr_offers` の `wage_*`（候補者の提示給与） | **採用担当を含む** `canRecruit`（RLS `gw_is_recruiting`、全操作可） | **採用担当も編集可** |
| `gw_doc_orders.conditions`（「賃金」必須欄）、`gw_sign_requests.body_snapshot/merged_fields`、署名PDF | 管理者・人事・owner（RLS `gw_is_hr`）、社労士（employment のみ） | 作成依頼は管理者側、条件編集・承認発行は社労士も可 |
| `gw_onboard_profiles.commute_cost` / `bank_*` | 管理者・人事・owner、社労士（共有手続きのみ）、本人 | 本人 |
| `gw_career_levels.salary_min/max`、`gw_career_reviews.salary_decision/note` | `canManageCareer`（**責任者を含む**） | 保存は同、確定は admin/owner |
| `gw_activity_log.detail`（賃金の before/after が混入） | 管理者（`is_tenant_staff`）。`/api/settings` が生 detail を返す | サーバのみ |
| `gw_site_contracts.unit_price` | 管理者全員（`is_tenant_staff`） | `canManageHr` |

### 7-3. リスク

| # | リスク | 度 | 状態 |
|---|---|---|---|
| A | **採用担当が候補者の給与条件を閲覧・編集**できる。`db/081:40,51` のコメント「給与…は見えない」と実装が矛盾。`/api/hr/applicants` に `wage_type, wage_amount` が select されている | 高 | 裏取り済み |
| B | **責任者が `/api/career` を直接叩くと部下の現在給与・給与メモ・給与レンジを取得**できる。UI（`admin-career.html`）は `["admin","owner"]` で弾くが API は通る。`currentWage` が `gw_contracts` の `wage_*` を返す | 高 | 裏取り済み |
| C | 管理者・人事は RLS / Storage policy 経由で API を迂回して給与・PDF を直接読める（`gw_contracts` / `gw_sign_requests` / `gw_doc_orders` / `gw_onboard_profiles` / 単一バケット `hr`） | 高 | 調査報告 |
| D | HR が給与を書く前提の業務フローが多数（登録STEP3、CSV一括、通知書の「賃金」必須欄、契約台帳、承認条件突合）。給与を HR から隠すと**業務フローの再設計が要る** | 高 | 調査報告 |
| E | 賃金入りの署名済みPDF・`body_snapshot` は不変の証跡。分離後も過去分は `gw_is_hr` に可読 | 中 | |
| F | `gw_activity_log.detail` に賃金差分が混入し、管理者が読める | 中 | |
| G | PDF は単一バケット `hr` + tenant単位のpolicy。`/keiei` 用PDFを同バケットに置くと HR に読める（専用バケットが必要） | 中 | |
| H | **落とし穴**: `updateContract` は body に賃金キーが無いと `wage_*` を null で上書きする。UIから賃金欄を外して update を呼ぶと賃金が消える | 中 | |
| I | 社労士は payroll CSV で基本給・通勤手当・口座、通知書で賃金を取得できる | 中 | 運用判断 |
| J〜L | unit_price が管理者全員に可読、契約書PDFをAnthropic APIへ送信、責任者・採用担当はMFA対象外 | 低〜中 | |

### 7-4. 雇用契約PDFの閲覧

- すべて private バケット `hr`。閲覧は署名URL（TTL 60〜300秒）＋ `gw_sign_events` / `gw_activity_log`。Storage policy `hr_files_rw` は tenant 単位で**フォルダ別の分離が無い**（管理者・人事・本人手続き者）。
- 責任者・採用担当は PDF 自体は見えない（sign系は `canManageHr`）。ただし賃金の**値**は A・B の経路で見える。

### 7-5. 分離案（依頼 §9）

| 案 | 内容 | 防御 | 影響 |
|---|---|---|---|
| **A** 別テーブル + owner専用RLS | `gw_compensations`（履歴付き）を新設、`gw_is_owner` で select、書込は `/api/keiei`（service_role）のみ。`gw_contracts` の `wage_*` を移行後に削除。PDFは新バケット | **DB層で保証**。給与変更履歴（§9）も同時に解決 | 大: `api/contracts`、`admin-contracts.html`、`api/hr/payroll.js`/`lib/payroll-csv.js`、`lib/esign.js`（賃金差込・突合・必須欄）、`api/career/*`、`api/onboarding/*`、`lib/onboard.js`、採用側 `lib/hr.js`・`hr/*.html` ほか。テスト多数 |
| **B** 列権限（REVOKE）+ SECURITY DEFINER | 直接RESTは防げるが、service_role 側の `select("*")`（11箇所）が残る限り漏れやすい | 中 | 中。将来の追加コードで再流出しやすい |
| **C** API側フィルタのみ | `canSeeWage = roles.includes("owner")` で各 shape・CSV・conditions から賃金を除去 | **責任者・採用担当には有効**（A・Bのリスクを塞ぐ）。**管理者・人事には無効**（C・E・Fが残る） | 小。最短 |

**推奨: C を先に、A で確定（併用）。**
- 段階1（C）: 責任者・採用担当の漏れ（A・B）を API で先に塞ぐ。既存HRの業務を壊さない。
- 段階2（A）: 給与を別テーブル + owner専用RLSへ。**人事・管理者にも見せない**運用にするなら、通知書の「賃金」必須欄・登録STEP3・契約台帳の業務を「経営者が入力／承認発行」に再設計する必要がある。**これは運用判断（§12）**。
- 賃金以外（雇用区分・入社日・契約期間・試用期間・勤務形態・締結状況）は既存のまま HR に残せる（列が独立）。

---

## 8. 経営数値の取得可否（調査項目 9）

| KPI | 判定 | 根拠 |
|---|---|---|
| 今月経費 / 科目別 / 前月比 / 立替vsカード | **正確**（承認済+支払済） | `gw_expense_lines` / `gw_expense_reports`。税込前提は要確認 |
| 支払予定（立替経費） | **正確** | `status='approved' ∧ payment_method='personal'` |
| 今月売上 | **データ不足**（暫定推計のみ） | 請求額の列なし。近いのは `gw_site_contracts.unit_price`（**顧客請求か BP 支払か未定義**）。時給/日給は実稼働なしで算出不能、精算幅は自由記述 |
| 受注金額 | **データ不足** | Sales に金額列ゼロ。`status='won'` の**件数**のみ |
| 仕入（BP支払） | **データ不足** | BP支払額の列なし（受領フラグとファイルのみ） |
| 粗利 / 粗利率 | **データ不足** | 売上・仕入とも確定不可。単価の向きが未定義のため暫定でも出さない方が安全 |
| 営業利益・概算利益 | **データ不足** | 上記に依存 |
| 入金予定 / 未入金 / 入金済 | **データ不足** | 請求書（金額・期日）と入金記録のテーブルが無い |
| 支払予定（BP・給与・カード引落） | **データ不足** | |
| 今月人件費 | **暫定** | 契約上の基本給（`gw_contracts.wage_*`）＋通勤手当（任意入力）＋実労働（`gw_time_entries`）。**社保・賞与・残業割増・手当金額・役員報酬・実支給は無い**。契約未登録者・`wage_type=その他` 等の品質フラグが必要 |
| キャッシュ残高 | **データ不足**（未接続） | MFから取得する実装が無い。アプリ内試算表は期首残高なしで使えない |
| （補助）成約件数・営業ファネル | **正確**（件数） | `gw_sales_companies.status` |
| （補助）稼働時間（社員） | **正確** | `gw_time_entries`（BPは勤務表ファイルの受領フラグのみ） |
| （補助）請求進捗（5段階） | **正確**（金額なし） | `gw_billing_progress` |
| （補助）契約更新期限・稼働契約数・PP/BP人数 | **正確** | `gw_site_contracts`、`gw_employees.employee_kind` |
| （補助）月次締め状況 | **正確** | `gw_month_closings` |

### 売上系を「正確」にするための選択肢（いずれか、または併用）

| 案 | 内容 |
|---|---|
| (a) 請求・入金・支払データの取り込み | 請求行テーブル（請求番号・請求日・期日・税抜・税・入金日）を新設、または Board から取り込む |
| (b) MF連携の本実装 | スコープ拡張 + 試算表・預金残高取得（`getValidAccessToken` を利用）+ 保存先。**必要なMFスコープ名・エンドポイントは未確認**（このセッションでは MF MCP が接続失敗） |
| (c) 契約に原価側を追加 | `gw_site_contracts` に仕入単価と精算幅の構造化（下限・上限・超過/控除単価）を追加 |

### 再利用できるUI・部品

| 部品 | 場所 |
|---|---|
| KPIタイル（`.kp-tiles/.kp-tile`、スマホ2列） | `css/layout.css:129-181`（使用例 `admin-analytics.html`） |
| カード・バナー・ピル・タブ・表・進捗バー | `css/app.css`、`css/layout.css:219-222,531-538` |
| 簡易チャート（ライブラリ不使用の棒・横棒） | `admin-analytics.html:363-393`。**Chart.js は旧デモのみ（本番配信外）**。本番での CDN 読込の前例は `admin-onboard.html:291`（xlsx を cdnjs から） |
| fetch ラッパー | `js/api-client.js:200-231`（`API.api(path,{method,body})`。`mfa_required` は `mypage.html#mfa` へ自動遷移） |
| 専用ヘッダー型アプリの雛形 | `js/sales-layout.js`、`js/hr-layout.js` |
| 「管理者・経営者のみ」の集計画面の前例 | `api/analytics/index.js:20`（`isAdmin ∨ owner`）。金額系の既存ダッシュボードは無い |

**共通ユーティリティは不足**: 円フォーマットは各所で再定義（共通化なし。`data-loader.js` の `fmtYen` は本番配信外）、税込/税抜変換なし、月境界は `lib/closing.js:19-38` の JST 方式（UTC+9h を足して `toISOString`）が正。`/keiei` 用に `lib/keiei-*.js` で新設する。

---

## 9. テスト・CI への影響（調査項目 10）

| テスト | 追加・更新内容 |
|---|---|
| `test/accessparity.mjs` | (a) `canKeiei` の全ケース表（owner のみ true。admin / hr / isHr / manager / sales / recruiter / it / finance は false）、(b) `/api/me` の `access.keiei`、(c) `layout.js` の `showsFor` と `keiei-layout.js` の入口の突合、(d) SQL `gw_is_owner` が `gw_has_role(..,'owner')` のみで `is_tenant_staff`/`gw_is_hr` を含まないこと、(e) `api/keiei/**` の全ファイルが `canKeiei` を含むこと |
| `test/ui/headershortcutui.mjs` | owner の近道が `hr,sales` の2つ → `keiei` を含む期待値へ更新。admin only / hr / recruiter / sales / manager には「経営」が出ないこと。狭幅の縮小表示 |
| `test/navcheck.mjs` | 左メニューに足さない方式なら、`/hr/` `/sales/` 重複禁止の正規表現に `keiei` を追加する程度 |
| 新規 `test/keieiapi.mjs`（node） | `hrceoreviewapi.mjs` の型（`gwContext` は偽、`canX` は本物）。owner=200、admin only / hr / recruiter / manager / member / labor_advisor / tenant無し=403 |
| 新規 `test/ui/keieiui.mjs` | owner は開ける、admin only は `admin-dashboard.html` へ、recruiter は `home.html` へ（`hrceoreviewui.mjs:194-207` の型） |
| `test/sharedassets.mjs` / `speedcheck.mjs` | `layout.js` を変えるので約61画面の `?v=`、`api/health.js` の `assetVersion` を一括更新 |
| `test/mfatest.mjs` | 機密APIの `requireMfa` 入口数の検査があるため、`/api/keiei/*` の追加を反映 |
| `test/aiguard.mjs` | `GUARDED` に `api/keiei` を追加（AIを import しないこと。推測） |
| CI | `web-test.yml` の `paths` に `keiei/**`（と `hr/**`・`css/**`）を追加。CI の ui ジョブは `python3 -m http.server` のため **`vercel.json` の rewrite は効かない**。テストは `/keiei/index.html` の実パスで開く |

その他の注意: `js/api-client.js:235` の `mfa_required` 遷移は相対パス `mypage.html#mfa` のため、サブディレクトリ（`/keiei/*.html`）から呼ぶと 404 になる。`/keiei` は1画面構成にするか、絶対パス化を検討する。

---

## 10. 依頼文 §6〜9 に対する具体的な移行対象

| 現メニュー | 依頼の方針 | 調査を踏まえた提案 | 影響範囲 |
|---|---|---|---|
| 会計（`admin.html`） | `/keiei` へ | **リンクを `/keiei` に移設。`admin.html` は残す**（独立UI・削除しない）。`/keiei/accounting` は「当アプリ捕捉分（暫定）」の表示から開始。MF連携が入るまで実試算表は出さない。`/api/reports/*` の client 開放は別途塞ぐ | `layout.js:217`（メニュー）、`admin.html`/`app.html` の相互リンク、`api/mf/oauth/callback.js:13` |
| 経費精算 | 処理は Office、集計は `/keiei` | 申請・承認は**現行のまま**。`/keiei/expenses` は新規集計API（`lib/` に切出し）。既存 `GET` は使わない（500件上限） | 既存画面への変更なし |
| 月次業務 | Office に残す | **残す**。結果の数値は `/keiei` に集約するが、**売上・仕入・入金・支払は金額データが無いため現時点では出せない**（§8）。請求進捗・稼働・契約更新は正確に出せる | なし |
| 社内文書 | Office に残す | 残す | なし |
| 雇用契約 | 給与を分離 | §7-5 の C→A。HR に残す項目と `/keiei` に移す項目は列が独立しており分離可能 | 大（A案）。段階的に |
| メンバー管理・入退社・勤怠・評価 | HR に残す | 残す。ただし**評価・キャリアの給与欄は §7 リスクBの是正対象** | `api/career/*` |
| 権限・端末・アクセス分析・システム設定 | 管理・設定に残す | 残す。**「権限」の owner 付与の制限が Phase 1 の必須作業**（§2-3） | `api/employees/roles.js`、RLS |

---

## 11. 実装計画案（指示書の Phase を調査結果で修正）

### Phase 1: `/keiei` 基盤（最小の骨格）

1. `db/099_*.sql`: `gw_is_owner(uuid)`、`gw_role_grants` の owner 付与を owner 限定にする RLS 変更。
2. `lib/gw.js`: `KEIEI_ROLES`、`canKeiei`、`accessOf.keiei`。`api/roles.js`: owner 付与の owner 限定化。
3. `api/keiei/index.js`（`view=` 切替）: 入口に `canKeiei` + `requireMfa`、集計は `admin()`。
4. `js/layout.js`（近道 + `showsFor`）、`keiei/index.html`、`js/keiei-layout.js`、`vercel.json` rewrite、`?v=` 一括更新。
5. 初期ダッシュボード: **正確に出せるものだけ**（経費、請求進捗、契約更新、人員、成約件数、稼働）。売上・粗利・入金・キャッシュは**「データ不足」カード**として理由付きで表示し、推測値は出さない。人件費は「暫定（契約ベース）」ラベル付き。
6. テスト（§9）と CI paths。

### Phase 1.5: 給与の漏れを塞ぐ（API側 = 案C）

採用担当・責任者の経路（リスク A・B）を API で塞ぐ。既存HR業務を壊さない範囲。

### Phase 2: 既存機能の集約

会計の入口移設、経費の集計表示。

### Phase 3: 経営数値（**新データ源の決定が前提**）

売上・仕入・粗利・入金・支払・キャッシュ。§8 の (a)(b)(c) のいずれかが決まらないと着手できない。

### Phase 4: 経営分析

月次推移・案件別・サービス別・予実・資金繰り。顧客軸は `site_company` が自由記述のため顧客マスタが要る。

### 給与の本分離（案A）

Phase 2 と並行または後続。運用判断（人事に給与を見せるか）に依存。

### 入社オンボーディング（第2指示書）

`/keiei` 基盤の後。付録A 参照。

---

## 12. 決めてほしいこと

| # | 論点 | 推奨 |
|---|---|---|
| 1 | 「経営者のみ」= owner ロールのみ（管理者を含めない）で確定してよいか。owner を持たない管理者は `/keiei` に入れなくなる。なお `s_morita@gw.8grp.co.jp` は bootstrap 上 staff + owner + hr | owner のみ。あわせて owner の付与・剥奪を現 owner に限る（§2-3） |
| 2 | ヘッダー: 「Office」タブは実在しない。「経営」を近道の3つ目として足す形でよいか | 足す（採用HR / Sales / 経営）。Office ラベルは作らない |
| 3 | 給与の分離: HR・管理者にも給与を見せない方針か（案A）、責任者・採用担当だけ塞ぐ（案C）か | まず C。A は業務フロー（通知書の賃金必須欄、登録STEP3）の再設計が要るため運用側の合意が必要 |
| 4 | 売上・粗利・入金・キャッシュの元データ: MF連携 / 請求・入金テーブル新設 / 契約に原価単価追加 のどれで進めるか。`gw_site_contracts.unit_price` は顧客請求か BP 支払か | 決まるまで Phase 3 は保留。Phase 1 は「データ不足」表示 |
| 5 | 入社案内のメール送信基盤（現状なし）を新設するか、URL・初回パスワード手渡しを継続するか | 別途判断。オンボーディングの Phase 送りでよい |
| 6 | 本番DBに `db/035`・`041`・`094` 等が適用済みか（`db/check_status.sql` で確認できる） | 確認をお願いしたい |
| 7 | 経営者アカウントの二段階認証を 9/30 までに登録できるか（10/1 強制） | 要登録 |

---

## 13. 未確認事項

- 本番DBの実データ量（`journals`、`gw_contracts` の充填率、`gw_time_entries` の運用率、`gw_site_contracts.unit_price` の入力状況）。
- 本番DBのマイグレーション適用状況。`db/000_install_fresh.sql` は 064 前後まで、075〜080 を含まない（個別適用が前提）。各APIは未適用時に `notReady` を返す作り。
- MFの実APIで必要なスコープ名・エンドポイント（このセッションでは MF MCP が `ERR_PROXY_TUNNEL: 403` で接続失敗）。
- 会計 `memberships` の client 行が入社予定者に及ぼす具体的な可視範囲。
- Vercel のプラン（`api/**/*.js` は163ファイルで、Hobby の12関数制限を超えている。cron が15分間隔のため Pro 以上と**推測**。コード・docs に制限の記述は無い）。

---

## 付録A: 入社オンボーディング（第2指示書）の Phase 0

### A-1. 既存の「6ステップ」は3系統ある

| 系統 | 定義 |
|---|---|
| 管理者5段階 | `lib/onboard-stage.js:32`（conditions / advisor_review / signing / intake / complete） |
| 本人画面・3者共通6STEP | `lib/onboard-steps.js:46`（社労士確認 / 本人契約 / 入社情報 / 必要書類 / 会社確認 / 完了）。`onboarding.html` の見出し |
| 採用〜育成 10状態・6フェーズ | `lib/journey.js:18,202`。加えて契約×キャリアの5状態（`lib/career.js:383/416/447`、最新コミット a4bad08） |

いずれも「事実から毎回計算し、状態は保存しない」方針（`lib/journey.js:4-8`）。**新6ステップは既存判定への表示写像**にする。番号・意味が既存 STEP と衝突するため、`onboarding.html` の見出しも更新が必要。

### A-2. 新6ステップ × 既存機能

| 新ステップ | 判定 | 再利用 | 足りないもの |
|---|---|---|---|
| ① 入社案内 | **拡張要** | `gw_orientation_items/checks`（全社共通教材）、`gw_procedures.target_on`、`gw_action_items`、`lib/onboard-brief.js` | **個人宛の案内**（集合時間・場所・持ち物・担当）の置き場所。経営者が準備→本人へ公開する状態。配布手段（メール無し） |
| ② 労働条件・契約 | **再利用可（ほぼ全面）** | 採用HR→advance→`onboardOne`→`gw_doc_orders`→社労士 approve→`gw_sign_requests`→署名。contract-check（`api/sign/orders.js:271`）。`contracts.html` | 経営者UIからの起動導線。`gw_sign_requests.contract_id`（db/097）は**書き込む処理が無く常に null**（`doc_kind` による推測フォールバックで動作）→「締結済み」を厳密にするなら書き込み側の追加 |
| ③ 本人情報・必要書類 | **再利用可（全面）** | `gw_onboard_profiles`、`gw_onboard_consents`、`gw_procedure_items`/`files` + `hr` バケット。書類種別追加は `lib/onboard-docs.js DOCS` への追記 | **マイナンバーは番号も書類も持たない方針**（`docs/onboarding-redesign.md:99-117`）。番号欄は作らない |
| ④ アカウント準備 | **拡張要** | アカウント自動作成（`attachAccount`）、手動項目 `on_it_mail/slack/pc/agent/perm`、`gw_assets`、`gw_devices` | 会社メールの記録先・自動発行なし。初回ログイン・MFA・端末稼働を項目状態へ反映する処理なし。入社予定者は MFA 対象外 |
| ⑤ キャリア設計 | **再利用可（一部拡張）** | `gw_employee_careers`（1年/3年・次回評価日・本人確認）、`gw_growth_plans/months/kpis`（**3か月計画は登録時に自動作成済み**）、`gw_career_reviews`、`career.html`/`admin-career.html` | **6か月目標の置き場所**（専用列なし。2本目の計画か1年ノートで表現）。入社予定者は `career.html` を開けない（`lib/stages.js:72`）。面談記録の表は無い |
| ⑥ 最終確認 | **拡張要（軽微）** | `computeStage` の complete + `advance()`（status=done・完了通知）、`overallStatus` | 「経営者が最終承認した（誰が・いつ）」の記録。現行の complete は事実がそろえば自動 |

### A-3. 新設テーブルの要否

**原則不要。** 6ステップの進捗テーブルは「事実から計算」の既存方針に反する（保存すると必ず食い違う）。入社予定者は `gw_employees.status='invited'`、個人宛案内・公開状態・最終承認は `gw_procedures` への列追加で足りる。**唯一新設が妥当になり得るのは「入社予定者向けの期限付き招待URL」**（社員向けは無く、現行は初回パスワード手渡し）。前例は `gw_guest_invites`（db/078）と `gw_hr_offers` のトークンURL。

### A-4. 主なリスク

1. **順序の不整合**: `onboardOne` は登録時に `gw_contracts` を**署名前に active**、3か月計画も登録時に active で作る。「①案内→②契約→…→⑤キャリア」を経営者が組む設計と競合する。`journeyOf` は「入社手続き完了後にキャリア」なので、⑤を⑥の前に置くなら判定の入れ替えが要る。
2. **メール送信基盤が無い**（`docs/labor-notice-delivery.md:73-77` に未実装と明記）。招待メール・会社メール自動発行は外部基盤の導入が前提。
3. **「経営者のみ」との整合**: 既存の入社機能（`admin-onboard.html`、`admin-hr.html`）は admin/hr/owner が使う。`/keiei/onboarding` は**経営者向けの準備・送信・進捗ビュー**として並存させ、既存の登録・署名・手続きは触らない。HR には給与・契約本文を見せず進捗のみ連携（第2指示書 §3）。
4. **AIガード**: `test/aiguard.mjs` の GUARDED に入社系が含まれ、`lib/ai.js` 等を import できない（キャリア文案のAI下書きを入社系に持ち込めない）。
5. **手続き作成の入口が3つ**（`onboardOne` / `api/hr` create / `api/onboarding` POST）。新画面は `lib/onboard-kit.js` の `findProcedure` / `createOnboardingKit` を使う。
6. **通知の限界**: 入社系は kind:"general" でベルのみ。Slack に氏名が出る点の「入社系は既定オフ」方針は未実施。
7. **schemadrift**: 列を足すなら SQL を同時に（`test/schemadrift.mjs`）。DB番号は次が `099`。

---

## 付録B: 裏取り済みの主張（このレポート作成者が実コードで再確認）

| 主張 | 確認箇所 |
|---|---|
| owner は管理者・人事にも付与できる | `api/employees/roles.js`（権限は `canManageHr` のみ、owner 限定条件なし）、`db/005:199-203`（`gw_role_grants_hr_write` = `gw_is_hr`）、`db/041:35-47`（`gw_is_hr` は `is_tenant_staff` を含む） |
| 責任者が `/api/career` で部下の給与を取得 | `lib/career.js:64`（`canManageCareer` に manager）、`api/career/index.js:76`（ガード）、`:117-125`（`currentWage` が `gw_contracts.wage_*` を返す） |
| 採用担当が候補者の給与を読める | `api/hr/applicants/index.js:21`・`detail.js:21`（`wage_type, wage_amount` を select）、`db/081:269-283`（`gw_is_recruiting` で all）、`db/081:40,51`（コメントとの矛盾） |
| 会計APIが全社員に開いている | `lib/accounts.js:194-213`（全員に client 付与）、`lib/auth.js:39-46`、`api/reports/trial-balance.js:24` |
| 近道は採用HR / Sales の2つ、`accessOf` は recruit/sell のみ | `js/layout.js:298-301,826-849`、`lib/gw.js:132` |
| 二段階認証の対象と強制日 | `lib/mfa.js:28-32` |
