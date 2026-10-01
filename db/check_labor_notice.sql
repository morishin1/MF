-- =============================================================================
-- 労働条件通知書（db/110_labor_notices.sql）を本番に反映する前の、前提の確認。読み取り専用。
--
-- ■ 使い方
--   Supabase の SQL Editor に貼って Run。select だけで、何も変えない。
--   結果の「結果」列が NG のものを、先に直す。「任意」は、無くても動く（その分の機能だけ止まる）。
--
-- ■ 番号では判断しない
--   db/ の番号は、系統（main・PR #39）で重なっている（099・100・105 が両方にある）。
--   「056 を流したか」ではなく、「その SQL が作るはずの表・列・関数が、いま実際にあるか」で見る。
--   ファイル名と、実体（表・列・関数・バケット）の対応は、下の「対象」に書いてある。
--
-- ■ 結果の読み方
--   OK   … ある（要る・使う）
--   NG   … 無い。通知書の機能が動かない。先に、対応するファイルを流す
--   任意  … 無いと、その分の機能（電子署名を優先する判定など）だけが止まる。通知書そのものは動く
--   ※ 入社管理（admin-hr.html）と通知書の一連の動きに要る表・列・制約の全体は、db/check_onboarding_ready.sql が見る（こちらは通知書の分だけ）
--   済み  … db/110_labor_notices.sql の分。まだなら「未適用」（これから流す）
--
-- ■ 通知書を見られる人（給与・個人情報を含むため）
--   owner ロール・hr ロールを持つ人だけ。DB の RLS も、API も、同じ条件。
--   gw_is_hr（会計側の管理者 admin / staff も含む）は使わない。管理者・経理・責任者・採用担当・営業・社労士は、見られない。
--   92 と 94 が、いま入っているポリシーが owner・hr だけのものか（前の版のままではないか）を見る。
-- =============================================================================

with
col(tbl, c) as (
  select table_name::text, column_name::text from information_schema.columns where table_schema = 'public'
),
checks(ord, kind, target, file_hint, ok, detail) as (
  values
  -- ---- 必須 ----
  (10, 'NG', 'tenants（表）', '会計の基本（db/schema.sql ほか）',
     to_regclass('public.tenants') is not null, null),
  (11, 'NG', 'gw_employees（表）と user_id・tenant_id・status の列', 'db/005_groupware_core.sql',
     to_regclass('public.gw_employees') is not null
       and (select count(*) from col where tbl = 'gw_employees' and c in ('user_id', 'tenant_id', 'status', 'display_name')) = 4, null),
  (12, 'NG', 'gw_has_role(uuid, text)（関数）と gw_role_grants（表）。owner・hr ロールの判定', 'db/005_groupware_core.sql',
     to_regprocedure('public.gw_has_role(uuid, text)') is not null and to_regclass('public.gw_role_grants') is not null,
     '通知書の RLS は、この関数で owner と hr だけに絞ります（gw_is_hr は、会計側の管理者も含むので使いません）'),
  (13, 'NG', 'gw_activity_log（表）。操作の記録', 'db/005_groupware_core.sql',
     to_regclass('public.gw_activity_log') is not null, null),
  (14, 'NG', 'Storage バケット hr が、非公開で存在する', 'db/012_hr_files.sql',
     exists (select 1 from storage.buckets where id = 'hr' and public = false),
     (select case when public then '公開になっています。非公開に直してください' else null end from storage.buckets where id = 'hr')),
  -- ---- 閲覧の記録（無くても動くが、HR・経営者が他人の通知書を開いた記録が残らない）----
  (20, '任意', 'gw_sensitive_access_log（表）。機密の閲覧記録', 'db/070_onboarding_stage.sql',
     to_regclass('public.gw_sensitive_access_log') is not null, '無いと、他人の通知書を開いた記録（閲覧ログ）が残りません'),
  -- ---- 電子署名を優先する判定（無いと、署名依頼の有無を見られない）----
  (30, '任意', 'gw_sign_requests（表）と employee_id・status・doc_kind の列。電子署名', 'db/046_esign.sql',
     to_regclass('public.gw_sign_requests') is not null
       and (select count(*) from col where tbl = 'gw_sign_requests' and c in ('employee_id', 'status', 'doc_kind')) = 3,
     '無い会社では、電子署名を使っていないので、通知書の確認だけで進みます'),
  (31, '任意', 'gw_sign_requests.source / order_id（列）', 'db/056_doc_orders.sql',
     (select count(*) from col where tbl = 'gw_sign_requests' and c in ('source', 'order_id')) = 2, null),
  (32, '任意', 'gw_sign_requests.contract_id（列）', 'db/097_sign_contract_link.sql',
     exists (select 1 from col where tbl = 'gw_sign_requests' and c = 'contract_id'), null),
  (33, '任意', 'gw_doc_orders（表）。社労士への作成依頼', 'db/056_doc_orders.sql',
     to_regclass('public.gw_doc_orders') is not null, null),
  (34, '任意', 'gw_doc_orders.approved_by / advisor_note / conditions_edited_at（列）', 'db/071_onboarding_stage2.sql',
     (select count(*) from col where tbl = 'gw_doc_orders' and c in ('approved_by', 'advisor_note', 'conditions_edited_at')) = 3, null),
  (35, '任意', 'gw_doc_orders.override_reason / override_by / override_at（列）', 'db/087_hr_offer_contract_check.sql',
     (select count(*) from col where tbl = 'gw_doc_orders' and c in ('override_reason', 'override_by', 'override_at')) = 3, null),
  -- ---- 入社手続き（本人の /onboarding/ に通知書を出すのに、要る）----
  -- 手続きの行が無い人は、本人の画面で「入社手続きの無い人」として扱われ、通知書のカードが出ない（api/onboarding/start.js の hasProcedure）
  (40, 'NG', 'gw_procedures（表）と employee_id・kind・status・target_on の列。入社手続き', 'db/008_onboarding.sql',
     to_regclass('public.gw_procedures') is not null
       and (select count(*) from col where tbl = 'gw_procedures' and c in ('employee_id', 'kind', 'status', 'target_on')) = 4,
     '無いと、本人の /onboarding/ に通知書が出ません。入社管理（admin-hr.html）に要る表・列は、db/check_onboarding_ready.sql で全体を確かめてください'),
  (42, '任意', 'gw_procedures.stage・stage_at（列）。段階の写し', 'db/070_onboarding_stage.sql',
     (select count(*) from col where tbl = 'gw_procedures' and c in ('stage', 'stage_at')) = 2,
     '無くても、通知書は動きます。段階が進んだときの、次の担当者への知らせだけが止まります（画面の段階は、事実から計算するので正しく出ます）'),
  (41, '任意', 'gw_onboarding_guides（表）。入社案内（/onboarding/ の STEP1）', 'db/104_onboarding_guide.sql（PR #39 の系統）',
     to_regclass('public.gw_onboarding_guides') is not null, '無くても、通知書は動きます（STEP1 だけ「データ未連携」）'),
  -- ---- この SQL の分 ----
  (90, '済み', 'gw_labor_notices（表）', 'db/110_labor_notices.sql',
     to_regclass('public.gw_labor_notices') is not null, case when to_regclass('public.gw_labor_notices') is null then '未適用（これから流す）' end),
  (91, '済み', 'gw_labor_notices の RLS が有効', 'db/110_labor_notices.sql',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.gw_labor_notices')), false), null),
  (92, '済み', 'gw_labor_notices の読み取りポリシー（gw_labor_notices_read）。owner・hr ロールだけ', 'db/110_labor_notices.sql',
     exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_labor_notices' and policyname = 'gw_labor_notices_read'
               and qual ~ 'gw_has_role' and qual ~ 'owner' and qual ~ 'hr'
               and qual !~ 'gw_is_hr' and qual !~ 'is_tenant_staff'),
     case when to_regclass('public.gw_labor_notices') is null then '未適用（これから流す）' end),
  -- 前の版（gw_is_hr で読める）を流していたら、管理者も読めてしまう。その場合は NG（db/110 をもう一度流す）
  (94, 'NG', 'gw_labor_notices の読み取りポリシーが、管理者（admin / staff）も読める古い定義ではない', 'db/110_labor_notices.sql',
     not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_labor_notices' and policyname = 'gw_labor_notices_read'
                   and (qual ~ 'gw_is_hr' or qual ~ 'is_tenant_staff')),
     '古い定義です（管理者も読めます）。db/110_labor_notices.sql をもう一度流してください。owner・hr だけに置き換わります（べき等）'),
  (93, '済み', 'gw_labor_notices の更新ガード（トリガ）', 'db/110_labor_notices.sql',
     exists (select 1 from pg_trigger where tgrelid = to_regclass('public.gw_labor_notices') and tgname = 'gw_labor_notices_guard_trg' and not tgisinternal), null)
)
select
  case when ok then 'OK'
       when kind = 'NG' then 'NG'
       when kind = '任意' then '任意（無い）'
       else '未適用' end                      as "結果",
  target                                       as "確認する対象",
  file_hint                                    as "作るファイル（番号でなく、ファイル名と実体で見る）",
  detail                                       as "補足"
from checks
order by ord;
