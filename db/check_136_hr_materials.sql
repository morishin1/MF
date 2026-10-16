-- db/136 確認（読み取りだけ）
with t as (
  select c.relname, c.relrowsecurity as rls,
         (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) policies
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname in ('gw_hr_materials','gw_hr_interview_materials')
),
cols as (
  select table_name, count(*) n from information_schema.columns
   where table_schema='public'
     and ((table_name='gw_hr_materials' and column_name in
       ('id','tenant_id','name','category','kind','url','storage_path','filename','mime_type','size_bytes',
        'description','sort_order','is_active','share_external','default_for_casual','created_by','updated_by','created_at','updated_at'))
       or
       (table_name='gw_hr_interview_materials' and column_name in
       ('interview_id','material_id','sort_order','created_by','created_at')))
   group by table_name
)
select * from (
  select 1 n, '資料マスタと面談紐付けの2表がある' 項目,
    case when (select count(*) from t)=2 then '✅' else '❌' end 状態,
    (select count(*) from t)||' / 2 表' 詳細
  union all
  select 2, '2表とも RLS 有効', case when (select count(*) from t where rls)=2 then '✅' else '❌' end,
    coalesce((select string_agg(relname||'(rls='||rls||')',', ') from t),'表なし')
  union all
  select 3, '資料マスタの列（19）', case when coalesce((select n from cols where table_name='gw_hr_materials'),0)=19 then '✅' else '❌' end,
    coalesce((select n::text from cols where table_name='gw_hr_materials'),'0')||' / 19 列'
  union all
  select 4, '面談資料紐付けの列（5）', case when coalesce((select n from cols where table_name='gw_hr_interview_materials'),0)=5 then '✅' else '❌' end,
    coalesce((select n::text from cols where table_name='gw_hr_interview_materials'),'0')||' / 5 列'
  union all
  select 5, '既存面談件数', 'ℹ️',
    case when to_regclass('public.gw_hr_interviews') is null then '表なし'
         else (xpath('/row/c/text()',query_to_xml('select count(*) c from public.gw_hr_interviews',false,true,'')))[1]::text end
  union all
  select 6, '資料件数', 'ℹ️',
    case when to_regclass('public.gw_hr_materials') is null then '表なし'
         else (xpath('/row/c/text()',query_to_xml('select count(*) c from public.gw_hr_materials',false,true,'')))[1]::text end
) x order by n;
