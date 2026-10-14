-- =============================================================================
-- Office を本番でメンバーが使えるか、1回で確かめる（読むだけ・何も書き換えない）
--
-- Supabase の SQL Editor に、このファイル全体を貼って Run。結果は1つの表で出る。
--   「状態」が ✅ なら問題なし。❌ は「やること」の列のとおりにする（上の行から順に）。ℹ は情報。
--
-- 見るもの
--   A. 前提           … Office の表・権限の関数（099・100）と、提出ファイルの保存先
--   B. Office の SQL  … 105・106・107（勤務表）／115（人事・労務と経理・事務の分割）／117（仕入請求・支払・月次完了）
--                        ／119（アプリ利用権限＝メンバー一覧の4ボタン）が入っているか。⚠ は「半分だけ入っている」
--   C. 使える人       … Office の業務ごとに、使える人が何人いるか（0 人の業務は、誰も使えない）
--
-- 適用の順番（未適用のものだけ）：099 → 100 → 105 → 106 → 107 → 115 → 117 → 119
--   どのファイルも begin … commit で、2回流しても壊れない（if not exists / create or replace）。
--   119 は、流す前に db/check_app_grants_dryrun.sql（0 行）、流したあとに db/check_app_grants_after.sql（0 行）。
--   アプリは、表が無い間は案内（503「SQL を流してください」）を出すだけで、ほかの画面は止まらない。
--   SQL を流したあとの再デプロイは要らない（アプリは毎回、表があるかを見る）。
--
-- 画面（api/office/*）が使う表・関数と、この確認の項目は test/officeready.mjs が突き合わせる。
-- =============================================================================

with
-- ---- A. 前提 ------------------------------------------------------------------
a(seq, area, title, ok, marker, todo) as (
  values
  ( 1, 'A. 前提', '社員名簿（gw_employees）・社内権限（gw_role_grants）',
      to_regclass('public.gw_employees') is not null and to_regclass('public.gw_role_grants') is not null,
      'gw_employees / gw_role_grants', 'db/005_groupware_core.sql を流す'),
  ( 2, 'A. 前提', '現場契約・月次請求の進捗・提出ファイル（076・077・080）',
      to_regclass('public.gw_site_contracts') is not null and to_regclass('public.gw_billing_progress') is not null
        and to_regclass('public.gw_submissions') is not null and to_regclass('public.gw_submission_links') is not null,
      'gw_site_contracts / gw_billing_progress / gw_submissions / gw_submission_links', 'db/076・077・080 を流す'),
  ( 3, 'A. 前提', '提出ファイルの保存先（バケット billing-submissions）',
      to_regclass('storage.buckets') is not null
        and (xpath('/row/n/text()', query_to_xml(
              'select count(*) as n from storage.buckets where id = ''billing-submissions''', false, true, '')))[1]::text::int > 0,
      'billing-submissions', 'db/080_billing_submission.sql を流す'),
  ( 4, 'A. 前提', '099：Office 権限の関数 gw_is_office(uuid)（経営者・責任者・経理）',
      to_regprocedure('public.gw_is_office(uuid)') is not null,
      'gw_is_office', 'db/099_access_hr_office.sql を流す'),
  ( 5, 'A. 前提', '100：既存4表に、Office 権限の読み取りポリシーがある',
      (select count(*) from pg_policies
        where schemaname = 'public'
          and policyname in ('gw_site_contracts_office_select', 'gw_billing_progress_office_select',
                             'gw_submissions_office_select', 'gw_partner_companies_office_select')) = 4,
      '*_office_select ×4', 'db/100_office_access.sql を流す（無いと、経理・責任者の /office 一覧が空になる）')
),

-- ---- B. Office の SQL --------------------------------------------------------
parts(mig, kind, obj, col) as (
  values
  ('105', 'table',    'gw_office_events',           null),
  ('105', 'policy',   'gw_office_events',           'gw_office_events_office_select'),
  ('105', 'column',   'gw_submissions',             'sha256'),
  ('105', 'column',   'gw_submissions',             'verified_at'),
  ('105', 'column',   'gw_submissions',             'uploaded_by'),
  ('105', 'column',   'gw_submissions',             'source'),
  ('106', 'table',    'gw_site_contract_terms',     null),
  ('106', 'policy',   'gw_site_contract_terms',     'gw_site_contract_terms_office_select'),
  ('107', 'table',    'gw_timesheets',              null),
  ('107', 'table',    'gw_timesheet_days',          null),
  ('107', 'policy',   'gw_timesheets',              'gw_timesheets_office_select'),
  ('107', 'policy',   'gw_timesheet_days',          'gw_timesheet_days_office_select'),
  ('115', 'function', 'gw_is_office_finance(uuid)', null),
  ('115', 'function', 'gw_request_can_review(uuid)', null),
  ('115', 'policy',   'gw_billing_progress',        'gw_billing_progress_finance'),
  ('115', 'policy',   'gw_submission_links',        'gw_submission_links_finance'),
  ('115', 'policy',   'gw_library',                 'gw_library_write'),
  ('115', 'policy',   'gw_doc_templates',           'gw_doc_templates_write'),
  ('117', 'table',    'gw_vendor_invoices',         null),
  ('117', 'table',    'gw_vendor_invoice_lines',    null),
  ('117', 'table',    'gw_office_payments',         null),
  ('117', 'table',    'gw_office_month_closes',     null),
  ('117', 'policy',   'gw_vendor_invoices',         'gw_vendor_invoices_office_select'),
  ('117', 'policy',   'gw_vendor_invoice_lines',    'gw_vendor_invoice_lines_office_select'),
  ('117', 'policy',   'gw_office_payments',         'gw_office_payments_office_select'),
  ('117', 'policy',   'gw_office_month_closes',     'gw_office_month_closes_office_select'),
  ('117', 'index',    'uq_gw_vendor_invoice_lines_active', null),
  ('117', 'index',    'uq_gw_office_payments_active',      null),
  ('117', 'index',    'uq_gw_office_month_closes_active',  null),
  ('119', 'table',    'gw_app_grants',              null),
  ('119', 'function', 'gw_has_app(uuid,text)',      null),
  ('119', 'policy',   'gw_app_grants',              'gw_app_grants_select'),
  ('119', 'policy',   'gw_app_grants',              'gw_app_grants_hr_write')
),
part_state as (
  select p.mig, p.obj, p.col,
         case p.kind
           when 'table'    then to_regclass('public.' || p.obj) is not null
           when 'index'    then to_regclass('public.' || p.obj) is not null
           when 'function' then to_regprocedure('public.' || p.obj) is not null
           when 'column'   then exists (select 1 from information_schema.columns
                                         where table_schema = 'public' and table_name = p.obj and column_name = p.col)
           when 'policy'   then exists (select 1 from pg_policies
                                         where schemaname = 'public' and tablename = p.obj and policyname = p.col)
         end as ok
    from parts p
),
mig_state as (
  select mig, bool_and(ok) as all_ok, bool_or(ok) as any_ok,
         string_agg(case when not ok then obj || coalesce('.' || col, '') end, ' ／ ') as lacking
    from part_state
   group by mig
),
b(seq, area, title, ok, marker, todo) as (
  select 100 + row_number() over (order by mig)::int, 'B. Office の SQL',
         case mig
           when '105' then '105：操作履歴（gw_office_events）・提出ファイルの確認列'
           when '106' then '106：契約条件（単価・精算幅）'
           when '107' then '107：勤務表・日別の稼働'
           when '115' then '115：人事・労務／経理・事務の分割（経費・月次・社内文書を経理へ）'
           when '117' then '117：仕入請求（BP請求書）・支払・月次完了'
           when '119' then '119：アプリ利用権限（メンバー一覧の 採用HR／Sales／Office／経営 ボタン）'
         end,
         all_ok,
         case when all_ok then '全部そろっている'
              when any_ok then '⚠ 半分だけ。欠け：' || lacking
              else '未適用' end,
         case when all_ok then ''
              when mig = '119' then '先に db/check_app_grants_dryrun.sql（0 行）→ db/119_app_grants.sql → db/check_app_grants_after.sql（0 行）'
              when mig = '105' then 'db/105_office_timesheet_base.sql を流す（A がすべて ✅ になってから）'
              when mig = '106' then 'db/106_office_contract_terms.sql を流す'
              when mig = '107' then 'db/107_office_timesheets.sql を流す'
              when mig = '115' then 'db/115_office_split.sql を流す'
              when mig = '117' then 'db/117_office_payables.sql を流す（105〜107 のあと）'
         end
    from mig_state
),

-- ---- C. 使える人（在籍中＝active・leaving の社員）------------------------------------------------------
-- 内部ロールで数える（lib/gw.js と同じ並び）。119 のあとは、Office の入口（app_key = 'office'）も要る（経営者は不要）
staff as (
  select e.id, coalesce(array_agg(distinct r.role) filter (where r.role is not null), '{}') as roles
    from public.gw_employees e
    left join public.gw_role_grants r on r.employee_id = e.id
   where e.status in ('active', 'leaving')
   group by e.id
),
c(seq, area, title, ok, marker, todo) as (
  select 300, 'C. 使える人', '経営者（owner）… Office のすべて', true,
         (select count(*) from staff where 'owner' = any(roles))::text || ' 人', 'ℹ'
  union all
  select 301, 'C. 使える人', '月末月初（/office/ の月次業務・請求・支払）… 経営者・責任者・経理',
         (select count(*) from staff where roles && array['owner', 'manager', 'finance']) > 0,
         (select count(*) from staff where roles && array['owner', 'manager', 'finance'])::text || ' 人',
         'メンバー管理で、担当に「責任者」か「経理」を付ける'
  union all
  select 302, 'C. 使える人', '人事・労務（メンバー・入退社・勤怠・雇用契約・評価）… 経営者・人事（＋会計の管理者）', true,
         (select count(*) from staff where roles && array['owner', 'hr'])::text || ' 人', 'ℹ'
  union all
  select 303, 'C. 使える人', '経理・事務（経費精算・月次業務・社内文書）… 経営者・経理（＋会計の管理者）', true,
         (select count(*) from staff where roles && array['owner', 'finance'])::text || ' 人', 'ℹ'
  union all
  select 304, 'C. 使える人', '119 のあと：Office の入口（office）を持つ人（経営者は数えない）', true,
         case when to_regclass('public.gw_app_grants') is null then '（119 の前。入口は内部ロールから決まる）'
              else (xpath('/row/n/text()', query_to_xml(
                     'select count(distinct employee_id) as n from public.gw_app_grants where app_key = ''office''', false, true, '')))[1]::text || ' 人' end,
         'ℹ 責任者・人事・経理は、移行で自動的に付く（db/119）'
)

select area                                                  as "区分",
       title                                                 as "内容",
       case when todo like 'ℹ%' then 'ℹ 情報'
            when ok then '✅ 問題なし' else '❌ 要対応' end        as "状態",
       marker                                                as "目印・数字",
       case when ok or todo like 'ℹ%' then '' else todo end   as "やること"
  from (
    select * from a
    union all select * from b
    union all select * from c
  ) all_checks
 order by seq;
