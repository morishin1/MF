-- db/147: EIGHT秘書 Slack 窓口の表を、依存する db/113（gw_ai_knowledge）と合わせて実PostgreSQLで検証
--   RLS（ブラウザ側ロールは読めない・書けない）、一意性（event_id / message_key / 紐付け / 承認メッセージ）、
--   CAS 状態遷移、承認の結び付け制約、ロールバックの安全装置、再適用。
--   2つのセッションの同時取得は run.sh 側（psql を2本同時に動かす）で確かめる。
\set ON_ERROR_STOP 0
\set c099 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/099_access_hr_office.sql"`
\set c113 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/113_ai_assistant.sql"`
\set c147 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/147_slack_ai_secretary.sql"`
\set k147 `cat "$SCEN_ROOT/db/check_147_slack_ai_secretary.sql"`
\set r147 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_147_slack_ai_secretary.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got=want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' expected ' || want; end $$;
create or replace function pg_temp.try(label text, stmt text, expected text) returns void language plpgsql as $$
declare msg text; worked boolean:=false;
begin begin execute stmt; worked:=true; exception when others then msg:=sqlerrm; end;
  raise notice '% : %', case when (expected='ok' and worked) or (expected<>'ok' and not worked and msg like '%'||expected||'%') then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
end $$;
create or replace function pg_temp.try_as(label text, uid uuid, stmt text, expected text) returns void language plpgsql as $$
declare msg text; worked boolean:=false;
begin
  perform set_config('request.jwt.claim.sub',uid::text,false);
  execute 'set local role authenticated';
  begin execute stmt; worked:=true; exception when others then msg:=sqlerrm; end;
  execute 'reset role';
  raise notice '% : %', case when (expected='ok' and worked) or (expected<>'ok' and not worked and msg like '%'||expected||'%') then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
end $$;
-- 件数を「そのロールで」数える（RLS を通した結果）
create or replace function pg_temp.count_as(uid uuid, stmt text) returns int language plpgsql as $$
declare c int;
begin
  perform set_config('request.jwt.claim.sub',uid::text,false);
  execute 'set local role authenticated';
  begin execute stmt into c; exception when others then c := -1; end;
  execute 'reset role';
  return c;
end $$;

do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
grant usage on schema public,auth to anon;

select pg_temp.try('099 access hr/office', :'c099', 'ok');
select pg_temp.try('113 ai assistant', :'c113', 'ok');
select pg_temp.try('113 rerun idempotent', :'c113', 'ok');
select pg_temp.try('147 apply', :'c147', 'ok');
select pg_temp.try('147 rerun idempotent', :'c147', 'ok');
-- Supabase は新しい表に権限を自動で付ける。その状態を再現してから、もう一度 147 を流して剥がれることを確かめる
grant all on all tables in schema public to authenticated, anon, service_role;
select pg_temp.try('147 rerun revokes browser grants', :'c147', 'ok');

select pg_temp.expect('three tables with RLS enabled',
  (select count(*)::int from pg_class where relname in ('gw_slack_ai_users','gw_slack_ai_events','gw_slack_ai_escalations') and relrowsecurity), 3);
select pg_temp.expect('no RLS policies (service role only)',
  (select count(*)::int from pg_policies where tablename like 'gw_slack_ai_%'), 0);
select pg_temp.expect('authenticated has no table privilege',
  (select count(*)::int from information_schema.role_table_grants where table_name like 'gw_slack_ai_%' and grantee in ('anon','authenticated')), 0);
select pg_temp.expect('approval binding columns exist',
  (select count(*)::int from information_schema.columns where table_name='gw_slack_ai_escalations'
    and column_name in ('owner_dm_channel','approval_ts','approved_at','approval_hash','approval_invalidated_ts','ai_draft_answer')), 6);

-- テスト用データ（service role 相当＝postgres で投入）
insert into public.tenants(id,name) values
  ('a1470000-0000-0000-0000-000000000001','T1'), ('a1470000-0000-0000-0000-000000000002','T2');
insert into auth.users(id,email) values
  ('b1470000-0000-0000-0000-000000000001','emp@x'), ('b1470000-0000-0000-0000-000000000002','hr@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status) values
  ('c1470000-0000-0000-0000-000000000001','a1470000-0000-0000-0000-000000000001','b1470000-0000-0000-0000-000000000001','一般社員','emp@x','active'),
  ('c1470000-0000-0000-0000-000000000002','a1470000-0000-0000-0000-000000000001','b1470000-0000-0000-0000-000000000002','人事','hr@x','active'),
  ('c1470000-0000-0000-0000-000000000003','a1470000-0000-0000-0000-000000000002',null,'別テナント','x@y','active');
insert into public.gw_role_grants(tenant_id,employee_id,role) values
  ('a1470000-0000-0000-0000-000000000001','c1470000-0000-0000-0000-000000000002','hr');
insert into public.gw_ai_knowledge(tenant_id,title,category,content,access_scope,is_active) values
  ('a1470000-0000-0000-0000-000000000001','全員','rules','全員向け','all',true),
  ('a1470000-0000-0000-0000-000000000001','人事','hr','人事向け','hr',true),
  ('a1470000-0000-0000-0000-000000000001','経理','accounting','経理向け','finance',true),
  ('a1470000-0000-0000-0000-000000000001','管理','other','管理者向け','admin',true);

-- 113: Slack 窓口が質問者のスコープで使うナレッジの RLS（lib/ai-knowledge.js の allowedKnowledgeScopes と対応）
select pg_temp.expect('113 employee sees only all-scope knowledge',
  pg_temp.count_as('b1470000-0000-0000-0000-000000000001','select count(*) from public.gw_ai_knowledge'), 1);
select pg_temp.expect('113 hr sees all+hr knowledge',
  pg_temp.count_as('b1470000-0000-0000-0000-000000000002','select count(*) from public.gw_ai_knowledge'), 2);

insert into public.gw_slack_ai_users(tenant_id,slack_team_id,slack_user_id,employee_id) values
  ('a1470000-0000-0000-0000-000000000001','T1','U1','c1470000-0000-0000-0000-000000000001');
insert into public.gw_slack_ai_events(event_id,slack_team_id,event_payload,message_key) values
  ('Ev1','T1','{"event":{}}','D1:1.1'), ('Ev2','T1','{"event":{}}','D1:1.2');
insert into public.gw_slack_ai_escalations(id,tenant_id,employee_id,requester_slack_user_id,requester_channel,requester_thread_ts,requester_knowledge_scopes,question,owner_dm_channel,owner_dm_ts) values
  ('d1470000-0000-0000-0000-000000000001','a1470000-0000-0000-0000-000000000001','c1470000-0000-0000-0000-000000000001','U1','D1','1.1','["all"]','質問','Downer','9.1');

-- RLS: ログイン済み社員（本人であっても）も、anon も読めない・書けない
select pg_temp.expect('authenticated cannot read own Slack link',
  pg_temp.count_as('b1470000-0000-0000-0000-000000000001','select count(*) from public.gw_slack_ai_users'), -1);
select pg_temp.expect('authenticated cannot read escalations',
  pg_temp.count_as('b1470000-0000-0000-0000-000000000001','select count(*) from public.gw_slack_ai_escalations'), -1);
select pg_temp.try_as('authenticated cannot self-link a Slack ID','b1470000-0000-0000-0000-000000000001',
  $q$insert into public.gw_slack_ai_users(tenant_id,slack_team_id,slack_user_id,employee_id) values ('a1470000-0000-0000-0000-000000000001','T1','U9','c1470000-0000-0000-0000-000000000002')$q$,
  'permission denied');
select pg_temp.try_as('authenticated cannot approve an escalation','b1470000-0000-0000-0000-000000000001',
  $q$update public.gw_slack_ai_escalations set status='answered'$q$, 'permission denied');
set role anon;
select pg_temp.try('anon cannot read events', 'select 1 from public.gw_slack_ai_events', 'permission denied');
reset role;
-- RLS 自体も有効（権限を誤って戻しても、ポリシーが無いので0件）
grant select on public.gw_slack_ai_escalations to authenticated;
select pg_temp.expect('RLS still hides rows if a grant slips back',
  pg_temp.count_as('b1470000-0000-0000-0000-000000000001','select count(*) from public.gw_slack_ai_escalations'), 0);
revoke select on public.gw_slack_ai_escalations from authenticated;

-- 一意性
select pg_temp.try('duplicate event_id rejected',
  $q$insert into public.gw_slack_ai_events(event_id,slack_team_id,event_payload) values ('Ev1','T1','{}')$q$, 'duplicate key');
select pg_temp.try('same message under new event_id rejected',
  $q$insert into public.gw_slack_ai_events(event_id,slack_team_id,event_payload,message_key) values ('Ev1-retry','T1','{}','D1:1.1')$q$, 'duplicate key');
select pg_temp.try('null message_key allowed for legacy rows',
  $q$insert into public.gw_slack_ai_events(event_id,slack_team_id,event_payload) values ('Ev-legacy','T1','{}')$q$, 'ok');
select pg_temp.try('one Slack user maps to one employee',
  $q$insert into public.gw_slack_ai_users(tenant_id,slack_team_id,slack_user_id,employee_id) values ('a1470000-0000-0000-0000-000000000001','T1','U1','c1470000-0000-0000-0000-000000000002')$q$, 'duplicate key');
select pg_temp.try('one employee maps to one Slack user per tenant',
  $q$insert into public.gw_slack_ai_users(tenant_id,slack_team_id,slack_user_id,employee_id) values ('a1470000-0000-0000-0000-000000000001','T1','U2','c1470000-0000-0000-0000-000000000001')$q$, 'duplicate key');
select pg_temp.try('invalid event state rejected',
  $q$update public.gw_slack_ai_events set state='retry' where event_id='Ev2'$q$, 'check constraint');
select pg_temp.try('approved without binding rejected',
  $q$update public.gw_slack_ai_escalations set status='approved_pending_delivery', approved_answer='x' where id='d1470000-0000-0000-0000-000000000001'$q$,
  'gw_slack_ai_escalations_approval_bound_check');
select pg_temp.try('invalid escalation status rejected',
  $q$update public.gw_slack_ai_escalations set status='resend' where id='d1470000-0000-0000-0000-000000000001'$q$, 'check constraint');

-- CAS: 状態を条件にした更新は1回だけ効く
create temp table cas(label text, n int);
with x as (update public.gw_slack_ai_events set state='processing' where event_id='Ev1' and state='queued' returning 1) insert into cas select 'claim1', count(*) from x;
with x as (update public.gw_slack_ai_events set state='processing' where event_id='Ev1' and state='queued' returning 1) insert into cas select 'claim2', count(*) from x;
select pg_temp.expect('event claim CAS first wins', (select n from cas where label='claim1'), 1);
select pg_temp.expect('event claim CAS second loses', (select n from cas where label='claim2'), 0);
with x as (update public.gw_slack_ai_escalations set status='approved_pending_delivery', approved_answer='回答', approval_ts='9.2', approved_at=now(), approval_hash='h1'
  where id='d1470000-0000-0000-0000-000000000001' and status='pending' returning 1) insert into cas select 'approve', count(*) from x;
with x as (update public.gw_slack_ai_escalations set status='delivery_attempted'
  where id='d1470000-0000-0000-0000-000000000001' and status='approved_pending_delivery' and approval_hash='stale' returning 1) insert into cas select 'stale', count(*) from x;
with x as (update public.gw_slack_ai_escalations set status='delivery_attempted'
  where id='d1470000-0000-0000-0000-000000000001' and status='approved_pending_delivery' and approval_hash='h1' returning 1) insert into cas select 'attempt', count(*) from x;
with x as (update public.gw_slack_ai_escalations set status='pending', approved_answer=null, approval_ts=null, approved_at=null, approval_hash=null
  where id='d1470000-0000-0000-0000-000000000001' and status='approved_pending_delivery' returning 1) insert into cas select 'late_edit', count(*) from x;
select pg_temp.expect('approve CAS from pending', (select n from cas where label='approve'), 1);
select pg_temp.expect('delivery claim with stale approval hash loses', (select n from cas where label='stale'), 0);
select pg_temp.expect('delivery claim with current hash wins', (select n from cas where label='attempt'), 1);
select pg_temp.expect('edit after delivery_attempted cannot reopen', (select n from cas where label='late_edit'), 0);
select pg_temp.try('second approval message cannot bind another escalation',
  $q$insert into public.gw_slack_ai_escalations(tenant_id,employee_id,requester_slack_user_id,requester_channel,requester_thread_ts,question,owner_dm_channel,owner_dm_ts,approval_ts)
     values ('a1470000-0000-0000-0000-000000000001','c1470000-0000-0000-0000-000000000001','U1','D1','1.3','q','Downer','9.3','9.2')$q$, 'duplicate key');
select pg_temp.try('owner request message is unique',
  $q$insert into public.gw_slack_ai_escalations(tenant_id,employee_id,requester_slack_user_id,requester_channel,requester_thread_ts,question,owner_dm_ts)
     values ('a1470000-0000-0000-0000-000000000001','c1470000-0000-0000-0000-000000000001','U1','D1','1.4','q','9.1')$q$, 'duplicate key');

-- 失効は行を消さずに止める
update public.gw_slack_ai_users set revoked_at=now() where slack_user_id='U1';
select pg_temp.expect('revoked link kept for audit', (select count(*)::int from public.gw_slack_ai_users where revoked_at is not null), 1);

-- ロールバックの安全装置: 記録があると中断し、何も消さない
select pg_temp.try('rollback refuses while records exist', :'r147', 'ロールバック不可');
select pg_temp.expect('tables still present after refused rollback',
  (select count(*)::int from pg_class where relname in ('gw_slack_ai_users','gw_slack_ai_events','gw_slack_ai_escalations')), 3);
delete from public.gw_slack_ai_escalations;
select pg_temp.try('rollback refuses while events are unfinished', :'r147', '未処理');
update public.gw_slack_ai_events set state='done';
select pg_temp.try('rollback succeeds once empty/finished', :'r147', 'ok');
select pg_temp.expect('tables dropped by rollback',
  (select count(*)::int from pg_class where relname in ('gw_slack_ai_users','gw_slack_ai_events','gw_slack_ai_escalations')), 0);
select pg_temp.expect('113 knowledge untouched by rollback', (select count(*)::int from public.gw_ai_knowledge), 4);
select pg_temp.try('147 re-apply after rollback', :'c147', 'ok');
select pg_temp.try('check_147 read-only SQL runs', :'k147', 'ok');
