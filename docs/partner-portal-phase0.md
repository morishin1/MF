# ENGER パートナー営業ポータル Phase 0：既存実装の調査と差分開発計画

- 作成日：2026-11-14
- 対象要件：`ENGER パートナー営業ポータル 要件定義書`（2026-11-14 版）§13 Phase 0
- 調査範囲（読み取りのみ・DB変更なし）
  - `morishin1/mf`：Sales（gw.8grp.co.jp/sales）・HR・Office
  - `morishin1/enger_new`：ENGER DX（dx.enger.jp）
  - `morishin1/enger-lp`：ENGER BUSINESS（企業ポータル）
- **本番DBのスキーマは実測していない。** コード・SQLファイル・既存docsの記述からの調査。実装前に `information_schema` で実在確認する。

---

## 0. 結論（先に読む）

1. **土台はかなりある。** 6ステップ商談ナビ、企業ポータル（招待・匿名表示・オファー）、契約依頼キュー、2週間トライアル、HMAC連携は実装済み。**新しい画面系統を作り直す必要はない。**
2. **最大のリスクは権限。** Sales のサーバー側は「Salesに入れるか否か」の二値で、多くのAPIが service_role で RLS をバイパスし、企業スコープ判定（`companyInScope`）はテナントしか見ていない。**外部パートナーに既存の `sales` 権限を付けると、テナントの Sales データ全体が読めて書ける。** → 専用アプリキー＋専用APIで「割当企業・本人の記録」に絞るのが必須で、これを最初のPRにする。
3. **「提案可能な候補」の単一判定が無い。** ENGER DX側で条件（ステータス・ゴミ箱・クローズ・stale・企業オプトアウト）は揃っているが散在し、提案作成時の検査は一覧より緩く fail-open がある。人材の「最終確認日」「社外提案許可」は列が無い。
4. **新規に必要なデータは4つに絞れる。** ①パートナー×企業の割当、②提案・商談・オファーへのパートナー帰属、③パートナー報酬台帳、④応募者→トライアル→パートナーを結ぶ人物ID。それ以外は既存表の加算列で足りる。
5. **状態の正が既に3つある**（`enger.proposals.stage` / Sales `gw_sales_proposals.status` / `enger.dx2_sales_pipeline.status`）。パートナーポータル用に4つ目を作らない。

---

## 1. 既存IDの対応表（要件§10の論理モデル → 実体）

| 論理エンティティ | 既存の実体 | 状態 | 備考 |
|---|---|---|---|
| パートナー | **無し**。近いもの：`gw_guests`（db/078、社員名簿と分離）、`gw_app_grants`（hr/sales/office/marketing）、ENGER側 `partner_organizations` + `organization_memberships.membership_type='partner'` | 新規 | `gw_employees` に入れると「社員行があれば見せる」既存RLSに乗り漏えいする（db/078:4-11） |
| 契約・トライアル | `gw_hr_trial_periods`（db/180、14日固定、basis=contractor可、decision）、`gw_contracts`（db/029）、Office契約条件（db/106） | 既存＋接続 | トライアル合格→権限有効化の経路が無い |
| 人物ID | 応募者 `gw_hr_people`（db/182）→ `gw_hr_applicants.employee_id` → `gw_employees.user_id` | 不足 | 応募者→パートナーを結ぶキーが無い |
| 企業 | `enger.companies`（正）＋テナントビュー `dx2_sales_company_directory_for_tenant`。旧 `gw_sales_companies`（db/088）とは `gw_sales_company_links` で接続 | 既存 | パートナーは **`enger.companies.id` のみ** を使う |
| 企業割当 | **無し**。ENGER企業に担当者列なし。`dx2_sales_daily_assignments`（日次配布）、`dx2_workboard_pair_assignments`（提案A/B）は別用途 | 新規 | |
| 営業機会 | `gw_sales_deals` + `_history`（db/116、meeting→proposal→negotiation→won/lost） | 既存 | 要件§6の主ステータスはここに寄せるか要決定（§5 D-3） |
| 活動履歴 | `gw_sales_approaches`、`gw_sales_events`、`gw_sales_company_activity`（db/173） | 既存 | actor の記録方式を合わせる |
| 提案（企業への公開候補） | `enger.dx2_company_sales_shortlist`（status=published、企業ポータルの表示元） | 既存 | 提案者列が無い |
| 提案（人材×案件） | `enger.proposals`（`(job_id,candidate_id)` 一意）→ Sales `gw_sales_proposals`（担当RLSあり） | 既存 | 下書き/送信の区別は無く、送信事実は `enger.mail_sent` のみ |
| 商談 | `gw_sales_live_meeting_sessions`（db/165/174/178、1社1active、楽観ロック）、`_stage_events`、`gw_sales_meeting_closeouts` | 既存 | 旧 `gw_sales_meetings`（db/090）も並存 |
| オファー | `enger.dx2_company_portal_offers`（db/171）、`dx2_company_job_offers`（RPC `gw_sales_company_job_offer_create`） | 既存 | 帰属は `created_by` のみ |
| 引き継ぎ | `gw_sales_contract_requests` + `_events`（requested→in_progress→review→completed/cancelled、Office `contract-requests.html`）、`gw_sales_proposal_handoffs` | 既存 | 起票が提案単位・「合格」前提 |
| 契約・稼働 | `gw_contracts`、Office `gw_site_contract_terms` | 既存 | |
| 売上・原価 | `gw_sales_success_fees`（db/179、**企業から受け取るENGER成果報酬**）、`gw_site_contract_terms.purchase_unit_price`、`gw_vendor_invoices`（db/117） | 一部 | 月次の売上・直接原価・粗利を1行で持つ表は無い |
| 報酬ルール／報酬台帳 | **無し** | 新規（Phase 2） | success_fees と混同しない |
| 監査ログ | success_fees の監査トリガー、`gw_sales_deal_history`、ENGER `activity_logs`、`partner_assignment_log` | 既存の型を流用 | |

---

## 2. 画面ごとの「使えるもの／新規」

| 画面 | 既存で使えるもの | 新規・改修 |
|---|---|---|
| P-01 初回ログイン | Supabase Auth、`requireUser`、`gw_app_grants`、`gw_guests` の分離設計 | 新アプリキー `partner_sales`（仮）、`/partner` 入口ゲート、規約・誓約・契約状態の確認、権限停止 |
| P-02 今日やること | `gw_sales_proposal_tasks`、`decision-brief.js`、ENGER `/workboard` の `decideWork` の考え方 | パートナー本人のタスク集約API（割当企業×次回行動×商談予定） |
| P-03/04 企業・提案一覧／企業詳細 | ENGER企業ディレクトリ、法人番号一意（db/173）、NG/非表示（`directory_hidden_at`・`needs_contact_review`・`company_blocked`）、`dx2_sales_pipeline.is_ng` | 割当表、割当申請→承認、他担当中の排他 |
| P-05 候補選択・提案 | `dx2_company_sales_shortlist`（published）、`portal_public_details.approved`、匿名表示（P-/J-番号・イニシャル） | **ENGER側の単一判定 `isPartnerProposable`＋署名付き読み取りAPI**、提案者列、送信冪等キー、送信時スナップショット |
| P-06 商談ナビ | `api/sales/meeting-session.js`、`meeting-closeout.js`、6ステップ、ステップチェック、`accept_company_offer` | パートナー権限での所有者スコープ、ステップ自動保存、**事後登録**、「商談済」の単一定義、メール送信なしで終了できる経路 |
| P-07 引き継ぎ | `gw_sales_contract_requests`（Officeキュー）、`gw_sales_proposal_handoffs` | 商談・オファー起点の契約依頼起票、受領担当・期限・差戻し理由の表示 |
| P-08 KPI | `lib/sales-member-performance.js`（本人のみ表示の分岐あり）、`meeting-funnel-analysis.js` | パートナー（非社員）IDでの集計。今は `gw_employees` 前提で名前を引く |
| P-09 報酬明細 | 監査トリガーの型 | 報酬ルール・報酬台帳（Phase 2） |
| A-01 パートナー管理 | `admin-members.html`（`gw_is_hr`）、`hr/trials.html` | トライアル→有効化→停止の操作、割当管理 |
| A-02 契約・CSキュー | `office/contract-requests.html` | パートナー起点の項目表示 |
| 企業側（ENGER BUSINESS） | 招待URL（7日・1回・sha256保存）、`activate/new/link`、`resolveBusinessMember` による企業スコープ、`meeting-offer.ts`、`portal-submissions.ts`、Slack通知 | オファー→パートナー通知、`talent-list` の全件匿名一覧の扱い |

---

## 3. 調査で見つかった既存の問題（パートナー導入前に直すもの）

| # | リポジトリ | 内容 | 影響 |
|---|---|---|---|
| R-1 | MF | `companyInScope`（`lib/sales-company-portal-db.js:13`）がテナントのみ判定。Sales API 78本中51本が service_role | パートナーに `sales` 権限を付けた瞬間に全件漏えい |
| R-2 | enger_new | 提案作成（`actions/matching.ts:316-361`）が人材ステータス・企業オプトアウト・`is_published`・stale を見ない。`closedReasonOf` が読み取り失敗で fail-open | 未確認候補が提案され得る |
| R-3 | enger_new | `syncProposalSnapshots` が案件・人材編集のたびに提案行の写しを上書き | 「提案時点の条件」が残らない |
| R-4 | enger_new | 提案メール送信に二重送信防止が無い | T-08 不合格 |
| R-5 | enger-lp | `/api/business/talent-list` は `companyId` なしで法人ユーザーに全人材の匿名一覧を返す（#766仕様） | 「提案された候補だけ見せる」と矛盾（仕様判断が必要） |
| R-6 | enger-lp | 自社案件判定が `jobs.client_name = companies.name` の文字列一致 | 社名変更・同名で誤判定 |
| R-7 | enger_new | `/s/[token]` が単価を生表示、匿名名が `name.charAt(0)` にフォールバック | 共有リンク経由の情報露出 |
| R-8 | MF | 商談「実施」の定義が3系統（`gw_sales_meetings.done` / closeout `mail_status='sent'` / `gw_sales_proposals.meeting_done`） | KPIの二重計上・取りこぼし |

R-1・R-2 はパートナー公開の**前提条件**。R-3〜R-8 は該当PRの中で直す。

---

## 4. 差分PR計画（小さく分ける）

### Phase 1（MVP）

| PR | リポジトリ | 内容 | 受入テスト |
|---|---|---|---|
| 1 | MF | **権限の土台**：`gw_app_grants` に `partner_sales` を加算、`gwContext` に `isPartner` を追加（既存 `canSell` は不変）、パートナーは既存 `/api/sales/*` を全拒否、`test/accessparity.mjs` 更新 | T-01, T-17 |
| 2 | MF | **パートナー台帳と割当**：パートナー表（auth user・参加形態・ロール・状態・有効期限）、パートナー×`enger.companies.id` 割当表（開始/終了・承認者）、監査ログ。SQL＋`test/sql` 陰性テスト | T-03, T-16 |
| 3 | enger_new | **提案可能判定の一本化**：`isPartnerProposable`（既存部品の合成）、提案作成時にも同判定・fail-closed 化（R-2）。加算列：人材 `last_confirmed_at`・`external_proposal_allowed`（実在確認後） | T-05 |
| 4 | enger_new | **署名付き候補読み取りAPI**：HMAC 検証、返す列の許可リスト、匿名化、件数・ページ上限 | T-05 |
| 5 | MF | **パートナーAPI `/api/partner/*`**：今日やること・割当企業一覧・企業詳細（割当外は404） | T-02, T-03, T-04 |
| 6 | MF | **パートナー画面 P-01〜P-05**（4ナビ・モーダル中心）＋ shortlist への提案者列・冪等キー・スナップショット | T-06, T-07, T-08 |
| 7 | MF | **商談ナビのパートナー対応**：所有者スコープ、ステップ自動保存、事後登録、「商談済」の単一定義（R-8）、社員との同一企業衝突の扱い | T-09, T-10, T-11 |
| 8 | MF＋enger-lp | **オファー帰属と引き継ぎ**：オファーにパートナー帰属、契約依頼の商談起点起票、パートナー・社内通知（アプリ内優先） | T-12, T-13 |
| 9 | MF | **KPI**：パートナーIDでの集計、提案群コホートでの転換率、10/15提案0商談アラート、管理者画面 A-01 | T-18, T-20 |

### Phase 2

10. HR トライアル合格→パートナー有効化、人物IDの接続（`gw_hr_people` ↔ パートナー）、契約未締結時の営業操作停止。
11. 報酬ルール・報酬台帳（見込→計算済→確認待ち→承認済→支払予定→支払済）、Office支払・源泉徴収との接続。
12. 本人報酬明細 P-09、社内 A-03。

---

## 5. 着手前に決める必要がある事項

| ID | 論点 | 推奨案 |
|---|---|---|
| D-1 | パートナーの主体を `gw_guests` 拡張にするか、新表＋`partner_sales` キーにするか | **新表＋新アプリキー**。guest は読み取り専用設計で用途が違う |
| D-2 | ENGER DX 側の `partner_organizations`（協力会社ログイン）と同じ概念にするか | **別概念**（あちらは人材供給側の協力会社）。命名も `sales_partner` 等で分ける。enger-lp の `partner_submissions` とも衝突させない |
| D-3 | 要件§6の「営業機会の主ステータス」の正 | 新設しない。**提案後は Sales の正（2026-11-03 決定）、企業の営業状態は `dx2_sales_pipeline.status`**。パートナー画面は既存値の表示変換のみ |
| D-4 | 同じ企業で社員とパートナーが商談ナビを開く場合（1社1active制約） | 割当がある企業は担当パートナー優先、社員は同席扱い |
| D-5 | 企業ポータル招待の発行者 | パートナーは「招待依頼」まで。発行は社内（要件§5「社内承認フロー」と整合、仮パスワード方式は採らない） |
| D-6 | `talent-list` の全件匿名一覧（R-5）を残すか | パートナー提案導線では使わない。残す場合は仕様として明記 |
| D-7 | 報酬率・対象・確定タイミング・支払期日 | 社内承認待ち（要件§16-10）。Phase 2 着手条件 |

---

## 6. 本番反映の注意

- MF の SQL は手動適用（`db/NNN` を SQL Editor）。**コードより先に SQL を適用**し、`check_*.sql` で確認する。
- MF と ENGER は同一 Supabase プロジェクト（public / enger スキーマ）を共用している（`docs/sales-proposals.md:274`）。enger スキーマへの加算は enger_new 側の規約（加算のみ・`docs/supabase.md` へ追記）に従う。
- 機能フラグでパートナー機能を少人数（業務委託2名＋営業サポート1名）に限定公開し、陰性テスト（他社・他人・未許可候補が取れないこと）を本番相当データで通してから広げる。
