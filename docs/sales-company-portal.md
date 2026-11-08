# 企業商談・企業ポータル（Sales 起点・ENGER 連携）

指示書「Sales起点・ENGER連携 企業商談／企業ポータル 実装要件定義（2026-11-06）」の Phase 0（現状調査）と Phase 1（MVP）。

> **状態**：コードとテストは揃っているが、**共有 Supabase への SQL（`db/161`）は未適用・本番の動作は未確認**。
> SQL の適用・環境変数・マージは、依頼者がプレビューを確認して承認してから行う。

- Sales（このリポジトリ）：企業詳細モーダルの4タブ、企業アカウントの発行・停止、商談準備、進捗
- 企業ポータル：**enger.jp/business**（enger-lp リポジトリ。`docs/business-portal-sales-accounts.md`）
- DB：`db/161_enger_company_portal.sql`（確認 `db/check_161_…`・戻す `db/rollback_161_…`・検証 `test/sql/161_enger_company_portal.sql`）

---

## 0. Phase 0 現状調査（2026-11-06）

### 0.1 実際の構成

| 対象 | リポジトリ／実体 | 根拠 |
|---|---|---|
| Sales `gw.8grp.co.jp/sales/` | MF（静的 HTML ＋ Vercel Functions） | `sales/*.html`・`api/sales/*` |
| ENGER DX `dx.enger.jp` | enger_new（Next.js 16） | enger_new `README.md`・`src/app/(app)/*` |
| 企業ポータル | **既にある**：enger-lp の `enger.jp/business/*`（ENGER business。法人ログイン・匿名の人材一覧・案件登録・選考） | enger-lp `docs/business-portal-v2-enger-lp.md`（「enger-lp を正とし、dx の `/portal/*` へは移さない」と決定済み） |
| 旧DX | enger-matching（畳む方針） | enger_new `docs/supabase.md` |
| DB | **Sales と ENGER は同じ Supabase プロジェクトを共有**（`public.*` と `enger.*` が同居） | `db/158` の「Applied to shared Supabase project on 2026-11-04」、`api/sales/enger-company-detail.js` などが `admin().schema("enger")` で直接読んでいる |

> `docs/SETUP_APP.md`・`docs/sales-proposals.md`・enger_new `docs/ops/20261019_gw_sales_link.md` は「別プロジェクト」と書いているが、
> 既存の Sales の API（2026-11 以降）は同じプロジェクトであることを前提に動いている。本 PR もその前提（**要確認事項 1**）。

### 0.2 調査項目ごとの結果

| # | 項目 | 実装済み（根拠） | 未実装・問題 | 本 PR の変更 |
|---|---|---|---|---|
| 1 | 企業一覧・企業詳細モーダル | `/sales/companies` → `sales/company-segments.html`。行クリックで `#lc-dialog`（`js/sales-company-workbench.js`：登録情報／次のアクション／営業履歴の3ペイン）。企業IDは `enger.companies.id` | 4タブ構成ではない | 3ペインをそのまま①企業情報にし、②〜④をタブで追加 |
| 2 | 人材・案件 DB と検索 API | `enger.candidates`（列は 0.3）。注力＝`is_focus`、新着＝登録14日（dx の人材一覧）、提案できない状態＝`NON_PROPOSABLE_STATUSES`（enger_new `src/lib/candidate-status.ts`）。Sales は `api/sales/enger-focus.js` で注力だけ読んでいる。enger.jp は `/api/business/talent-list`（イニシャル＋条件）。マッチングは enger_new `src/lib/match-engine/match.ts` の `rankCandidates`（純関数。enger-lp に写し `src/lib/enger-match/`） | 企業提示単価の列が無い。案件（`enger.jobs`）に企業IDが無い（`client_name` の文字列） | 公開項目の許可リスト（`lib/enger-talent-public.js`）を作り、Sales と enger.jp で同じ形にした |
| 3 | 企業IDと重複 | 企業の正は `enger.companies`。Sales の CRM（`gw_sales_companies`）とは `gw_sales_company_links` で ID 紐づけ | **enger.jp の法人アカウントは会社名の文字列（`user_metadata.company_name`）だけで、企業IDに紐づいていない**（dx `/companies/accounts` も名前の一致で表示しているだけ） | 企業ポータル利用者の台帳（`enger.dx2_company_portal_members`）で企業IDに紐づける |
| 4 | Supabase Auth・RLS | `auth.users` は enger.jp・dx・coo・lms・グループウェアで共有。社内の判定：Sales＝`gw_employees`／`gw_role_grants`、dx＝`enger.app_users`（admin/agent）、enger.jp＝`app_metadata.apps`（business/freelance…）。停止は Supabase の ban（enger.jp の login が日本語化済み） | **`enger.candidates` は anon キーで全列が読める**（`select using(true)`。dx `docs/supabase.md`）。企業ポータルの API を通さなくても読める状態 | 新しい表は anon/authenticated から完全に遮断（service_role だけ）。既存の RLS は変えていない（要確認事項 2） |
| 5 | 商談・提案・オファー | dx → Sales の提案連携（`gw_sales_proposals`・HMAC・`docs/sales-proposals.md`）。enger.jp の「会いたい」は法人相談（`enger.contact_messages`）。エンジニア側のスカウトは `enger.scouts` | 企業からのオファー（offer_id）の仕組みは無い | Phase 1 は進捗タブで既存の提案を企業IDで表示。オファーは Phase 3 と明示 |
| 6 | Slack・履歴 | Sales：`lib/slack.js`・`lib/sales-proposal-slack.js`（`SALES_SLACK_WEBHOOK_URL`）。enger.jp：`src/lib/notify.ts`。dx：無し。履歴：`gw_activity_log`・`gw_sales_company_activity`・`enger.activity_logs` | — | 企業ポータルの操作は追記専用の `enger.dx2_company_portal_events` に残す（Slack は Phase 3） |

### 0.3 人材の列と公開可否（enger_new の実装から確認）

| 区分 | 列 |
|---|---|
| 企業に出す（許可リスト） | `candidate_no`（P-000123）・`initials`（無ければ人材番号）・`title`・`role_labels`・`skills`・`exp`・`avail`・`week_days`・`remote_pref`（区分に変換）・`location`（**都道府県まで**）・`nearest_station`・`age_band`・`nationality`（既存の一覧で表示済み）・`is_focus`・`created_at`（新着の判定） |
| 出さない（読みもしない） | `name`・`email`・`contact_*`・`company`・`source_company`・`affiliation`・`partner_organization_id`（所属・商流）・`rate`・`salary_min/max`・`rate_num`（希望単価＝仕入れ）・`flow_depth`・`note`・`detail`・`detail_note`（メモ）・`skill_sheet_*`（原本）・`signup_source`・`source_*` |
| 出さない（絞り込みだけ） | `status`・`is_closed`・`deleted_at` |

自由記述（経験年数・稼働開始・稼働日数・最寄り駅）は短く切り、メール・URL・電話番号の形を「［非公開］」にする。

### 0.4 Phase 0 で見つかった既存の問題（本 PR では直していない。判断が要る）

1. **`enger.candidates` が anon キーで全列読める**（氏名・連絡先・単価を含む）。企業ポータルの API は許可リストしか返さないが、DB の権限がこのままでは「露出ゼロ」にならない。
   RLS の差し替えは旧DX・coo・enger-lp への影響確認が必要（dx の AGENTS.md「RLS を差し替えない」）。列単位の revoke かビューへの切り替えを別途計画する。
2. **企業向けに希望単価（＝仕入れ）を出していた箇所**：enger.jp の未ログインのプレビュー（`/api/business/talent-preview`）、`/business/candidates` のおすすめ・スカウトのカード、ダッシュボード、請求画面。
   画面の表示は本 PR（enger-lp）で外した。**API の応答（DX の `recommended-candidates`・`proposals` と `talent-preview`）には残っている**。
3. **enger.jp/business の DX 連携先が無い可能性**：enger-lp は `https://dx.enger.jp/api/public/{jobs,me,proposals,feedback,recommended-candidates,…}` を呼ぶが、
   いまの dx.enger（enger_new）には `/api/public/job-detail` しか無い。案件登録・選考・おすすめ人材が本番で動いているか確認が要る（この環境からは本番に届かず未確認）。
4. スキルシートの保存先 `skillsheets` が「公開」（enger-lp `docs/dx-skillsheet-display-spec.md`）か「非公開」（enger_new `src/lib/skillsheet-url.ts`）か、資料が食い違っている。原本は取引先のファイル（氏名・所属入り）なので、企業には出さない。
5. 既存の失敗（本 PR の前から main で失敗）：MF のテスト6本（`hrofferflowapi`・`keieihubapi`・`officedesign`・`officemonthflow`・`sales-decision-board`・`sales-enger-execution-link`）、enger-lp のテスト5本、`astro check` 27件。

---

## 1. 方針（Phase 1 で決めたこと）

- **企業ポータルは enger.jp/business を使う**（新しいポータルは作らない）。Sales の企業詳細からアカウントを発行し、企業IDに紐づける。
- **企業の正は `enger.companies.id`、人材は `enger.candidates.id`**。別の企業マスタ・人材マスタ・オファー表は作らない（オファーは Phase 3 で設計）。
- **認証は既存の Supabase Auth**。社内と社外を混ぜない：
  - 社員（`gw_employees`）・ENGER の社内メンバー（`enger.app_users` の admin/agent）のメールには発行しない
  - 招待で作るアカウントは `app_metadata.apps = ['business']`（enger.jp の法人。フリーランス・社内画面には入れない）
  - 企業IDは**リクエストから受け取らない**。ログイン中の利用者 → 台帳の行 → 企業ID
- **初回パスワードは本人が招待リンクで決める**（7日・1回だけ）。トークンは sha256 だけを DB に置き、平文は発行の応答で1回だけ表示。
- **停止**：台帳の `disabled_at`（ログイン・検索・閲覧・保存を即時に拒否）＋ ポータル専用アカウントは Supabase の ban（新しいセッションも作れない）。
  フリーランス等と兼ねたアカウントは ban しない（ほかのサービスまで止めない）。再開は経営者・責任者だけ。
- **企業に見せる人材は許可リストだけ**（0.3）。**単価は出さない**（企業提示単価の列が無いため。担当営業が提示）。
  スキルシートは**公開用（要約版）**を許可項目から作る。原本は出さない。
- **商談準備の紐づけ（保存候補／提案予定／提案済み／見送り）は社内向け**。企業ポータルには出さない。企業の「保存」は別（企業内で共有）。

## 2. Phase 1 で実装したもの

### Sales（このリポジトリ）

企業一覧の行クリック → 企業詳細モーダル（既存）に4タブ：

| タブ | 内容 | API |
|---|---|---|
| ① 企業情報 | **既存のワークベンチのまま**（登録情報・次のアクション・営業履歴） | 既存 |
| ② 商談準備 | ENGER 人材の検索（全人材／注力／新着／この企業に紐づけ済み）。キーワード・スキル・働き方・居住地・稼働日数・早期稼働・並べ替え（関連度／新着）。複数選択して状態つきで保存。人材詳細はサマリーが初期表示、スキルシート（公開用）は1クリック。状態・社内メモの変更。ENGER DX の人材詳細へのリンク | `GET/POST/PATCH /api/sales/company-talents` |
| ③ 企業ポータル | アカウント発行（氏名・メール・権限）・招待リンクの表示（1回だけ）・招待メール（設定時）・再招待・停止（理由必須）・再開（責任者）・権限変更・担当者一覧（状態・招待／登録・最終ログイン）・企業が保存した人材・利用履歴（30日のログイン・検索・閲覧数） | `GET/POST /api/sales/company-portal` |
| ④ オファー・進捗 | この企業IDの提案（状態・案件・人材イニシャル・営業担当・マッチング確定・提案・面談・終了理由・ENGER ステージ・提案を開く）。営業担当は自分の担当分だけ、責任者は全件。商談準備の状態別件数。**企業ポータルのオファーは Phase 3 と明示** | `GET /api/sales/company-progress` |

- 企業IDの無い行（営業DBだけの企業）では②〜④は押せない（理由を表示）。閉じて開き直すと①に戻り、②〜④は DB から読み直す。
- 権限：Sales を使える人（`canSell`）かつ株式会社エイトのテナント（`canAccessEightEngerDirectory`）。企業IDは Sales の企業一覧（`dx2_sales_company_directory_for_tenant`）にあるものだけ。
- ファイル：`js/sales-company-portal-tabs.js`・`sales/company-segments.html`・`js/sales-company-segments.js`・`css/sales-company-segments.css`・
  `api/sales/company-{talents,portal,progress}.js`・`lib/enger-talent-public.js`・`lib/sales-company-portal.js`・`lib/sales-company-portal-db.js`・`lib/mail/index.js`（用途 `portal` を追加）

### 企業ポータル（enger-lp：詳しくは enger-lp の `docs/business-portal-sales-accounts.md`）

- `/business/invite`：招待リンクの受け口（パスワード設定 or 既存の法人アカウントで紐づけ）
- `/business/candidates?view=search`：全人材／注力人材／新着人材／保存した人材、絞り込み、詳細モーダル（サマリー初期表示・公開用スキルシート・印刷）、保存（企業内共有）
- `/business/dashboard`：企業名と「保存した人材・注力人材・新着人材」のカード
- ログイン：停止中は拒否。最終ログインと記録
- 既存の画面から希望単価の表示を外した（0.4-2）

### DB（`db/161`。すべて新しい表。既存の表・列・RLS は変えない）

| 表 | 用途 | 権限 |
|---|---|---|
| `enger.dx2_company_portal_members` | 利用者（企業ID・メール＝ログインID・権限・Auth・登録・最終ログイン・停止） | service_role：select/insert/update（削除なし） |
| `enger.dx2_company_portal_invites` | 招待（sha256・期限・使用・取消） | service_role：select/insert/update |
| `enger.dx2_company_talent_links` | 商談準備の紐づけ（企業×人材で1行・4状態・社内メモ） | service_role：select/insert/update |
| `enger.dx2_company_portal_saved_talents` | 企業の保存（利用者×人材で1行。企業IDは利用者の企業と一致しないと DB が拒否） | service_role：select/insert/delete |
| `enger.dx2_company_portal_events` | 記録（追記だけ。更新・削除はトリガで拒否） | service_role：select/insert |

anon / authenticated は全表で権限なし・RLS 有効・ポリシーなし（deny-by-default）。

### 記録する操作（`dx2_company_portal_events.action`）

`member.invite`・`member.reinvite`・`member.disable`・`member.enable`・`member.role`・`member.register`・`member.link`・
`portal.login`・`portal.blocked`・`talent.search`（条件の種類と件数だけ。キーワードの文字は残さない）・`talent.view`・`talent.save`・`talent.unsave`・`prep.link`・`prep.update`。
パスワード・トークン・連絡先は残さない。

## 3. 導入手順（承認後に依頼者が行う）

1. 共有 Supabase の SQL Editor で `db/161_enger_company_portal.sql` を Run（べき等）→ `db/check_161_enger_company_portal.sql` がすべて ✅
2. （任意）MF の Vercel に招待メールの送信元 `ENGER_PORTAL_MAIL_FROM`（例 `ENGER <sales@8grp.co.jp>`。既存の `MAIL_PROVIDER`・`MAIL_SEND_ENABLED=1` が前提）。
   未設定なら招待リンクを画面からコピーして手渡し（パスワードは扱わない）
3. （プレビューで試すときだけ）MF の Preview 環境に `ENGER_PORTAL_BASE_URL`＝enger-lp のプレビューURL（`https://…vercel.app`）。本番は未設定（`https://enger.jp`）
4. MF と enger-lp の PR をマージ（どちらも表が無い間は「db/161 の実行を依頼してください」を出すだけで、既存の画面は壊れない）
5. 確認（実データ）：
   1. Sales の企業一覧 → 企業を開く → 4タブが出る。①企業情報が今までどおり
   2. ②商談準備で人材を2人選んで「提案予定」で保存 → 閉じて開き直しても残る
   3. ③企業ポータルで社外のテスト用メールに発行 → リンクを開いてパスワードを設定 → enger.jp の企業ダッシュボードに企業名とカード
   4. エンジニアを探す：全人材／注力／新着の切替・絞り込み・詳細（サマリー→スキルシート）・保存 → Sales の③に「企業が保存した人材」「利用履歴」
   5. API の応答（ブラウザの開発ツール）に氏名・単価・所属会社・メモが無いこと
   6. ③で停止 → enger.jp でログイン・検索ができない。責任者が再開 → 使える
   7. 社員のメール・別企業で発行済みのメールには発行できない

### 戻すとき

1. MF・enger-lp の PR を戻す（先にアプリ）
2. 必要なら `db/rollback_161_enger_company_portal.sql`（有効な登録済み利用者がいると止まる。停止してから流す）。Auth のアカウントは残る

## 4. テスト

| 検査 | 内容 |
|---|---|
| `test/enger-talent-public.mjs` | 許可リストの鍵だけ・非公開の値（氏名・メール・所属・単価・メモ・原本URL・電話）が出ない・読む列に非公開の列が無い・伏せ字・提示できない状態の除外・絞り込み・並べ替え |
| `test/sales-company-portal.mjs` | 未ログイン 401・権限なし/別テナント 403・範囲外の企業ID 404・社内メール拒否・二重発行拒否・トークンはハッシュだけ／一覧に出ない・再招待で旧リンク取消・別企業IDで他社の利用者を操作できない・停止は理由必須・ban はポータル専用だけ・再開は責任者だけ・提示できない人材は紐づけない・紐づけは企業ごと・進捗は担当範囲・表が無いときの案内 |
| `test/ui/salescompanyportalui.mjs` | 実際の画面：4タブ・既存ワークベンチが①・商談準備の検索/複数選択/保存・人材詳細（サマリー→スキルシート）・発行と招待リンク表示・停止・進捗の Phase 3 表示・企業IDなしでタブ無効・スマホ幅 |
| `test/sql/161_enger_company_portal.sql` | 実際の PostgreSQL 16：前提が無ければ止まる・べき等・確認 SQL・ブラウザ遮断・一意・保存の企業一致・停止中は保存不可・記録は追記だけ・戻す SQL の安全装置・再適用 |

## 5. 残り（Phase 2 以降）

| 項目 | 状態 |
|---|---|
| 企業の案件登録・マッチング（Phase 2） | 未実装。`enger.jobs` に企業IDが無いので、追加の列か受付表で企業IDを持たせる設計から。マッチングは `rankCandidates` を使う |
| オファー受付・ENGER 確認・Sales 引き継ぎ・Slack・成約（Phase 3） | 未実装。共通の `offer_id`・履歴（追記専用）・外部向け状態を設計する。企業ポータル→社内受付→所属・条件確認→人材側、の順 |
| 利用分析（Phase 4） | 記録（events）は Phase 1 から貯まる |
| 企業提示単価・単価での絞り込み | ENGER に「企業へ提示できる単価」の列が無い。決めてから追加 |
| マスキング済みスキルシート（原本ベース）の登録 | 未実装。現在は許可項目から作る要約版だけ |
| dx.enger の `/companies/accounts` に台帳（企業IDつき）を表示 | 未実装（いまは会社名の一致） |
| 自分で登録した法人アカウントの企業IDへの紐づけ | Sales で発行 → 本人がログインして招待リンクを開き「既存のアカウントと紐づける」で可能。一括の移行はしない（名寄せをしない） |
| 0.4 の既存の問題 | 判断待ち |
