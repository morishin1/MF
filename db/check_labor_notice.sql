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
--   済み  … db/110_labor_notices.sql の分。まだなら「未適用」（これから流す）
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
  (12, 'NG', 'gw_is_hr(uuid)（関数）。人事として扱う人', 'db/005_groupware_core.sql・db/041_admin_is_hr.sql',
     to_regprocedure('public.gw_is_hr(uuid)') is not null,
     (select case when pg_get_functiondef(to_regprocedure('public.gw_is_hr(uuid)')) ~ 'is_tenant_staff'
                  then '管理者（会計側 admin/staff）も人事として扱う定義です（db/041 の内容）'
                  else '管理者は人事として扱われない定義です（人事・経営者ロールだけ）' end
        where to_regprocedure('public.gw_is_hr(uuid)') is not null)),
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
  -- ---- 入社手続き・本人の画面 ----
  (40, '任意', 'gw_procedures（表）と kind・stage・target_on の列。入社手続き', 'db/008_onboarding.sql・db/070_onboarding_stage.sql',
     to_regclass('public.gw_procedures') is not null
       and (select count(*) from col where tbl = 'gw_procedures' and c in ('kind', 'stage', 'target_on')) = 3,
     '無いと、入社手続きの段階（STEP2 の完了判定）が動きません'),
  (41, '任意', 'gw_onboarding_guides（表）。入社案内（/onboarding/ の STEP1）', 'db/104_onboarding_guide.sql（PR #39 の系統）',
     to_regclass('public.gw_onboarding_guides') is not null, '無くても、通知書は動きます（STEP1 だけ「データ未連携」）'),
  -- ---- この SQL の分 ----
  (90, '済み', 'gw_labor_notices（表）', 'db/110_labor_notices.sql',
     to_regclass('public.gw_labor_notices') is not null, case when to_regclass('public.gw_labor_notices') is null then '未適用（これから流す）' end),
  (91, '済み', 'gw_labor_notices の RLS が有効', 'db/110_labor_notices.sql',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.gw_labor_notices')), false), null),
  (92, '済み', 'gw_labor_notices の読み取りポリシー（gw_labor_notices_read）', 'db/110_labor_notices.sql',
     exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_labor_notices' and policyname = 'gw_labor_notices_read'), null),
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
