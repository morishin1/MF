-- 147 読み取り専用チェック（EIGHT秘書 Slack 窓口）。行の中身（質問・回答本文）は表示しない。
select table_name, (select relrowsecurity from pg_class where oid = ('public.' || table_name)::regclass) as rls_enabled
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('gw_slack_ai_users', 'gw_slack_ai_events', 'gw_slack_ai_escalations')
 order by table_name;
-- ポリシーは0件であること（service_role だけが使う）
select tablename, count(*) as policies from pg_policies
 where schemaname = 'public' and tablename like 'gw_slack_ai_%' group by tablename;
-- anon / authenticated に権限が残っていないこと（0件が正）
select grantee, table_name, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name like 'gw_slack_ai_%'
   and grantee in ('anon', 'authenticated');
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in (('gw_slack_ai_users','revoked_at'), ('gw_slack_ai_events','message_key'),
     ('gw_slack_ai_escalations','owner_dm_channel'), ('gw_slack_ai_escalations','approval_ts'),
     ('gw_slack_ai_escalations','approved_at'), ('gw_slack_ai_escalations','approval_hash'),
     ('gw_slack_ai_escalations','approval_invalidated_ts'), ('gw_slack_ai_escalations','ai_draft_answer'), ('gw_slack_ai_escalations','requester_knowledge_scopes'))
 order by 1, 2;
select indexname from pg_indexes where schemaname = 'public' and tablename like 'gw_slack_ai_%' order by indexname;
select conname, convalidated from pg_constraint
 where conrelid = 'public.gw_slack_ai_escalations'::regclass and contype = 'c' order by conname;
-- 件数だけ（状態別）
select state, count(*) from public.gw_slack_ai_events group by state order by state;
select status, count(*) from public.gw_slack_ai_escalations group by status order by status;
