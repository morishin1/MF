-- db/161_enger_company_portal.sql を流したあとの確認（読むだけ。何も変えない）
-- すべて ✅ なら適用済み。❌ があれば db/161 をもう一度 Run（べき等）。
with t(name) as (values
  ('dx2_company_portal_members'), ('dx2_company_portal_invites'), ('dx2_company_talent_links'),
  ('dx2_company_portal_saved_talents'), ('dx2_company_portal_events')
)
select 'table enger.' || t.name as item,
       case when c.oid is null then '❌ ない'
            when not c.relrowsecurity then '❌ RLS が無効'
            when has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT')
              then '❌ ブラウザ（anon/authenticated）から読める'
            when not has_table_privilege('service_role', c.oid, 'SELECT') then '❌ service_role が読めない'
            when exists (select 1 from pg_policies p where p.schemaname = 'enger' and p.tablename = t.name)
              then '❌ ポリシーがある（deny-by-default のはず）'
            else '✅' end as result
  from t
  left join pg_class c on c.relname = t.name and c.relnamespace = 'enger'::regnamespace
union all
select 'trigger append-only（events）',
       case when exists (select 1 from pg_trigger where tgname = 'dx2_company_portal_events_append_only' and not tgisinternal)
            then '✅' else '❌ ない' end
union all
select 'trigger saved guard（saved_talents）',
       case when exists (select 1 from pg_trigger where tgname = 'dx2_company_portal_saved_guard' and not tgisinternal)
            then '✅' else '❌ ない' end
union all
select 'unique email（members）',
       case when to_regclass('enger.dx2_company_portal_members_email_uq') is not null then '✅' else '❌ ない' end
union all
select 'events は更新・削除の権限が無い',
       case when to_regclass('enger.dx2_company_portal_events') is null then '❌ ない'
            when has_table_privilege('service_role', 'enger.dx2_company_portal_events', 'UPDATE')
              or has_table_privilege('service_role', 'enger.dx2_company_portal_events', 'DELETE') then '❌ 更新・削除できる'
            else '✅' end;
