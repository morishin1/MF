-- 148 日報コーチ：読み取り専用の点検（適用後・有効化前に流す。行の中身・本文は出さない）
-- 1) 表と RLS
select c.relname as table_name, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('gw_coach_config','gw_coach_recipients','gw_coach_reviews','gw_coach_events','gw_coach_checks','gw_coach_outbox','gw_coach_runs')
 order by 1;
-- 2) authenticated / anon に表の権限が残っていないこと（0行が正しい）
select table_name, grantee, privilege_type from information_schema.role_table_grants
 where table_schema='public' and table_name like 'gw\_coach\_%' and grantee in ('authenticated','anon','public');
-- 3) 関数を authenticated / anon が実行できないこと（全部 false が正しい）
select p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       p.prosecdef as security_definer
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'gw\_coach\_%' order by 1;
-- 4) 有効化の状態（既定は全部 false。true があれば、誰がいつ有効化したかを別記録と照合する）
select tenant_id, enabled, ai_enabled, delivery_enabled, morning_enabled,
       owner_user_id is not null as owner_set, team_channel_id is not null as channel_set,
       owner_slack_user_id is not null as owner_set_slack, owner_dm_channel_id is not null as owner_dm_set,
       coalesce((slack_preflight->>'ok')::boolean,false) as preflight_ok, slack_preflight->>'checkedAt' as preflight_at, updated_at
  from public.gw_coach_config order by tenant_id;
-- 5) トリガ（日報・予定の保存時にイベントだけ追記）
select tgname, tgrelid::regclass as on_table, tgenabled from pg_trigger where tgname like 'gw_coach_%' order by 1;
-- 6) 送信の状態（結果不明・送信中が残っていないか。残っていれば Slack 側と照合する）
select kind, state, count(*) from public.gw_coach_outbox group by 1,2 order by 1,2;
select delivery_state, count(*) from public.gw_coach_reviews group by 1 order by 1;
-- 7) 未処理イベント（多ければ collect が止まっている）
select count(*) as pending_events, min(created_at) as oldest from public.gw_coach_events where state='pending';
-- 8) 定時確認の実行（P の 08:00 / 17:30 / 月曜）。running のまま lease 切れが続く、failed が続くなら呼び出し側を確認する
select check_date, mode, state, attempts, started_at, finished_at from public.gw_coach_runs order by check_date desc, mode limit 20;
