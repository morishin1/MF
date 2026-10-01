-- =============================================================================
-- /office Phase 3（勤務表 → 稼働時間の確定）の、適用前・適用後のチェック
--   099・100 は本番適用済み。これから流すのは 105・106・107 の3本
--
-- Supabase の SQL Editor に貼って Run するだけ。**何も書き換えない（読むだけ）**。
-- 適用の前に1回、適用の途中（1本流すごと）に1回、適用のあとに1回、流してください。
--
-- 見るもの
--   A. 前提（105〜107 を流すのに要るもの。099・100 を含む）… ❌ があれば、そこが先。流すと途中で止まる
--   B. 105〜107 の状態                     … 未適用／適用済み／⚠ 半分だけ（もう一度流す）
--   C. 権限の安全確認                       … 新しい表は「読み取りだけ・Office 権限」になっているか
--   D. 既存データへの影響                   … 件数の目安（適用の前後で、同じであるべき数字）
--
-- 適用の順番：（099 → 100 は適用済み）→ 105 → 106 → 107 → アプリのデプロイ
--   （どのファイルも if not exists / create or replace で書いてあり、2回流しても壊れません）
--
-- 読み方
--   「状態」が ✅ なら問題なし。❌ は、その行の「やること」をしてください。
--   ℹ は情報です（数字を控えておくと、適用のあとに見比べられます）。
-- =============================================================================

with
-- ---- A. 前提 ------------------------------------------------------------------
pre(seq, area, title, ok, marker, todo) as (
  values
  ( 1, 'A. 前提', '会計の土台（tenants）',
      to_regclass('public.tenants') is not null, 'tenants', 'db/schema.sql（会計の土台）を先に流す'),
  ( 2, 'A. 前提', '社員名簿（gw_employees）',
      to_regclass('public.gw_employees') is not null, 'gw_employees', 'db/005_groupware_core.sql を先に流す'),
  ( 3, 'A. 前提', '社内権限（gw_role_grants）',
      to_regclass('public.gw_role_grants') is not null, 'gw_role_grants', 'db/005_groupware_core.sql を先に流す'),
  ( 4, 'A. 前提', '社内権限に「経理（finance）」「責任者（manager）」が許可されている',
      exists (select 1 from pg_constraint c
               where c.conrelid = to_regclass('public.gw_role_grants') and c.contype = 'c'
                 and pg_get_constraintdef(c.oid) like '%finance%' and pg_get_constraintdef(c.oid) like '%manager%'),
      'gw_role_grants.role の CHECK', 'db/088_sales.sql・db/094_recruit_sales_roles.sql を先に流す'),
  ( 5, 'A. 前提', '権限の関数 gw_has_role(uuid, text)',
      to_regprocedure('public.gw_has_role(uuid, text)') is not null, 'gw_has_role', 'db/005_groupware_core.sql を先に流す'),
  ( 6, 'A. 前提', '会計側の判定 is_tenant_staff(uuid)（既存4表の RLS が使う）',
      to_regprocedure('public.is_tenant_staff(uuid)') is not null, 'is_tenant_staff', 'db/schema.sql（会計の土台）を先に流す'),
  ( 7, 'A. 前提', 'BP会社（gw_partner_companies）',
      to_regclass('public.gw_partner_companies') is not null, 'gw_partner_companies', 'db/075_partner_bp.sql を先に流す'),
  ( 8, 'A. 前提', '現場契約（gw_site_contracts）',
      to_regclass('public.gw_site_contracts') is not null, 'gw_site_contracts', 'db/076_site_contracts.sql を先に流す'),
  ( 9, 'A. 前提', '月次請求の進捗（gw_billing_progress）',
      to_regclass('public.gw_billing_progress') is not null, 'gw_billing_progress', 'db/077_billing_progress.sql を先に流す'),
  (10, 'A. 前提', '月次請求の進捗に、5つの印の列がそろっている',
      (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'gw_billing_progress'
          and column_name in ('timesheet_received', 'work_confirmed', 'board_created', 'sent', 'bp_invoice_received')) = 5,
      'gw_billing_progress の5つの印', 'db/077_billing_progress.sql をもう一度流す'),
  (11, 'A. 前提', '提出ファイル（gw_submissions）',
      to_regclass('public.gw_submissions') is not null, 'gw_submissions', 'db/080_billing_submission.sql を先に流す'),
  (12, 'A. 前提', '外部提出フォームの窓口（gw_submission_links）',
      to_regclass('public.gw_submission_links') is not null, 'gw_submission_links', 'db/080_billing_submission.sql を先に流す'),
  (13, 'A. 前提', '提出ファイルの保存先（バケット billing-submissions）',
      exists (select 1 from storage.buckets where id = 'billing-submissions'), 'billing-submissions', 'db/080_billing_submission.sql を先に流す'),
  (14, 'A. 前提', 'ユーザー（auth.users）',
      to_regclass('auth.users') is not null, 'auth.users', 'Supabase Auth が有効か確認する'),
  (15, 'A. 前提', 'gen_random_uuid()（主キーの既定値）',
      to_regprocedure('gen_random_uuid()') is not null, 'gen_random_uuid', 'PostgreSQL 13 以上、または pgcrypto を有効にする'),
  (16, 'A. 前提', '099：Office 権限の関数 gw_is_office(uuid)（経営者・責任者・経理）',
      coalesce(pg_get_functiondef(to_regprocedure('public.gw_is_office(uuid)')) like '%owner%'
           and pg_get_functiondef(to_regprocedure('public.gw_is_office(uuid)')) like '%manager%'
           and pg_get_functiondef(to_regprocedure('public.gw_is_office(uuid)')) like '%finance%'
           and pg_get_functiondef(to_regprocedure('public.gw_is_office(uuid)')) not like '%is_tenant_staff%'
           and pg_get_functiondef(to_regprocedure('public.gw_is_office(uuid)')) not like '%gw_is_hr%', false),
      'gw_is_office', 'db/099_access_hr_office.sql を流す（105〜107 の RLS が、この関数を使います）'),
  (17, 'A. 前提', '100：経営の判定 gw_is_keiei(uuid)（経営者だけ）',
      to_regprocedure('public.gw_is_keiei(uuid)') is not null, 'gw_is_keiei', 'db/100_office_access.sql を流す'),
  (18, 'A. 前提', '100：既存4表に、Office 権限の読み取りポリシーがある',
      (select count(*) from pg_policies
        where schemaname = 'public'
          and policyname in ('gw_site_contracts_office_select', 'gw_billing_progress_office_select',
                             'gw_submissions_office_select', 'gw_partner_companies_office_select')) = 4,
      '*_office_select ×4', 'db/100_office_access.sql を流す（無いと、経理・責任者の /office 一覧が空になります）')
),

-- ---- B. 105〜107 の状態 -----------------------------------------------------------
parts(mig, kind, obj, col) as (
  values
  ('105', 'table',  'gw_office_events',       null),
  ('105', 'policy', 'gw_office_events',       'gw_office_events_office_select'),
  ('105', 'column', 'gw_submissions',         'sha256'),
  ('105', 'column', 'gw_submissions',         'verified_at'),
  ('105', 'column', 'gw_submissions',         'uploaded_by'),
  ('105', 'column', 'gw_submissions',         'source'),
  ('105', 'index',  'idx_gw_submissions_sha256', null),
  ('106', 'table',  'gw_site_contract_terms', null),
  ('106', 'policy', 'gw_site_contract_terms', 'gw_site_contract_terms_office_select'),
  ('106', 'column', 'gw_site_contract_terms', 'sales_unit_price'),
  ('106', 'column', 'gw_site_contract_terms', 'purchase_unit_price'),
  ('107', 'table',  'gw_timesheets',          null),
  ('107', 'table',  'gw_timesheet_days',      null),
  ('107', 'policy', 'gw_timesheets',          'gw_timesheets_office_select'),
  ('107', 'policy', 'gw_timesheet_days',      'gw_timesheet_days_office_select'),
  ('107', 'column', 'gw_timesheets',          'read_warnings'),
  ('107', 'column', 'gw_timesheets',          'sheet_employee_name'),
  ('107', 'column', 'gw_timesheets',          'review_seconds'),
  ('107', 'column', 'gw_timesheet_days',      'ai_flags')
),
part_state as (
  select p.mig, p.kind, p.obj, p.col,
         case p.kind
           when 'table'  then to_regclass('public.' || p.obj) is not null
           when 'index'  then to_regclass('public.' || p.obj) is not null
           when 'column' then exists (select 1 from information_schema.columns
                                       where table_schema = 'public' and table_name = p.obj and column_name = p.col)
           when 'policy' then exists (select 1 from pg_policies
                                       where schemaname = 'public' and tablename = p.obj and policyname = p.col)
         end as ok
    from parts p
),
mig_state as (
  select mig,
         bool_and(ok)  as all_ok,
         bool_or(ok)   as any_ok,
         string_agg(case when not ok then obj || coalesce('.' || col, '') end, ' ／ ') as lacking
    from part_state
   group by mig
),
b(seq, area, title, ok, marker, todo) as (
  select 100 + row_number() over (order by mig)::int, 'B. 適用状態',
         case mig
           when '105' then '105：操作履歴（gw_office_events）・提出ファイルの確認列（sha256 など）'
           when '106' then '106：契約条件（gw_site_contract_terms）'
           when '107' then '107：勤務表・日別データ（gw_timesheets / gw_timesheet_days）'
         end,
         all_ok,
         case when all_ok then '全部そろっている'
              when any_ok then '⚠ 半分だけ入っている。欠け：' || lacking
              else '未適用' end,
         case when all_ok then ''
              when any_ok then 'db/' || mig || '_*.sql をもう一度流す（べき等。表があって列だけ欠けているときは、create table の列を alter table で足す）'
              else 'A の前提が ✅ になってから、db/' || mig || '_*.sql を流す' end
    from mig_state
),

-- ---- C. 権限の安全確認（105〜107 を流したあとに意味がある）----------------------------
new_tables(t) as (values ('gw_office_events'), ('gw_site_contract_terms'), ('gw_timesheets'), ('gw_timesheet_days')),
c(seq, area, title, ok, marker, todo) as (
  select 200, 'C. 権限', '新しい4表は RLS が有効',
         (select count(*) from new_tables n join pg_class k on k.oid = to_regclass('public.' || n.t) where k.relrowsecurity) = 4,
         (select count(*) from new_tables n join pg_class k on k.oid = to_regclass('public.' || n.t) where k.relrowsecurity)::text || ' / 4 表',
         '105〜107 を流す（流し済みなら、db/ の該当ファイルをもう一度流す）'
  union all
  select 201, 'C. 権限', '新しい4表のポリシーは、読み取り（SELECT）だけ。書き込みのポリシーは無い',
         (select count(*) from pg_policies where schemaname = 'public' and tablename in (select t from new_tables)) = 4
           and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in (select t from new_tables) and cmd <> 'SELECT'),
         (select count(*) from pg_policies where schemaname = 'public' and tablename in (select t from new_tables))::text || ' 件',
         '書き込みのポリシーが足されていたら、消す（書き込みは API だけが行う）'
  union all
  select 202, 'C. 権限', '新しい4表のポリシーは、Office 権限（gw_is_office）だけで読める',
         (select count(*) from pg_policies where schemaname = 'public' and tablename in (select t from new_tables) and qual like '%gw_is_office%') = 4
           and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in (select t from new_tables)
                              and (qual like '%is_tenant_staff%' or qual like '%gw_is_hr%' or qual like '%gw_is_sales%' or qual like '%gw_is_recruiting%')),
         (select count(*) from pg_policies where schemaname = 'public' and tablename in (select t from new_tables) and qual like '%gw_is_office%')::text || ' / 4 件',
         '該当のファイルをもう一度流す（人事・営業・会計の管理者には、単価・勤務時間を見せない）'
  union all
  select 203, 'C. 権限', '既存4表の既存ポリシー（is_tenant_staff）は、そのまま（方針A）',
         (select count(*) from pg_policies where schemaname = 'public'
            and policyname in ('gw_site_contracts_staff', 'gw_billing_progress_staff', 'gw_submissions_staff', 'gw_submission_links_staff')) = 4,
         (select count(*) from pg_policies where schemaname = 'public'
            and policyname in ('gw_site_contracts_staff', 'gw_billing_progress_staff', 'gw_submissions_staff', 'gw_submission_links_staff'))::text || ' / 4 件',
         '既存のポリシーが消えている。db/076・077・080 を流し直す'
  union all
  select 204, 'C. 権限', '既存の gw_site_contracts.unit_price / settlement_condition は、そのまま（Phase 3 は触らない）',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'gw_site_contracts' and column_name in ('unit_price', 'settlement_condition')) = 2,
         'unit_price・settlement_condition', 'db/076_site_contracts.sql を確認する'
),

-- ---- D. 既存データへの影響（適用の前後で、同じであるべき数字）--------------------------
-- 件数は、表が無いときに落ちないよう、実行時に組み立てる（query_to_xml）。表・列が無ければ「（表なし）」
d(seq, area, title, ok, marker, todo) as (
  select 300, 'D. 既存データ', '現場契約の件数', true,
         case when to_regclass('public.gw_site_contracts') is null then '（表なし）'
              else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.gw_site_contracts', false, true, '')))[1]::text || ' 件' end,
         'ℹ 適用の前後で同じ数になる'
  union all
  select 301, 'D. 既存データ', '月次請求の進捗の件数（Phase 3 は、この表の行も列も変えない）', true,
         case when to_regclass('public.gw_billing_progress') is null then '（表なし）'
              else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.gw_billing_progress', false, true, '')))[1]::text || ' 件' end,
         'ℹ 適用の前後で同じ数になる'
  union all
  select 302, 'D. 既存データ', '届いている提出ファイルの件数', true,
         case when to_regclass('public.gw_submissions') is null then '（表なし）'
              else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.gw_submissions', false, true, '')))[1]::text || ' 件' end,
         'ℹ 適用の前後で同じ数になる'
  union all
  select 303, 'D. 既存データ', '提出ファイルのうち、sha256 が空（未確認）の件数（105 のあと、既存の行はすべて空）', true,
         case when to_regclass('public.gw_submissions') is null then '（表なし）'
              when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gw_submissions' and column_name = 'sha256')
                then '（105 の前）'
              else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.gw_submissions where sha256 is null', false, true, '')))[1]::text || ' 件' end,
         'ℹ 画面を開く・AI読取のときに、中身を確かめて埋まっていく'
  union all
  select 304, 'D. 既存データ', 'Office を使える人（経営者・責任者・経理）の人数', true,
         case when to_regclass('public.gw_role_grants') is null then '（表なし）'
              else (xpath('/row/n/text()', query_to_xml('select count(distinct employee_id) as n from public.gw_role_grants where role in (''owner'', ''manager'', ''finance'')', false, true, '')))[1]::text || ' 人' end,
         'ℹ 0 人なら、誰も /office を開けない（メンバー管理で権限を付ける）'
)

select area                                                   as "区分",
       title                                                  as "内容",
       case when marker like 'ℹ%' or todo like 'ℹ%' then 'ℹ 情報'
            when ok then '✅ 問題なし' else '❌ 要対応' end        as "状態",
       marker                                                 as "目印・数字",
       case when ok then '' when todo like 'ℹ%' then '' else todo end as "やること"
  from (
    select seq, area, title, ok, marker, todo from pre
    union all select seq, area, title, ok, marker, todo from b
    union all select seq, area, title, ok, marker, todo from c
    union all select seq, area, title, ok, marker, todo from d
  ) all_checks
 order by seq;
