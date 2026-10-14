-- =============================================================================
-- db/126（権限の付け外しの固定ルール・キャリアの給与は経営者だけ）の確認（読み取りだけ。何も書き換えない）
--
-- Supabase の SQL Editor に貼って Run。結果は「項目 / 状態 / 詳細」。❌ の行があれば db/126 が当たっていない。
--   ✅ … 期待どおり   ❌ … 未適用   ℹ … 参考（人数）
-- =============================================================================

with pol as (
  select c.relname as tbl, p.polname,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') as using_expr,
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as check_expr
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
),
rows(seq, item, ok, detail) as (
  select 1, '付け外しの規則の関数（gw_can_grant_role）',
         to_regprocedure('public.gw_can_grant_role(uuid,uuid,text)') is not null, ''
  union all
  select 2, '内部ロールの書き込み（gw_role_grants_hr_write）が固定ルール',
         exists (select 1 from pol where polname = 'gw_role_grants_hr_write'
                   and using_expr ilike '%gw_can_grant_role%' and check_expr ilike '%gw_can_grant_role%'), ''
  union all
  select 3, 'アプリ利用権限の書き込み（gw_app_grants_hr_write）が固定ルール',
         exists (select 1 from pol where polname = 'gw_app_grants_hr_write'
                   and using_expr ilike '%gw_can_grant_role%' and check_expr ilike '%gw_can_grant_role%'), ''
  union all
  select 4, 'キャリアの給与レンジ（gw_career_levels）は経営者だけが直接読める',
         exists (select 1 from pol where polname = 'gw_career_levels_read' and using_expr ilike '%gw_is_owner%'), ''
  union all
  select 5, 'キャリアの評価・給与メモ（gw_career_reviews）は経営者だけが直接読める',
         exists (select 1 from pol where polname = 'gw_career_reviews_read' and using_expr ilike '%gw_is_owner%'), ''
)
select item as 項目, case when ok then '✅' else '❌' end as 状態, detail as 詳細 from rows
union all
-- 参考：経営者だけが付け外しできる権限を、いま持っている人数（db/126 は既存の行を消さない）
select 'ℹ IT・管理（it）の人数', 'ℹ', count(*)::text from public.gw_role_grants where role = 'it'
union all
select 'ℹ 社労士（labor_advisor）の人数', 'ℹ', count(*)::text from public.gw_role_grants where role = 'labor_advisor'
union all
select 'ℹ 経営者（owner）の人数', 'ℹ', count(*)::text from public.gw_role_grants where role = 'owner';
