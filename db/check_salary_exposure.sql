-- =============================================================================
-- 給与の露出と、権限まわりのマイグレーションの適用状況を見る（読み取りだけ）
--
-- Supabase の SQL Editor に貼って Run するだけ。何も書き換えない。
-- 結果は「区分 / 項目 / 状態 / 詳細」の一覧。「❌」「⚠」の行を、上から順に見る。
--
-- ■ いつ使うか
--   ・db/099（owner 専用）・db/100（給与の分離）・db/101（元の列を空にする）を流す前と後
--   ・035・041・094 が本番に当たっているか（これに依存する変更をする前に必ず確かめる）
--   ・「誰が給与を読めるか」を、DB の設定と件数で確かめたいとき
--
-- ■ 見方
--   ✅ … 期待どおり   ❌ … 未適用または漏れている   ⚠ … 確認が要る   ℹ … 参考（人数・件数）
--   表がまだ無い環境でも、エラーにならず「表なし」と出る。
-- =============================================================================

with
-- 関数の定義文（無ければ null）
fn as (
  select 'gw_is_hr'         as name, pg_get_functiondef(to_regprocedure('public.gw_is_hr(uuid)'))         as def
  union all select 'gw_is_recruiting', pg_get_functiondef(to_regprocedure('public.gw_is_recruiting(uuid)'))
  union all select 'gw_is_sales',      pg_get_functiondef(to_regprocedure('public.gw_is_sales(uuid)'))
  union all select 'gw_is_owner',      pg_get_functiondef(to_regprocedure('public.gw_is_owner(uuid)'))
  union all select 'gw_can_see_salary', pg_get_functiondef(to_regprocedure('public.gw_can_see_salary(uuid)'))
),
pol as (
  select c.relname as tbl, p.polname, p.polcmd,
         pg_get_expr(p.polqual, p.polrelid) as using_expr,
         pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
),
def_of as (select name, def from fn),

-- ---- A. 適用状況 -------------------------------------------------------------
applied(seq, item, ok, detail) as (
  select 1, '035 給与を含む契約を、人事と本人だけに（gw_contracts の RLS）',
         case when to_regclass('public.gw_contracts') is null then null
              else exists (select 1 from pol where tbl = 'gw_contracts' and polname = 'gw_contracts_select'
                              and (using_expr ilike '%gw_is_hr%' or using_expr ilike '%gw_can_see_salary%')) end,
         coalesce((select 'いまの条件: ' || using_expr || case when using_expr ilike '%gw_can_see_salary%' then '（102 で、さらに絞ってある）' else '' end
                     from pol where tbl = 'gw_contracts' and polname = 'gw_contracts_select'),
                  'gw_contracts なし')
  union all
  select 2, '041 管理者を人事と同じ扱いに（gw_is_hr が is_tenant_staff を含む）',
         (select def ilike '%is_tenant_staff%' from def_of where name = 'gw_is_hr'),
         '含まないと、会計の管理者は DB 側では人事として扱われない（API 側は扱う）'
  union all
  select 3, '094 採用HR・Sales を社内権限だけで決める（gw_is_recruiting / gw_is_sales）',
         (select d.def is not null and d.def ilike '%recruiter%' and d.def not ilike '%is_tenant_staff%' from def_of d where d.name = 'gw_is_recruiting')
           and (select d.def is not null and d.def not ilike '%is_tenant_staff%' from def_of d where d.name = 'gw_is_sales'),
         '採用担当が読めるのは採用HRの表だけ。会計の管理者は含まない'
  union all
  select 4, '099 owner 専用（gw_is_owner・トリガ・gw_role_grants の RLS）',
         exists (select 1 from def_of where name = 'gw_is_owner' and def is not null)
           and exists (select 1 from pol where tbl = 'gw_role_grants' and polname = 'gw_role_grants_hr_write' and using_expr ilike '%gw_is_owner%')
           and (select count(*) from pg_trigger where tgname in ('gw_role_grants_guard_trg','gw_role_grants_owner_audit_trg','gw_employees_owner_guard_trg')) = 3,
         '管理者・人事が owner を付けられない／最後の owner を消せない'
  union all
  select 5, '100 応募者・合格通知の給与を専用の表へ（gw_hr_pay）',
         to_regclass('public.gw_hr_pay') is not null and exists (select 1 from def_of where name = 'gw_can_see_salary' and def is not null),
         '流しただけでは動きは変わらない。アプリの環境変数 HR_PAY_SPLIT=1 で切り替わる'
  union all
  select 6, '101 元の列の給与を空にして、書けなくする',
         exists (select 1 from pg_constraint where conname in ('gw_hr_applicants_wage_moved','gw_hr_offers_wage_moved')),
         'ここで初めて、採用担当が DB から給与を読めなくなる'
  union all
  select 7, '102 契約（gw_contracts）の賃金を、給与を見られる人と本人だけに',
         case when to_regclass('public.gw_contracts') is null then null
              else exists (select 1 from pol where tbl = 'gw_contracts' and polname = 'gw_contracts_select'
                              and using_expr ilike '%gw_can_see_salary%') end,
         '責任者が、契約の賃金を DB から直接読めなくなる。101 のあとに流す'
  union all
  select 8, '103 責任者（manager）を HR に加え、Office（gw_is_office）を作る',
         (select d.def is not null and d.def ilike '%manager%' from def_of d where d.name = 'gw_is_recruiting')
           and to_regprocedure('public.gw_is_office(uuid)') is not null,
         '101 が済んでいないと、この SQL は安全装置で止まる（責任者が応募者の給与を読めるようになるため）'
  union all
  select 9, '104 入社案内・案内URL・メール履歴（gw_onboarding_* / gw_mail_messages）。給与とは独立',
         case when to_regclass('public.gw_onboarding_guides') is null then false
              else to_regclass('public.gw_onboarding_guide_issues') is not null
                and to_regclass('public.gw_onboarding_invites') is not null
                and to_regclass('public.gw_mail_messages') is not null
                and (select count(*) from pol where tbl in ('gw_onboarding_guides','gw_onboarding_guide_issues','gw_onboarding_invites','gw_mail_messages')
                        and using_expr ilike '%gw_is_owner%') = 4 end,
         '4つの表とも、RLS は経営者（gw_is_owner）だけ。099 が前提'
),

-- ---- B. 給与の露出（件数） ---------------------------------------------------
-- 表が無くてもエラーにならないよう、to_regclass で確かめてから数える
cnt(seq, item, n, detail) as (
  select 11, '応募者の元の列に残っている給与（101 のあとは 0）',
         case when to_regclass('public.gw_hr_applicants') is null then null
              else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.gw_hr_applicants where wage_type is not null or wage_amount is not null', false, true, '')))[1]::text::int end,
         'gw_hr_applicants.wage_type / wage_amount'
  union all
  select 12, '合格通知の元の列に残っている給与（101 のあとは 0）',
         case when to_regclass('public.gw_hr_offers') is null then null
              else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.gw_hr_offers where wage_type is not null or wage_amount is not null', false, true, '')))[1]::text::int end,
         'gw_hr_offers.wage_type / wage_amount'
  union all
  select 13, '分離先（gw_hr_pay）の行数',
         case when to_regclass('public.gw_hr_pay') is null then null
              else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.gw_hr_pay', false, true, '')))[1]::text::int end,
         '100 のあと、上の 2 つの合計と同じになる'
  union all
  select 14, '元の列にだけ給与があり、gw_hr_pay に行が無いもの（0 になること）',
         case when to_regclass('public.gw_hr_pay') is null or to_regclass('public.gw_hr_applicants') is null then null
              else (xpath('/row/n/text()', query_to_xml($q$
                select count(*) as n from (
                  select a.id from public.gw_hr_applicants a
                    left join public.gw_hr_pay p on p.applicant_id = a.id and p.offer_id is null
                   where (a.wage_type is not null or a.wage_amount is not null) and p.id is null
                  union all
                  select o.id from public.gw_hr_offers o
                    left join public.gw_hr_pay p on p.offer_id = o.id
                   where (o.wage_type is not null or o.wage_amount is not null) and p.id is null) x$q$, false, true, '')))[1]::text::int end,
         '0 でないと、db/101 は安全装置で止まる'
  union all
  select 15, '給与が入っている契約（gw_contracts。この段階では分離の対象外）',
         case when to_regclass('public.gw_contracts') is null then null
              else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.gw_contracts where wage_type is not null or wage_amount is not null', false, true, '')))[1]::text::int end,
         '人事・管理者・経営者と本人が読める（段階2で経営者と本人だけにする）'
),

-- ---- C. 権限を持つ人の数 -----------------------------------------------------
roles(seq, item, n, detail) as (
  select 21 + row_number() over (order by r.role)::int,
         '社内権限「' || r.role || '」を持つ人（在籍中）',
         (select count(*) from public.gw_role_grants g join public.gw_employees e on e.id = g.employee_id
           where g.role = r.role and e.status not in ('leaving','left'))::int,
         case r.role
           when 'owner' then '経営者。0 人だと経営画面に誰も入れない。1 人だと、その人が外せなくなる'
           when 'hr' then '人事。給与を読める（段階1）'
           when 'manager' then '責任者。給与は API で塞いだ。DB は 099/100/101 のあと'
           when 'recruiter' then '採用担当。給与は API で塞いだ。DB は 100/101 のあと'
           else '' end
    from (values ('owner'),('hr'),('manager'),('recruiter'),('sales'),('finance'),('it'),('labor_advisor')) as r(role)
  union all
  select 40, '会計側の管理者（admin / staff）', (select count(distinct user_id) from public.memberships where role in ('admin','staff'))::int,
         '段階1では給与を読める。段階2で読めなくなる'
),

-- ---- D. 給与を含む表の RLS -----------------------------------------------------
policies(seq, item, detail) as (
  select 50 + row_number() over (order by tbl, polname)::int,
         tbl || ' / ' || polname,
         '対象: ' || case polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end
         || ' / 条件: ' || coalesce(using_expr, check_expr, '(なし)')
    from pol
   where tbl in ('gw_contracts','gw_hr_applicants','gw_hr_offers','gw_hr_pay','gw_role_grants',
                 'gw_sign_requests','gw_doc_orders','gw_onboard_profiles','gw_career_reviews','gw_career_levels')
)

select "区分", "項目", "状態", "詳細" from (
  select seq, 'A. 適用状況' as "区分", item as "項目",
         case when ok is null then '⚠ 表なし／判定不能' when ok then '✅ 適用済み' else '❌ 未適用' end as "状態",
         detail as "詳細"
    from applied
  union all
  select seq, 'B. 給与の件数', item,
         case when n is null then '⚠ 表なし' else 'ℹ ' || n::text || ' 件' end, detail
    from cnt
  union all
  select seq, 'C. 権限を持つ人', item, 'ℹ ' || n::text || ' 人', detail
    from roles
  union all
  select seq, 'D. RLS（給与を含む表）', item, 'ℹ', detail
    from policies
) all_rows
order by seq;
