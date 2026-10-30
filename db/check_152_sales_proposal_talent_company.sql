-- 本人実行用。htglvascsuqkixpmclwr。読取のみ。実データを返さない。
with definitions as (
 select column_name,data_type,is_nullable,is_generated,column_default
 from information_schema.columns where table_schema='public' and table_name='gw_sales_proposals'
   and column_name in ('talent_company_name','talent_company_observed_at')
), checks as (
 select exists(select 1 from definitions where column_name='talent_company_name'
   and data_type='text' and is_nullable='YES' and is_generated='NEVER' and column_default is null) as name_ready,
 exists(select 1 from definitions where column_name='talent_company_observed_at'
   and data_type='timestamp with time zone' and is_nullable='YES' and is_generated='NEVER' and column_default is null) as observation_ready
)
select jsonb_build_object('relation','public.gw_sales_proposals',
 'ready', name_ready and observation_ready,
 'name_ready',name_ready,'observation_ready',observation_ready,
 'rls_enabled',(select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='gw_sales_proposals')) as talent_company_check
from checks;
