-- db/136 確認（読み取りだけ）
with
t as (
  select c.relname, c.relrowsecurity,
    (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('gw_hr_materials','gw_hr_interview_materials')
),
cols as (
  select table_name, count(*) n
  from information_schema.columns
  where table_schema='public'
    and ((table_name='gw_hr_materials' and column_name in
      ('id','tenant_id','name','category','kind','url','storage_path','filename','mime_type','size_bytes','description','sort_order','is_active','share_external','default_for_casual','created_by','updated_by','created_at','updated_at'))
      or
      (table_name='gw_hr_interview_materials' and column_name in
      ('interview_id','material_id','tenant_id','sort_order','created_by','created_at')))
  group by table_name
),
fk as (
  select count(*) n from pg_constraint
  where conrelid=to_regclass('public.gw_hr_interview_materials') and contype='f'
)
select * from (
  select 1 n, '資料2表がある' 項目,
    case when (select count(*) from t)=2 then '✅' else '❌' end 状態,
    (select count(*) from t)||' / 2 表' 詳細
  union all
  select 2, '2表ともRLS有効・SELECTポリシーだけ',
    case when (select count(*) from t where relrowsecurity and policies=1)=2 then '✅' else '❌' end,
    coalesce((select string_agg(relname||'(rls='||relrowsecurity||',policies='||policies||')', ', ') from t),'表なし')
  union all
  select 3, 'gw_hr_materials の主要19列',
    case when coalesce((select n from cols where table_name='gw_hr_materials'),0)=19 then '✅' else '❌' end,
    coalesce((select n::text from cols where table_name='gw_hr_materials'),'0')||' / 19 列'
  union all
  select 4, '面談資料リンクの主要6列',
    case when coalesce((select n from cols where table_name='gw_hr_interview_materials'),0)=6 then '✅' else '❌' end,
    coalesce((select n::text from cols where table_name='gw_hr_interview_materials'),'0')||' / 6 列'
  union all
  select 5, '面談資料リンクのFKがある',
    case when (select n from fk)>=3 then '✅' else '❌' end,
    (select n from fk)||' 件'
  union all
  select 6, '登録済み資料件数', 'ℹ️',
    case when to_regclass('public.gw_hr_materials') is null then '表なし'
      else (xpath('/row/c/text()', query_to_xml('select count(*) c from public.gw_hr_materials',false,true,'')))[1]::text end
) x order by n;
