-- db/125_office_recurring.sql（Office 定例業務マスター・Office 業務予定）と db/check_office_recurring.sql の検証。実際の PostgreSQL で流す。
--
-- ■ 何を確かめるか
--   ・前提（005）の上に、2回流しても同じ（べき等）
--   ・RLS が有効でポリシーが無い：ログインした人（人事・経理・一般）は直接読めない・書けない（API だけが service role で扱う）
--   ・同じマスター・同じ日の予定は1件だけ（二重生成の防止）。マスターの無い単発は何件でもよい
--   ・Excel の同じ行（source_key / source_id）は2回入らない
--   ・カテゴリ・状態・優先度・繰り返しの値の制約。完了なら完了日時がある
--   ・マスターを消しても予定は残る（参照だけ外れる）。担当者を消すと担当が外れる
--   ・確認用 SQL（db/check_office_recurring.sql）がエラーなく流れ、二重は0
\set ON_ERROR_STOP 0
\set c125 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/125_office_recurring.sql"`
\set chk `cat "$SCEN_ROOT/db/check_office_recurring.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;
create or replace function pg_temp.count_as(uid uuid, tbl text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  execute 'set local role authenticated';
  execute format('select count(*) from %s', tbl) into n;
  execute 'reset role';
  return n;
end $$;
create or replace function pg_temp.try_as(label text, uid uuid, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  execute 'set local role authenticated';
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  execute 'reset role';
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;

select pg_temp.try('A1 125 applies', :'c125', 'ok');
select pg_temp.try('A2 125 applies again (idempotent)', :'c125', 'ok');
select pg_temp.expect('A3 RLS on both tables', (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('gw_office_recurring_tasks', 'gw_office_calendar_events') and c.relrowsecurity), 2);
select pg_temp.expect('A4 no policies', (select count(*)::int from pg_policies where schemaname = 'public'
  and tablename in ('gw_office_recurring_tasks', 'gw_office_calendar_events')), 0);
select pg_temp.expect('A5 three unique indexes', (select count(*)::int from pg_indexes where schemaname = 'public'
  and indexname in ('uq_gw_office_recurring_source', 'uq_gw_office_events_recurring', 'uq_gw_office_events_source')), 3);
grant all on all tables in schema public to authenticated, service_role;

insert into public.tenants(id,name) values ('12512512-0000-0000-0000-000000000001','T1');
insert into auth.users(id,email) values ('a1250001-0000-0000-0000-000000000000','fin@x'), ('a1250002-0000-0000-0000-000000000000','hr@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status) values
 ('a1250001-0000-0000-0000-000000000000','12512512-0000-0000-0000-000000000001','a1250001-0000-0000-0000-000000000000','経理','fin@x','active'),
 ('a1250002-0000-0000-0000-000000000000','12512512-0000-0000-0000-000000000001','a1250002-0000-0000-0000-000000000000','人事','hr@x','active');
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('12512512-0000-0000-0000-000000000001','a1250001-0000-0000-0000-000000000000','finance'),
 ('12512512-0000-0000-0000-000000000001','a1250002-0000-0000-0000-000000000000','hr');

insert into public.gw_office_recurring_tasks(id,tenant_id,title,category,assignee_employee_id,recurrence_type,recurrence_rule,due_rule,source,source_key) values
 ('a125aaaa-0000-0000-0000-000000000001','12512512-0000-0000-0000-000000000001','10日振込予約','finance','a1250001-0000-0000-0000-000000000000','monthly','{"day":10,"shift":"prev"}','{"type":"same"}','excel','xl:Q|10日振込予約'),
 ('a125aaaa-0000-0000-0000-000000000002','12512512-0000-0000-0000-000000000001','年末調整','labor','a1250002-0000-0000-0000-000000000000','yearly','{"month":11,"day":10}','{"type":"offset","days":5}','manual',null);

select pg_temp.try('B1 the same Excel row cannot be imported twice',
  $q$insert into public.gw_office_recurring_tasks(tenant_id,title,category,recurrence_type,source,source_key) values ('12512512-0000-0000-0000-000000000001','x','finance','monthly','excel','xl:Q|10日振込予約')$q$, 'uq_gw_office_recurring_source');
select pg_temp.try('B2 unknown category is refused',
  $q$insert into public.gw_office_recurring_tasks(tenant_id,title,category,recurrence_type) values ('12512512-0000-0000-0000-000000000001','x','secret','monthly')$q$, 'gw_office_recurring_tasks_category_check');
select pg_temp.try('B3 unknown recurrence is refused',
  $q$insert into public.gw_office_recurring_tasks(tenant_id,title,category,recurrence_type) values ('12512512-0000-0000-0000-000000000001','x','finance','daily')$q$, 'gw_office_recurring_tasks_recurrence_type_check');
select pg_temp.try('B4 end before start is refused',
  $q$insert into public.gw_office_recurring_tasks(tenant_id,title,category,recurrence_type,start_on,end_on) values ('12512512-0000-0000-0000-000000000001','x','finance','monthly','2026-10-01','2026-09-01')$q$, 'gw_office_recurring_tasks_period');
select pg_temp.try('B5 empty title is refused',
  $q$insert into public.gw_office_recurring_tasks(tenant_id,title,category,recurrence_type) values ('12512512-0000-0000-0000-000000000001','','finance','monthly')$q$, 'gw_office_recurring_tasks_title_check');

insert into public.gw_office_calendar_events(id,tenant_id,recurring_task_id,title,category,event_date,due_on,status,source) values
 ('a125bbbb-0000-0000-0000-000000000001','12512512-0000-0000-0000-000000000001','a125aaaa-0000-0000-0000-000000000001','10日振込予約','finance','2026-10-09','2026-10-09','pending','recurring');
select pg_temp.try('C1 the same master and day twice is refused (no double generation)',
  $q$insert into public.gw_office_calendar_events(tenant_id,recurring_task_id,title,category,event_date,status,source) values ('12512512-0000-0000-0000-000000000001','a125aaaa-0000-0000-0000-000000000001','10日振込予約','finance','2026-10-09','pending','recurring')$q$, 'uq_gw_office_events_recurring');
select pg_temp.try('C2 another day of the same master is fine',
  $q$insert into public.gw_office_calendar_events(tenant_id,recurring_task_id,title,category,event_date,status,source) values ('12512512-0000-0000-0000-000000000001','a125aaaa-0000-0000-0000-000000000001','10日振込予約','finance','2026-11-10','pending','recurring')$q$, 'ok');
select pg_temp.try('C3 one-off events on the same day are fine (no master)',
  $q$insert into public.gw_office_calendar_events(tenant_id,title,category,event_date,status,source) values ('12512512-0000-0000-0000-000000000001','単発','finance','2026-10-09','pending','manual'), ('12512512-0000-0000-0000-000000000001','単発','finance','2026-10-09','pending','manual')$q$, 'ok');
select pg_temp.try('C4 the same Excel one-off row cannot be imported twice',
  $q$insert into public.gw_office_calendar_events(tenant_id,title,category,event_date,status,source,source_id) values ('12512512-0000-0000-0000-000000000001','a','finance','2025-10-20','pending','excel','xl:Q|a|2025-10-20'), ('12512512-0000-0000-0000-000000000001','a','finance','2025-10-20','pending','excel','xl:Q|a|2025-10-20')$q$, 'uq_gw_office_events_source');
select pg_temp.try('C5 done without completed_at is refused',
  $q$update public.gw_office_calendar_events set status='done' where id='a125bbbb-0000-0000-0000-000000000001'$q$, 'gw_office_calendar_events_done');
select pg_temp.try('C6 done with completed_at is fine',
  $q$update public.gw_office_calendar_events set status='done', completed_at=now(), completed_by='a1250001-0000-0000-0000-000000000000', completed_by_name='経理' where id='a125bbbb-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.try('C7 due before the event date is refused',
  $q$insert into public.gw_office_calendar_events(tenant_id,title,category,event_date,due_on,status,source) values ('12512512-0000-0000-0000-000000000001','x','finance','2026-10-09','2026-10-01','pending','manual')$q$, 'gw_office_calendar_events_due');
select pg_temp.try('C8 unknown status is refused',
  $q$insert into public.gw_office_calendar_events(tenant_id,title,category,event_date,status,source) values ('12512512-0000-0000-0000-000000000001','x','finance','2026-10-09','waiting','manual')$q$, 'gw_office_calendar_events_status_check');

-- RLS：ログインした人は直接読めない・書けない
select pg_temp.expect('D1 finance cannot read masters directly', pg_temp.count_as('a1250001-0000-0000-0000-000000000000','public.gw_office_recurring_tasks'), 0);
select pg_temp.expect('D2 hr cannot read events directly', pg_temp.count_as('a1250002-0000-0000-0000-000000000000','public.gw_office_calendar_events'), 0);
select pg_temp.try_as('D3 finance cannot insert a master directly', 'a1250001-0000-0000-0000-000000000000',
  $q$insert into public.gw_office_recurring_tasks(tenant_id,title,category,recurrence_type) values ('12512512-0000-0000-0000-000000000001','x','finance','monthly')$q$, 'row-level security');
select pg_temp.try_as('D4 finance cannot complete an event directly', 'a1250001-0000-0000-0000-000000000000',
  $q$do $d$ declare n int; begin update public.gw_office_calendar_events set status='skipped'; get diagnostics n = row_count; if n > 0 then raise exception 'updated %', n; end if; end $d$$q$, 'ok');

-- 確認用 SQL
select pg_temp.try('E1 check SQL runs', :'chk', 'ok');
select pg_temp.expect('E2 no duplicated events', (select count(*)::int from (select recurring_task_id, event_date from public.gw_office_calendar_events where recurring_task_id is not null group by 1,2 having count(*) > 1) d), 0);

-- 消したとき
delete from public.gw_employees where id = 'a1250002-0000-0000-0000-000000000000';
select pg_temp.expect('F1 deleting the assignee clears it (master kept)', (select count(*)::int from public.gw_office_recurring_tasks where id = 'a125aaaa-0000-0000-0000-000000000002' and assignee_employee_id is null), 1);
delete from public.gw_office_recurring_tasks where id = 'a125aaaa-0000-0000-0000-000000000001';
select pg_temp.expect('F2 events are kept when the master is deleted', (select count(*)::int from public.gw_office_calendar_events where title = '10日振込予約' and recurring_task_id is null), 2);
