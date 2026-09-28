-- =============================================================================
-- 094: 採用HR・Sales の利用権限を、社内権限（gw_role_grants）だけで決める
--
-- ■ 何を変えるか
--   gw_is_recruiting（採用HR /hr）と gw_is_sales（Sales /sales）から、
--   会計側の管理者（memberships の admin / staff ＝ is_tenant_staff）を外す。
--
--     採用HR … owner（経営者）・hr（人事）・recruiter（採用担当）
--     Sales  … owner（経営者）・manager（責任者）・sales（営業担当）
--
--   「IT・管理」（it）や会計の管理者は、システム管理用の権限であって、
--   それだけでは採用HR・Sales の業務（履歴書・職務経歴書・評価などの個人情報）に入れない。
--   正式な設定元はメンバー管理の「社内権限」のチェック（api/employees/roles.js）。
--
-- ■ API と同じ条件
--   lib/gw.js の canRecruit / canSell（RECRUIT_ROLES / SALES_ROLES）と同じ役割の並び。
--   /api/me の access・ヘッダーの近道・/hr と /sales の入口も、同じ判定を使う。
--
-- ■ 変えないもの
--   gw_is_hr（人事の台帳・入退社など）はそのまま。会計の管理者は人事の仕事は引き続きできる。
--   関数の名前と引数は変えないので、既存の RLS ポリシーは作り直さなくてよい。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 081_hr_recruiting.sql・088_sales.sql（gw_has_role・gw_is_recruiting・gw_is_sales）
-- =============================================================================

begin;

create or replace function public.gw_is_recruiting(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'owner')
      or public.gw_has_role(p_tenant, 'hr')
      or public.gw_has_role(p_tenant, 'recruiter')
$$;

comment on function public.gw_is_recruiting(uuid) is
  '採用HR（/hr）を使える人。社内権限の owner（経営者）・hr（人事）・recruiter（採用担当）だけ。'
  '会計側の管理者・IT・管理だけでは使えない（db/094。lib/gw.js canRecruit と同じ）';

create or replace function public.gw_is_sales(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'owner')
      or public.gw_has_role(p_tenant, 'manager')
      or public.gw_has_role(p_tenant, 'sales')
$$;

comment on function public.gw_is_sales(uuid) is
  '営業アタック管理（/sales）を使える人。社内権限の owner（経営者）・manager（責任者）・sales（営業担当）だけ。'
  '会計側の管理者・IT・管理だけでは使えない（db/094。lib/gw.js canSell と同じ）';

commit;

notify pgrst, 'reload schema';

-- 確認（適用前に、採用HR・Sales を使っている人に社内権限が付いているか見ておく）:
--   select e.display_name, array_agg(g.role order by g.role) as roles
--     from public.gw_employees e left join public.gw_role_grants g on g.employee_id = e.id
--    group by e.display_name order by 1;
