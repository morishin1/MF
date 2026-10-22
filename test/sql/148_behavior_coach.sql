-- db/148_behavior_coach.sql（日報コーチ）の検証。実際の PostgreSQL で流す（test/sql/run.sh）。
--
-- ■ 何を確かめるか（合成データのみ）
--   1. 入れただけでは何も動かない（設定の行なし・全フラグ false）
--   2. RLS / 権限：authenticated・anon は表も関数も触れない。service_role だけ
--   3. 日報の保存トリガ：本文を写さずイベントだけ。設定OFFなら何もしない。曖昧な本人対応は記録しない
--      イベント追記が失敗しても、日報の保存は止まらない（通常の例外は警告にする）
--   4. 朝の確認（gw_coach_record_check）：同じ版なら新しい候補を作らない。変われば再レビュー・旧承認失効
--      final を provisional に戻さない。別テナントの社員は拒否
--   5. CAS：古い世代・古い token の結果は捨てる。lease（10分）切れは新しい token で取り直せる
--   6. 送信箱（チーム助言・代表報告）：承認は本文・宛先・世代に束縛。変更で失効。送信前に attempt を記録。
--      結果不明は delivery_unknown のまま、再 attempt できない
--   7. 取り消し（db/rollback_148）と点検（db/check_148）が通り、取り消し後も日報の保存ができる
--   二つのセッションの同時取得は test/sql/148_concurrency.sh が見る
\set ON_ERROR_STOP 0
create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;
create or replace function pg_temp.try_as(label text, role text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute 'set local role ' || role; execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  execute 'reset role';
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;

-- Supabase にある anon ロール（000_supabase_stub.sql には無い）
do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
grant usage on schema public to anon;
-- 日報（tc_nippo は別リポジトリの SQL で作られる）と予定の、最小の代用品
create table if not exists public.tc_nippo (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, work_date date not null,
  submitted_at timestamptz, updated_at timestamptz not null default now(), tomorrow_plan text, work_items jsonb);
create table if not exists public.gw_calendar_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, employee_id uuid not null,
  title text not null, body text, category text not null default 'work', source text not null default 'self',
  starts_at timestamptz not null, ends_at timestamptz not null, updated_at timestamptz not null default now());
-- Supabase は新しい表に authenticated の権限を自動で付ける。その上で 148 が外すことを確かめる
alter default privileges in schema public grant all on tables to authenticated, anon, service_role;
alter default privileges in schema public grant execute on functions to authenticated, anon, service_role;

insert into public.tenants(id,name) values
 ('14800000-0000-4000-8000-000000000001','合成T1'), ('14800000-0000-4000-8000-000000000002','合成T2');
insert into auth.users(id,email) values
 ('14810000-0000-4000-8000-000000000001','owner@example.invalid'),
 ('14810000-0000-4000-8000-000000000002','m2@example.invalid'),
 ('14810000-0000-4000-8000-000000000003','dup@example.invalid');
insert into public.gw_employees(id,tenant_id,user_id,display_name,status,employment_type) values
 ('14820000-0000-4000-8000-000000000001','14800000-0000-4000-8000-000000000001','14810000-0000-4000-8000-000000000001','合成代表','active','役員'),
 ('14820000-0000-4000-8000-000000000002','14800000-0000-4000-8000-000000000001','14810000-0000-4000-8000-000000000002','合成メンバーA','active','アルバイト'),
 ('14820000-0000-4000-8000-000000000003','14800000-0000-4000-8000-000000000001','14810000-0000-4000-8000-000000000003','合成メンバーB','active','正社員'),
 -- 同じ user が別テナントにもいる（本人対応が曖昧）
 ('14820000-0000-4000-8000-000000000004','14800000-0000-4000-8000-000000000002','14810000-0000-4000-8000-000000000003','合成メンバーB別','active','正社員');

\set c148 `sed '/^begin;/d;/^commit;/d' "$SCEN_ROOT/db/148_behavior_coach.sql"`
\set r148 `sed '/^begin;/d;/^commit;/d' "$SCEN_ROOT/db/rollback_148_behavior_coach.sql"`
select pg_temp.try('148 apply', :'c148', 'ok');
select pg_temp.try('148 is create-only (rerun refuses, no silent drop)', :'c148', 'already exists');

-- 1. 入れただけでは何も動かない
select pg_temp.expect('no config rows seeded', (select count(*)::int from public.gw_coach_config), 0);
insert into public.gw_coach_config(tenant_id) values ('14800000-0000-4000-8000-000000000001');
select pg_temp.expect('all flags default false',
  (select count(*)::int from public.gw_coach_config where not enabled and not ai_enabled and not delivery_enabled and not morning_enabled
     and team_channel_id is null and owner_slack_user_id is null), 1);
insert into public.tc_nippo(user_id,work_date,submitted_at) values ('14810000-0000-4000-8000-000000000002','2026-10-21',now());
select pg_temp.expect('disabled: nippo save appends no event', (select count(*)::int from public.gw_coach_events), 0);
select pg_temp.expect('disabled: record_check is a no-op',
  (select case when public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000002','2026-10-22','morning','ok','2026-10-21','2026-10-23','h1','{}'::jsonb,null)->>'check'='disabled' then 1 else 0 end), 1);
select pg_temp.expect('disabled: no check row', (select count(*)::int from public.gw_coach_checks), 0);

-- 2. RLS / 権限
select pg_temp.try_as('authenticated cannot read reviews','authenticated','select 1 from public.gw_coach_reviews','permission denied');
select pg_temp.try_as('authenticated cannot read checks','authenticated','select 1 from public.gw_coach_checks','permission denied');
select pg_temp.try_as('anon cannot read outbox','anon','select 1 from public.gw_coach_outbox','permission denied');
select pg_temp.try_as('authenticated cannot call record_check','authenticated',
  $q$select public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000002','2026-10-22','morning','ok',null,null,'h','{}'::jsonb,null)$q$,'permission denied');
select pg_temp.try_as('authenticated cannot approve outbox','authenticated',
  $q$select public.gw_coach_outbox_approve(gen_random_uuid(),1,'{}'::jsonb)$q$,'permission denied');
select pg_temp.try_as('service_role can read checks','service_role','select 1 from public.gw_coach_checks','ok');
select pg_temp.expect('RLS enabled on all 7 coach tables',
  (select count(*)::int from pg_class where relname in ('gw_coach_config','gw_coach_recipients','gw_coach_reviews','gw_coach_events','gw_coach_checks','gw_coach_outbox','gw_coach_runs') and relrowsecurity), 7);

-- 3. 日報の保存トリガ
update public.gw_coach_config set enabled=true where tenant_id='14800000-0000-4000-8000-000000000001';
insert into public.tc_nippo(user_id,work_date,submitted_at,tomorrow_plan) values ('14810000-0000-4000-8000-000000000002','2026-10-22',now(),'合成の計画');
select pg_temp.expect('enabled: one metadata event', (select count(*)::int from public.gw_coach_events where source_kind='nippo'), 1);
select pg_temp.expect('event holds ids only (no body columns)',
  (select count(*)::int from information_schema.columns where table_name='gw_coach_events' and column_name in ('tomorrow_plan','body','title','work_items')), 0);
insert into public.tc_nippo(user_id,work_date) values ('14810000-0000-4000-8000-000000000002','2026-10-23');
select pg_temp.expect('morning-only row (not submitted) appends nothing', (select count(*)::int from public.gw_coach_events), 1);
insert into public.tc_nippo(user_id,work_date,submitted_at) values ('14810000-0000-4000-8000-000000000003','2026-10-22',now());
select pg_temp.expect('ambiguous user->employee mapping appends nothing', (select count(*)::int from public.gw_coach_events), 1);
alter table public.gw_coach_events add constraint coach_test_fail check (source_kind <> 'nippo') not valid;
select pg_temp.try('event append failure does not block nippo save',
  $q$insert into public.tc_nippo(user_id,work_date,submitted_at) values ('14810000-0000-4000-8000-000000000002','2026-10-20',now())$q$, 'ok');
select pg_temp.expect('nippo row saved despite event failure', (select count(*)::int from public.tc_nippo where work_date='2026-10-20'), 1);
alter table public.gw_coach_events drop constraint coach_test_fail;
insert into public.gw_calendar_events(tenant_id,employee_id,title,body,category,starts_at,ends_at) values
 ('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000002','合成の私用','本文','private',now(),now());
select pg_temp.expect('private event appends nothing', (select count(*)::int from public.gw_coach_events where source_kind='schedule'), 0);

-- 4. 朝の確認
select pg_temp.expect('morning flag off: run begin disabled',
  (select case when (public.gw_coach_run_begin('14800000-0000-4000-8000-000000000001','2026-10-23','morning','key-00000000',gen_random_uuid()))->>'run'='disabled' then 1 else 0 end), 1);
select pg_temp.expect('morning flag off: still no-op',
  (select case when public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000002','2026-10-23','morning','ok','2026-10-22','2026-10-24','h1','{}'::jsonb,null)->>'check'='disabled' then 1 else 0 end), 1);
update public.gw_coach_config set morning_enabled=true, owner_user_id='14810000-0000-4000-8000-000000000001' where tenant_id='14800000-0000-4000-8000-000000000001';
create temp table draft as select
  '{"state":"owner_review","epoch":"final:2026-10-22","draft":{"id":"d1","text":"合成の下書き","sourceHash":"s1","epoch":"final:2026-10-22","needsContact":true,"points":[{"kind":"change"}]}}'::jsonb j;
select pg_temp.expect('first run creates check + review',
  (select case when (r->>'check')='created' and (r->>'review')='written' then 1 else 0 end from
    (select public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000002','2026-10-23','morning','check','2026-10-22','2026-10-24','h1','{"reasons":[]}'::jsonb,(select j from draft)) r) x), 1);
select pg_temp.expect('review row starts at generation 1 with draft',
  (select count(*)::int from public.gw_coach_reviews where report_date='2026-10-22' and generation=1 and state='owner_review' and draft->>'id'='d1'), 1);
-- 代表が承認した状態を作る（承認の中身はサーバで検証。ここでは失効だけを見る）
update public.gw_coach_reviews set approval='{"actor_user_id":"14810000-0000-4000-8000-000000000001"}', state='approved' where report_date='2026-10-22';
update public.gw_coach_checks set checked_at=now()-interval '1 hour';
select pg_temp.expect('same source hash: unchanged, no new candidate',
  (select case when (r->>'check')='unchanged' and (r->>'review')='unchanged' then 1 else 0 end from
    (select public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000002','2026-10-23','morning','check','2026-10-22','2026-10-24','h1','{"reasons":[]}'::jsonb,(select j from draft)) r) x), 1);
select pg_temp.expect('unchanged keeps approval and generation',
  (select count(*)::int from public.gw_coach_reviews where report_date='2026-10-22' and generation=1 and state='approved' and approval is not null), 1);
select pg_temp.expect('unchanged still records checked time',
  (select count(*)::int from public.gw_coach_checks where checked_at > now()-interval '1 minute' and revision=1), 1);
select pg_temp.expect('changed source: check changed, review dirty',
  (select case when (r->>'check')='changed' and (r->>'review')='written' then 1 else 0 end from
    (select public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000002','2026-10-23','morning','action','2026-10-22','2026-10-24','h2','{"reasons":[]}'::jsonb,(select j from draft)) r) x), 1);
select pg_temp.expect('change drops old approval and bumps generation/revision',
  (select count(*)::int from public.gw_coach_reviews where report_date='2026-10-22' and generation=2 and source_revision=2 and approval is null and state='owner_review'), 1);
select pg_temp.expect('check revision 2 and status updated', (select count(*)::int from public.gw_coach_checks where revision=2 and status='action'), 1);
select pg_temp.expect('provisional does not regress final epoch',
  (select case when (public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000002','2026-10-22','provisional','ok','2026-10-22','2026-10-23','h3','{}'::jsonb,
     '{"state":"no_action","epoch":"provisional:2026-10-22","draft":{"id":"d3","epoch":"provisional:2026-10-22"}}'::jsonb))->>'review'='unchanged' then 1 else 0 end), 1);
select pg_temp.expect('review still final', (select count(*)::int from public.gw_coach_reviews where evaluation_epoch='final:2026-10-22' and generation=2), 1);
select pg_temp.try('other-tenant employee refused',
  $q$select public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000004','2026-10-23','morning','ok',null,null,'h','{}'::jsonb,null)$q$, 'tenant mismatch');
select pg_temp.try('epoch must match mode/report date',
  $q$select public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000003','2026-10-23','morning','ok','2026-10-22',null,'h','{}'::jsonb,
     '{"state":"owner_review","epoch":"final:2026-10-21","draft":{"epoch":"final:2026-10-21"}}'::jsonb)$q$, 'invalid coach review');
select pg_temp.try('weekly mode cannot write reviews',
  $q$select public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000003','2026-10-26','weekly','ok','2026-10-22',null,'h','{}'::jsonb,
     '{"state":"owner_review","epoch":"final:2026-10-22","draft":{"epoch":"final:2026-10-22"}}'::jsonb)$q$, 'invalid coach review');
select pg_temp.expect('unconfirmed member counted without review',
  (select case when (public.gw_coach_record_check('14800000-0000-4000-8000-000000000001','14820000-0000-4000-8000-000000000003','2026-10-23','morning','unconfirmed',null,null,'h4','{"reasons":[{"code":"workdays_unknown"}]}'::jsonb,null))->>'check'='created' then 1 else 0 end), 1);
select pg_temp.expect('two check rows for 2026-10-23', (select count(*)::int from public.gw_coach_checks where check_date='2026-10-23'), 2);

-- 4b. 実行の lease（外部の定時呼び出し）。同時は片方、同じ鍵の再送は保存した結果を返す
select pg_temp.expect('run begin: started',
  (select case when (public.gw_coach_run_begin('14800000-0000-4000-8000-000000000001','2026-10-23','morning','key-00000001','14850000-0000-4000-8000-000000000001'))->>'run'='started' then 1 else 0 end), 1);
select pg_temp.expect('second caller while running: busy',
  (select case when (public.gw_coach_run_begin('14800000-0000-4000-8000-000000000001','2026-10-23','morning','key-00000002','14850000-0000-4000-8000-000000000002'))->>'run'='busy' then 1 else 0 end), 1);
select pg_temp.expect('finish with wrong token refused',
  (select case when public.gw_coach_run_finish('14800000-0000-4000-8000-000000000001','2026-10-23','morning','14850000-0000-4000-8000-000000000002',true,'{}') then 1 else 0 end), 0);
select pg_temp.expect('finish with lease token',
  (select case when public.gw_coach_run_finish('14800000-0000-4000-8000-000000000001','2026-10-23','morning','14850000-0000-4000-8000-000000000001',true,'{"summary":{"total":3}}') then 1 else 0 end), 1);
select pg_temp.expect('same key replay returns stored result',
  (select case when (r->>'run')='replay' and (r->'result'->'summary'->>'total')='3' then 1 else 0 end from
    (select public.gw_coach_run_begin('14800000-0000-4000-8000-000000000001','2026-10-23','morning','key-00000001','14850000-0000-4000-8000-000000000003') r) x), 1);
update public.gw_coach_runs set state='running', lease_until=now()-interval '1 minute', lease_token='14850000-0000-4000-8000-000000000009';
select pg_temp.expect('expired lease can be taken over',
  (select case when (public.gw_coach_run_begin('14800000-0000-4000-8000-000000000001','2026-10-23','morning','key-00000004','14850000-0000-4000-8000-000000000004'))->>'run'='started' then 1 else 0 end), 1);
select pg_temp.expect('takeover counted as attempt 2', (select attempts from public.gw_coach_runs where check_date='2026-10-23'), 2);
select pg_temp.try('short idempotency key refused',
  $q$select public.gw_coach_run_begin('14800000-0000-4000-8000-000000000001','2026-10-24','morning','short','14850000-0000-4000-8000-000000000005')$q$, 'invalid coach run');

-- 5. CAS / lease
update public.gw_coach_config set ai_enabled=true where tenant_id='14800000-0000-4000-8000-000000000001';
update public.gw_coach_reviews set state='queued', draft=null where report_date='2026-10-22';
select pg_temp.expect('claim with stale generation refused',
  (select case when public.gw_coach_claim(id,1,'14830000-0000-4000-8000-000000000001') then 1 else 0 end from public.gw_coach_reviews where report_date='2026-10-22'), 0);
select pg_temp.expect('claim with current generation',
  (select case when public.gw_coach_claim(id,2,'14830000-0000-4000-8000-000000000001') then 1 else 0 end from public.gw_coach_reviews where report_date='2026-10-22'), 1);
select pg_temp.expect('second claim within lease refused',
  (select case when public.gw_coach_claim(id,2,'14830000-0000-4000-8000-000000000002') then 1 else 0 end from public.gw_coach_reviews where report_date='2026-10-22'), 0);
update public.gw_coach_reviews set claimed_at=now()-interval '11 minutes' where report_date='2026-10-22';
select pg_temp.expect('expired lease re-claimed with new token',
  (select case when public.gw_coach_claim(id,2,'14830000-0000-4000-8000-000000000002') then 1 else 0 end from public.gw_coach_reviews where report_date='2026-10-22'), 1);
select pg_temp.expect('old token finish rejected',
  (select case when public.gw_coach_finish(id,2,'14830000-0000-4000-8000-000000000001','owner_review','{"id":"old"}') then 1 else 0 end from public.gw_coach_reviews where report_date='2026-10-22'), 0);
select pg_temp.expect('current token finish accepted',
  (select case when public.gw_coach_finish(id,2,'14830000-0000-4000-8000-000000000002','owner_review','{"id":"new"}') then 1 else 0 end from public.gw_coach_reviews where report_date='2026-10-22'), 1);

-- 6. 送信箱
select pg_temp.expect('team advice without approved channel is blocked',
  (select case when (public.gw_coach_outbox_upsert('14800000-0000-4000-8000-000000000001','team_advice','2026-10-23','morning','合成の助言','b1',null,null,'s1'))->>'outbox'='created' then 1 else 0 end), 1);
select pg_temp.expect('blocked state', (select count(*)::int from public.gw_coach_outbox where kind='team_advice' and state='blocked'), 1);
select pg_temp.expect('blocked cannot be approved',
  (select case when public.gw_coach_outbox_approve(id,1,'{"body_hash":"b1","target_hash":"t1","generation":1,"actor_user_id":"14810000-0000-4000-8000-000000000001"}') then 1 else 0 end from public.gw_coach_outbox where kind='team_advice'), 0);
select pg_temp.expect('owner report draft created',
  (select case when (public.gw_coach_outbox_upsert('14800000-0000-4000-8000-000000000001','owner_report','2026-10-23','morning','合成の報告','b1','{"kind":"dm","userId":"U0"}','t1','s1'))->>'outbox'='created' then 1 else 0 end), 1);
select pg_temp.expect('same body/target: unchanged',
  (select case when (public.gw_coach_outbox_upsert('14800000-0000-4000-8000-000000000001','owner_report','2026-10-23','morning','合成の報告','b1','{"kind":"dm","userId":"U0"}','t1','s1'))->>'outbox'='unchanged' then 1 else 0 end), 1);
select pg_temp.expect('approval by non-owner refused',
  (select case when public.gw_coach_outbox_approve(id,1,'{"body_hash":"b1","target_hash":"t1","generation":1,"actor_user_id":"14810000-0000-4000-8000-000000000002"}') then 1 else 0 end from public.gw_coach_outbox where kind='owner_report'), 0);
select pg_temp.expect('approval with wrong target hash refused',
  (select case when public.gw_coach_outbox_approve(id,1,'{"body_hash":"b1","target_hash":"tX","generation":1,"actor_user_id":"14810000-0000-4000-8000-000000000001"}') then 1 else 0 end from public.gw_coach_outbox where kind='owner_report'), 0);
select pg_temp.expect('owner approval bound to body/target/generation',
  (select case when public.gw_coach_outbox_approve(id,1,'{"body_hash":"b1","target_hash":"t1","generation":1,"actor_user_id":"14810000-0000-4000-8000-000000000001"}') then 1 else 0 end from public.gw_coach_outbox where kind='owner_report'), 1);
select pg_temp.expect('body change invalidates approval',
  (select case when (public.gw_coach_outbox_upsert('14800000-0000-4000-8000-000000000001','owner_report','2026-10-23','morning','合成の報告（更新）','b2','{"kind":"dm","userId":"U0"}','t1','s2'))->>'outbox'='changed' then 1 else 0 end), 1);
select pg_temp.expect('back to draft, generation 2, approval null',
  (select count(*)::int from public.gw_coach_outbox where kind='owner_report' and state='draft' and generation=2 and approval is null), 1);
select pg_temp.expect('re-approve generation 2',
  (select case when public.gw_coach_outbox_approve(id,2,'{"body_hash":"b2","target_hash":"t1","generation":2,"actor_user_id":"14810000-0000-4000-8000-000000000001"}') then 1 else 0 end from public.gw_coach_outbox where kind='owner_report'), 1);
select pg_temp.expect('attempt refused while delivery_enabled=false',
  (select case when public.gw_coach_outbox_attempt(id,2,'14840000-0000-4000-8000-000000000001') then 1 else 0 end from public.gw_coach_outbox where kind='owner_report'), 0);
update public.gw_coach_config set delivery_enabled=true where tenant_id='14800000-0000-4000-8000-000000000001';
select pg_temp.expect('attempt persisted before send',
  (select case when public.gw_coach_outbox_attempt(id,2,'14840000-0000-4000-8000-000000000001') then 1 else 0 end from public.gw_coach_outbox where kind='owner_report'), 1);
select pg_temp.expect('second attempt refused (no duplicate send)',
  (select case when public.gw_coach_outbox_attempt(id,2,'14840000-0000-4000-8000-000000000002') then 1 else 0 end from public.gw_coach_outbox where kind='owner_report'), 0);
select pg_temp.expect('timeout recorded as unknown',
  (select case when public.gw_coach_outbox_complete(id,'14840000-0000-4000-8000-000000000001',false,null) then 1 else 0 end from public.gw_coach_outbox where kind='owner_report'), 1);
select pg_temp.expect('unknown row is locked against rewrite',
  (select case when (public.gw_coach_outbox_upsert('14800000-0000-4000-8000-000000000001','owner_report','2026-10-23','morning','合成の報告（再）','b3','{"kind":"dm","userId":"U0"}','t1','s3'))->>'outbox'='locked' then 1 else 0 end), 1);
select pg_temp.expect('unknown row never re-attempted',
  (select case when public.gw_coach_outbox_attempt(id,2,'14840000-0000-4000-8000-000000000003') then 1 else 0 end from public.gw_coach_outbox where kind='owner_report'), 0);
select pg_temp.expect('unknown state kept', (select count(*)::int from public.gw_coach_outbox where kind='owner_report' and state='delivery_unknown' and body_hash='b2'), 1);
update public.gw_coach_config set delivery_enabled=false where tenant_id='14800000-0000-4000-8000-000000000001';

-- 7. 点検 → 取り消し → 取り消し後も日報は保存できる → 入れ直せる
\set k148 `cat "$SCEN_ROOT/db/check_148_behavior_coach.sql"`
select pg_temp.try('check_148 runs', :'k148', 'ok');
select pg_temp.try('rollback refuses while a send record exists', :'r148', '送信記録');
select pg_temp.expect('refused rollback left tables in place', (select count(*)::int from pg_class where relname='gw_coach_outbox'), 1);
delete from public.gw_coach_outbox where state='delivery_unknown';
select pg_temp.try('rollback_148 applies', :'r148', 'ok');
select pg_temp.expect('coach tables removed',
  (select count(*)::int from pg_class where relname like 'gw\_coach\_%' and relkind='r'), 0);
select pg_temp.expect('coach triggers removed',
  (select count(*)::int from pg_trigger where tgname like 'gw_coach_%'), 0);
select pg_temp.try('nippo save works after rollback',
  $q$insert into public.tc_nippo(user_id,work_date,submitted_at) values ('14810000-0000-4000-8000-000000000002','2026-10-19',now())$q$, 'ok');
select pg_temp.try('148 re-apply after rollback', :'c148', 'ok');
