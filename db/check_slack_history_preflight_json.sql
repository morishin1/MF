-- SELECT-only, one JSON row; owner runs against MF only. No applicant/mail/secret values.
select jsonb_build_object(
 'check','slack_history_preflight_v1',
 'database',current_database(),'executor_role',current_user,
 'history_table_exists',to_regclass('public.gw_slack_notification_history') is not null,
 'planned_index_exists',to_regclass('public.gw_slack_history_scope_time') is not null,
 'tenant_table_exists',to_regclass('public.tenants') is not null,
 'auth_users_exists',to_regclass('auth.users') is not null,
 'tenant_count',(select count(*) from public.tenants),
 'uuid_generator_exists',to_regprocedure('gen_random_uuid()') is not null,
 'required_roles',jsonb_build_object('anon',exists(select 1 from pg_roles where rolname='anon'),'authenticated',exists(select 1 from pg_roles where rolname='authenticated'),'service_role',exists(select 1 from pg_roles where rolname='service_role')),
 'existing_history_columns',coalesce((select jsonb_agg(jsonb_build_object('name',column_name,'type',data_type,'nullable',is_nullable) order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='gw_slack_notification_history'),'[]'::jsonb),
 'existing_history_policies',coalesce((select jsonb_agg(jsonb_build_object('name',policyname,'roles',roles,'command',cmd)) from pg_policies where schemaname='public' and tablename='gw_slack_notification_history'),'[]'::jsonb),
 'scope','one new append-only table and index; no functions/storage/old-mail changes',
 'new_functions',0,'new_browser_policies',0
) as result;
