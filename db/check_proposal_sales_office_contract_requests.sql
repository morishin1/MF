-- 読み取り専用: 適用前はfalse、適用後は全項目trueを確認。実データを表示/作成しない。
select
  to_regclass('public.gw_sales_contract_requests') is not null as requests_table,
  to_regclass('public.gw_sales_contract_request_events') is not null as audit_table,
  to_regprocedure('public.gw_sales_contract_request_action(uuid,uuid,text,text,integer,jsonb)') is not null as atomic_action,
  to_regprocedure('public.gw_sales_contract_requests_read(uuid,text,uuid)') is not null as scoped_read;
select c.relname,c.relrowsecurity as rls_enabled,
  not has_table_privilege('authenticated',c.oid,'SELECT') as direct_select_denied,
  not has_table_privilege('authenticated',c.oid,'INSERT') as direct_insert_denied,
  not has_table_privilege('authenticated',c.oid,'UPDATE') as direct_update_denied,
  not has_table_privilege('authenticated',c.oid,'DELETE') as direct_delete_denied
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('gw_sales_contract_requests','gw_sales_contract_request_events');
select p.proname,p.prosecdef as security_definer,p.proconfig,
  not has_function_privilege('anon',p.oid,'EXECUTE') as anon_denied,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_allowed
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
and p.proname in ('gw_sales_contract_request_action','gw_sales_contract_requests_read');
select tgname,not tgisinternal as application_guard,tgenabled in ('O','A') as enabled from pg_trigger
where tgname in ('gw_sales_contract_guard_proposal','gw_sales_contract_guard_activity');
