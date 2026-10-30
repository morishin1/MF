-- READ ONLY metadata; operator executes. No message bodies, mail, users or tokens.
select to_regclass('public.gw_slack_notification_history') as history_table;
select relname,relrowsecurity from pg_class where oid=to_regclass('public.gw_slack_notification_history');
select column_name,data_type,is_nullable from information_schema.columns where table_schema='public' and table_name='gw_slack_notification_history' order by ordinal_position;
select conname,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid=to_regclass('public.gw_slack_notification_history');
select grantee,privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='gw_slack_notification_history' order by grantee,privilege_type;
select policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='gw_slack_notification_history';
-- Expected: RLS=true; no browser/public grants or policies; service_role SELECT,INSERT only;
-- fixed departments/channels/sources; unique slot/revision and Slack channel/timestamp.
