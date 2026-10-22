-- 146 読み取り専用チェック
select column_name,data_type from information_schema.columns
 where table_schema='public' and table_name='gw_hr_spot_talents'
 and column_name in ('deleted_at','deleted_by') order by column_name;
select p.proname, p.prosecdef, p.proacl from pg_proc p
 join pg_namespace n on p.pronamespace=n.oid
 where n.nspname='public' and p.proname='gw_hr_spot_bulk';
select indexname from pg_indexes where schemaname='public'
 and tablename='gw_hr_spot_talents' and indexname='idx_gw_hr_spot_active';
