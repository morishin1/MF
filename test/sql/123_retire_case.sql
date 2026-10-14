-- db/123_retire_case.sql（退職手続きの1画面：退職日の編集・返却・サービス別アカウント・記録）の検証。実際の PostgreSQL で流す。
--
-- ■ 何を確かめるか
--   ・前提（008 入退社・011 貸与品・121 退職書類）の上に、2回流しても同じ（べき等）
--   ・3つの表は、人事（gw_is_hr）だけが読める。一般メンバー・他社の人事は読めない。誰も（人事でも）直接は書けない
--   ・gw_retire_set_dates は、一般のユーザー（authenticated）から呼べない
--   ・退職日・最終出勤日・担当者を保存し、変更前→変更後を記録する。在籍状態（status）は変えない
--   ・入退社の手続きの退社日・未完了の項目の期限が、退職日に合う（済んだ項目の期限は変えない）
--   ・画面が読んだ後に名簿が更新されていたら（更新日時が違う）、保存しない（retire_conflict）
--   ・最終出勤日が退職日より後なら保存しない。他社の人・他社の担当者は扱えない
--   ・返却・アカウントの記録の制約（返却済みには日時が要る・停止済には日時が要る・同じ貸与品は1行）
\set ON_ERROR_STOP 0
\set root `echo "$SCEN_ROOT"`
\set c123 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/123_retire_case.sql"`

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

-- 前提の SQL（入退社・貸与品・退職書類）
\i :root/db/008_onboarding.sql
\i :root/db/011_assets_templates.sql
\i :root/db/121_retire_docs.sql

select pg_temp.try('A1 123 applies', :'c123', 'ok');
select pg_temp.try('A2 123 applies again (idempotent)', :'c123', 'ok');
grant all on all tables in schema public to authenticated, service_role;

insert into public.tenants(id,name) values ('12312312-0000-0000-0000-000000000001','T1'), ('12312312-0000-0000-0000-000000000002','T2');
insert into auth.users(id,email) values
 ('a1230001-0000-0000-0000-000000000000','hr@x'), ('a1230002-0000-0000-0000-000000000000','leaver@x'),
 ('a1230003-0000-0000-0000-000000000000','member@x'), ('b1230001-0000-0000-0000-000000000000','other-hr@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status,left_on,updated_at) values
 ('a1230001-0000-0000-0000-000000000000','12312312-0000-0000-0000-000000000001','a1230001-0000-0000-0000-000000000000','人事','hr@x','active',null,'2026-10-01 00:00:00+00'),
 ('a1230002-0000-0000-0000-000000000000','12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000','退職','leaver@x','leaving','2026-10-31','2026-10-01 01:02:03.456789+00'),
 ('a1230003-0000-0000-0000-000000000000','12312312-0000-0000-0000-000000000001','a1230003-0000-0000-0000-000000000000','一般','member@x','active',null,'2026-10-01 00:00:00+00'),
 ('b1230001-0000-0000-0000-000000000000','12312312-0000-0000-0000-000000000002','b1230001-0000-0000-0000-000000000000','他社人事','other-hr@x','active',null,'2026-10-01 00:00:00+00');
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('12312312-0000-0000-0000-000000000001','a1230001-0000-0000-0000-000000000000','hr'),
 ('12312312-0000-0000-0000-000000000002','b1230001-0000-0000-0000-000000000000','hr');
insert into public.gw_procedures(id,tenant_id,employee_id,kind,target_on) values
 ('a123aaaa-0000-0000-0000-000000000001','12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000','offboarding','2026-10-31');
insert into public.gw_procedure_items(tenant_id,procedure_id,title,owner,status,due_on) values
 ('12312312-0000-0000-0000-000000000001','a123aaaa-0000-0000-0000-000000000001','PCの返却','hr','todo','2026-10-31'),
 ('12312312-0000-0000-0000-000000000001','a123aaaa-0000-0000-0000-000000000001','済んだ項目','hr','done','2026-10-20');

-- 保存（正しい更新日時）
select pg_temp.try('D1 save dates with the read timestamps',
  $q$select public.gw_retire_set_dates('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000','a1230001-0000-0000-0000-000000000000','人事',
     '2026-11-15','2026-11-10','a1230001-0000-0000-0000-000000000000','2026-10-01 01:02:03.456789+00',null)$q$, 'ok');
select pg_temp.expect('D2 left_on is saved', (select count(*)::int from public.gw_employees where id = 'a1230002-0000-0000-0000-000000000000' and left_on = '2026-11-15'), 1);
select pg_temp.expect('D3 status is NOT changed (still leaving)', (select count(*)::int from public.gw_employees where id = 'a1230002-0000-0000-0000-000000000000' and status = 'leaving'), 1);
select pg_temp.expect('D4 last_work_on / owner are saved', (select count(*)::int from public.gw_retire_cases where employee_id = 'a1230002-0000-0000-0000-000000000000' and last_work_on = '2026-11-10' and owner_employee_id = 'a1230001-0000-0000-0000-000000000000'), 1);
select pg_temp.expect('D5 the offboarding target date follows', (select count(*)::int from public.gw_procedures where id = 'a123aaaa-0000-0000-0000-000000000001' and target_on = '2026-11-15'), 1);
select pg_temp.expect('D6 open items follow / done items keep their date', (select count(*)::int from public.gw_procedure_items where (title = 'PCの返却' and due_on = '2026-11-15') or (title = '済んだ項目' and due_on = '2026-10-20')), 2);
select pg_temp.expect('D7 the change is recorded (from → to)', (select count(*)::int from public.gw_retire_events where kind = 'dates.update'
   and detail->'leftOn'->>'from' = '2026-10-31' and detail->'leftOn'->>'to' = '2026-11-15' and actor_name = '人事'), 1);

-- 競合：古い更新日時のまま、もう一度保存
select pg_temp.try('C1 stale employee timestamp is refused',
  $q$select public.gw_retire_set_dates('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000',null,'x',
     '2026-12-01',null,null,'2026-10-01 01:02:03.456789+00',(select updated_at from public.gw_retire_cases where employee_id='a1230002-0000-0000-0000-000000000000'))$q$, 'retire_conflict');
select pg_temp.try('C2 stale case timestamp (null when a row exists) is refused',
  $q$select public.gw_retire_set_dates('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000',null,'x',
     '2026-12-01',null,null,(select updated_at from public.gw_employees where id='a1230002-0000-0000-0000-000000000000'),null)$q$, 'retire_conflict');
select pg_temp.expect('C3 nothing was overwritten', (select count(*)::int from public.gw_employees where id = 'a1230002-0000-0000-0000-000000000000' and left_on = '2026-11-15'), 1);
select pg_temp.try('V1 last work day after the leave day is refused',
  $q$select public.gw_retire_set_dates('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000',null,'x',
     '2026-11-15','2026-11-20',null,(select updated_at from public.gw_employees where id='a1230002-0000-0000-0000-000000000000'),
     (select updated_at from public.gw_retire_cases where employee_id='a1230002-0000-0000-0000-000000000000'))$q$, 'retire_last_after_left');
select pg_temp.try('V2 another tenant''s employee is not found',
  $q$select public.gw_retire_set_dates('12312312-0000-0000-0000-000000000002','a1230002-0000-0000-0000-000000000000',null,'x','2026-11-15',null,null,now(),null)$q$, 'retire_not_found');
select pg_temp.try('V3 an owner from another tenant is refused',
  $q$select public.gw_retire_set_dates('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000',null,'x',
     '2026-11-15',null,'b1230001-0000-0000-0000-000000000000',(select updated_at from public.gw_employees where id='a1230002-0000-0000-0000-000000000000'),
     (select updated_at from public.gw_retire_cases where employee_id='a1230002-0000-0000-0000-000000000000'))$q$, 'retire_bad_owner');
select pg_temp.try_as('V4 an ordinary user cannot call the function', 'a1230001-0000-0000-0000-000000000000',
  $q$select public.gw_retire_set_dates('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000',null,'x','2026-11-15',null,null,now(),null)$q$, 'permission denied');

-- 返却・アカウントの記録
insert into public.gw_assets(id,tenant_id,kind,name,assigned_to,status) values
 ('a123bbbb-0000-0000-0000-000000000001','12312312-0000-0000-0000-000000000001','pc','MacBook 01','a1230002-0000-0000-0000-000000000000','assigned');
select pg_temp.try('R1 a return request row', $q$insert into public.gw_retire_asset_returns(tenant_id,employee_id,asset_id,asset_kind,asset_name,state,requested_at,due_on)
  values ('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000','a123bbbb-0000-0000-0000-000000000001','pc','MacBook 01','requested',now(),'2026-11-15')$q$, 'ok');
select pg_temp.try('R2 the same asset twice for the same person is refused', $q$insert into public.gw_retire_asset_returns(tenant_id,employee_id,asset_id,asset_kind,asset_name,state)
  values ('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000','a123bbbb-0000-0000-0000-000000000001','pc','MacBook 01','requested')$q$, 'duplicate key');
select pg_temp.try('R3 returned needs a time', $q$update public.gw_retire_asset_returns set state = 'returned' where asset_id = 'a123bbbb-0000-0000-0000-000000000001'$q$, 'returned_needs_time');
select pg_temp.try('R4 deleting the asset keeps what was returned (asset_id becomes null)', $q$delete from public.gw_assets where id = 'a123bbbb-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.expect('R5 ...the name is still there', (select count(*)::int from public.gw_retire_asset_returns where asset_id is null and asset_name = 'MacBook 01'), 1);
select pg_temp.try('S1 stopped needs a time', $q$insert into public.gw_retire_accounts(tenant_id,employee_id,service,state)
  values ('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000','slack','stopped')$q$, 'stopped_needs_time');
select pg_temp.try('S2 only the manual services', $q$insert into public.gw_retire_accounts(tenant_id,employee_id,service,state)
  values ('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000','lms','active')$q$, 'check');
select pg_temp.try('S3 a manual record', $q$insert into public.gw_retire_accounts(tenant_id,employee_id,service,state,stopped_at)
  values ('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000','slack','stopped',now())$q$, 'ok');

-- 読める人・書ける人
select pg_temp.expect('P1 hr reads the events', pg_temp.count_as('a1230001-0000-0000-0000-000000000000','public.gw_retire_events'), 1);
select pg_temp.expect('P2 hr reads the returns', pg_temp.count_as('a1230001-0000-0000-0000-000000000000','public.gw_retire_asset_returns'), 1);
select pg_temp.expect('P3 hr reads the accounts', pg_temp.count_as('a1230001-0000-0000-0000-000000000000','public.gw_retire_accounts'), 1);
select pg_temp.expect('P4 a member reads nothing', pg_temp.count_as('a1230003-0000-0000-0000-000000000000','public.gw_retire_events')
  + pg_temp.count_as('a1230003-0000-0000-0000-000000000000','public.gw_retire_asset_returns') + pg_temp.count_as('a1230003-0000-0000-0000-000000000000','public.gw_retire_accounts'), 0);
select pg_temp.expect('P5 the leaver reads nothing', pg_temp.count_as('a1230002-0000-0000-0000-000000000000','public.gw_retire_events'), 0);
select pg_temp.expect('P6 another tenant''s hr reads nothing', pg_temp.count_as('b1230001-0000-0000-0000-000000000000','public.gw_retire_events')
  + pg_temp.count_as('b1230001-0000-0000-0000-000000000000','public.gw_retire_accounts'), 0);
select pg_temp.try_as('W1 hr cannot insert an event directly', 'a1230001-0000-0000-0000-000000000000',
  $q$insert into public.gw_retire_events(tenant_id,employee_id,kind) values ('12312312-0000-0000-0000-000000000001','a1230002-0000-0000-0000-000000000000','asset.return')$q$, 'row-level security');
select pg_temp.try_as('W2 hr cannot change an account record directly', 'a1230001-0000-0000-0000-000000000000',
  $q$update public.gw_retire_accounts set state = 'active', stopped_at = null$q$, 'ok');
select pg_temp.expect('W3 ...and nothing changed (no update policy)', (select count(*)::int from public.gw_retire_accounts where state = 'stopped'), 1);
select pg_temp.try_as('W4 hr cannot delete events directly', 'a1230001-0000-0000-0000-000000000000', $q$delete from public.gw_retire_events$q$, 'ok');
select pg_temp.expect('W5 ...and the events are still there', (select count(*)::int from public.gw_retire_events), 1);
