-- =============================================================================
-- db/130（Sales の権限判定を API と DB でそろえる）の確認（読み取りだけ。何も書き換えない）
--
-- Supabase の SQL Editor に貼って Run。結果は「項目 / 状態 / 詳細」。❌ の行があれば db/130 が当たっていない。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい   ℹ … 参考（人数）
-- =============================================================================
with def as (
  select coalesce(pg_get_functiondef(to_regprocedure('public.gw_is_sales(uuid)')), '') as body
),
pol as (
  select c.relname as tbl, p.polname,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relname like 'gw\_sales\_%'
),
people as (
  select e.id,
         exists (select 1 from public.gw_role_grants r where r.employee_id = e.id and r.role = 'owner') as is_owner,
         exists (select 1 from public.gw_app_grants g where g.employee_id = e.id and g.app_key = 'sales') as has_app,
         exists (select 1 from public.gw_role_grants r where r.employee_id = e.id and r.role in ('manager','sales')) as has_role
    from public.gw_employees e
   where e.status <> 'left' and e.user_id is not null
),
rows(seq, item, ok, detail) as (
  select 1, 'gw_is_sales が「owner または Sales のアプリ権限」',
         (select body ilike '%gw_has_role(p_tenant, ''owner'')%' and body ilike '%gw_has_app(p_tenant, ''sales'')%' from def), ''
  union all
  select 2, 'gw_is_sales が manager・sales のロールを見ていない',
         (select body not ilike '%''manager''%' and body not ilike '%gw_has_role(p_tenant, ''sales'')%' from def), ''
  union all
  select 3, 'gw_is_sales は SECURITY DEFINER・search_path 固定',
         (select body ilike '%security definer%' and body ilike '%search_path%' from def), ''
  union all
  select 4, 'gw_sales_* のポリシーは gw_is_sales のまま（ポリシーは変えていない）',
         not exists (select 1 from pol where expr not ilike '%gw_is_sales%'),
         (select coalesce(string_agg(tbl || '.' || polname, ', '), '') from pol where expr not ilike '%gw_is_sales%')
  union all
  select 5, 'ℹ Sales を使える人（経営者 または Sales アプリ権限。退職者を除く）', null,
         (select count(*) filter (where is_owner or has_app)::text || ' 人' from people)
  union all
  select 6, 'ℹ manager / sales のロールだけでアプリ権限が無い人（DB でも使えなくなった人）', null,
         (select count(*) filter (where has_role and not has_app and not is_owner)::text || ' 人' from people)
)
select item as "項目",
       case when ok is null then 'ℹ' when ok then '✅' else '❌' end as "状態",
       detail as "詳細"
  from rows order by seq;
