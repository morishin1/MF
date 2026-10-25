-- READ ONLY proposal inspection; not run by this task.
select tablename,rowsecurity from pg_tables where schemaname='public' and tablename in ('gw_marketing_intake','gw_marketing_intake_events');
select grantee,table_name,privilege_type from information_schema.role_table_grants where table_schema='public' and table_name in ('gw_marketing_intake','gw_marketing_intake_events');
select grantee,routine_name,privilege_type from information_schema.role_routine_grants where routine_schema='public' and routine_name in ('gw_marketing_intake_mutate','gw_marketing_intake_employee_allowed');

-- Explicit existence and index/constraint definitions (read-only; compare expected names/columns).
select to_regclass('public.gw_marketing_intake') as intake_table,
       to_regclass('public.gw_marketing_intake_events') as history_table;
select tablename,indexname,indexdef from pg_indexes where schemaname='public'
 and tablename in ('gw_marketing_intake','gw_marketing_intake_events');
select c.relname,con.conname,con.contype,pg_get_constraintdef(con.oid) as definition
 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('gw_marketing_intake','gw_marketing_intake_events');
select p.oid::regprocedure as signature,p.prosecdef,p.proacl,p.proconfig
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('gw_marketing_intake_mutate','gw_marketing_intake_employee_allowed');
