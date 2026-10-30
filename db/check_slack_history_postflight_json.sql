-- SELECT-only, one JSON row. Metadata only; no notification content.
select jsonb_build_object(
 'check','slack_history_postflight_v1',
 'history_table_exists',to_regclass('public.gw_slack_notification_history') is not null,
 'rls_enabled',(select relrowsecurity from pg_class where oid=to_regclass('public.gw_slack_notification_history')),
 'index_exists',to_regclass('public.gw_slack_history_scope_time') is not null,
 'columns',coalesce((select jsonb_agg(jsonb_build_object('name',column_name,'type',data_type,'nullable',is_nullable) order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='gw_slack_notification_history'),'[]'::jsonb),
 'constraints',coalesce((select jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid))) from pg_constraint where conrelid=to_regclass('public.gw_slack_notification_history')),'[]'::jsonb),
 'grants',coalesce((select jsonb_agg(jsonb_build_object('grantee',grantee,'privilege',privilege_type)) from information_schema.role_table_grants where table_schema='public' and table_name='gw_slack_notification_history'),'[]'::jsonb),
 'policies',coalesce((select jsonb_agg(jsonb_build_object('name',policyname,'roles',roles,'command',cmd)) from pg_policies where schemaname='public' and tablename='gw_slack_notification_history'),'[]'::jsonb)
) as result;
