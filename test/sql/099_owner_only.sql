-- db/099_owner_only.sql の、権限別シナリオ検証（実際の PostgreSQL で流す）。
--
-- ■ 何を確かめるか
--   管理者・人事が owner を付けられない／外せない／乗っ取れない。
--   最後の（在籍中の）owner は、削除・退職・降格のどれでも0人にできない。
--   owner の付与・剥奪が gw_activity_log に残る。テナントごとの削除は妨げない。
--
-- ■ 流し方
--   test/sql/run.sh（一時クラスタを立てて、スキーマ → 099 → このシナリオを流す）
--   結果は NOTICE で「PASS ...」「FAIL ...」と出る。FAIL が1つでもあれば失敗。
--
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(uid::text,''), false); end $$;

-- 固定ID
create temp table ids as select
  '11111111-1111-1111-1111-111111111111'::uuid t1,
  'a0000000-0000-0000-0000-000000000001'::uuid alice, 'b0000000-0000-0000-0000-000000000002'::uuid bob,
  'c0000000-0000-0000-0000-000000000003'::uuid carol, 'd0000000-0000-0000-0000-000000000004'::uuid dave,
  'e0000000-0000-0000-0000-000000000005'::uuid erin;
grant select on ids to authenticated;

insert into public.tenants(id,name) select t1,'T1' from ids;
insert into auth.users(id,email) select alice,'alice@x' from ids union all select bob,'bob@x' from ids union all select carol,'carol@x' from ids
  union all select dave,'dave@x' from ids union all select erin,'erin@x' from ids;
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
  select uid, (select t1 from ids), uid, n, n||'@x', 'active' from (
   select alice uid,'alice' n from ids union all select bob,'bob' from ids union all select carol,'carol' from ids
   union all select dave,'dave' from ids union all select erin,'erin' from ids) s;
insert into public.gw_role_grants(tenant_id,employee_id,role) select t1,alice,'owner' from ids
  union all select t1,carol,'hr' from ids union all select t1,dave,'manager' from ids;
insert into public.memberships(tenant_id,user_id,role) select t1,bob,'staff' from ids;

create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin
    execute stmt; ok := true;
  exception when others then msg := sqlerrm;
  end;
  if expect = 'ok' then
    raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else
    raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)');
  end if;
end $$;

set role authenticated;
-- T1: 人事(carol)が自分に owner を付ける → RLS で拒否
select pg_temp.as_user((select carol from ids));
select pg_temp.try('T1 hr grants owner to self', $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000003','owner')$$, 'row-level security');
-- T2: 管理者(bob=staff)が owner を付ける → 拒否 / manager を付ける → 許可
select pg_temp.as_user((select bob from ids));
select pg_temp.try('T2a staff grants owner to self', $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('11111111-1111-1111-1111-111111111111','b0000000-0000-0000-0000-000000000002','owner')$$, 'row-level security');
select pg_temp.try('T2b staff grants manager (allowed)', $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000005','manager')$$, 'ok');
-- T3: hr が role を owner に UPDATE で書き換える
select pg_temp.as_user((select carol from ids));
select pg_temp.try('T3 hr updates dave manager->owner', $$update public.gw_role_grants set role='owner' where employee_id='d0000000-0000-0000-0000-000000000004'$$, 'row-level security');
-- T4: hr が owner の行を削除（RLS で見えない＝0行、owner は残る）
select pg_temp.try('T4 hr deletes owner row (no-op)', $$delete from public.gw_role_grants where role='owner'$$, 'ok');
reset role;
select 'T4 owner row still exists: ' || (select count(*) from public.gw_role_grants where role='owner')::text as chk;

-- T5: hr が owner の user_id を自分にする → 拒否
set role authenticated; select pg_temp.as_user((select carol from ids));
select pg_temp.try('T5 hr rewrites owner user_id', $$update public.gw_employees set user_id='c0000000-0000-0000-0000-000000000003' where id='a0000000-0000-0000-0000-000000000001'$$, 'owner_only');
select pg_temp.try('T6 hr sets owner status=left', $$update public.gw_employees set status='left' where id='a0000000-0000-0000-0000-000000000001'$$, 'owner_only');
select pg_temp.try('T7 hr changes owner email', $$update public.gw_employees set email='evil@x' where id='a0000000-0000-0000-0000-000000000001'$$, 'owner_only');
select pg_temp.try('T8 hr deletes owner employee', $$delete from public.gw_employees where id='a0000000-0000-0000-0000-000000000001'$$, 'owner_only');
select pg_temp.try('T9 hr edits owner department (allowed)', $$update public.gw_employees set department='X' where id='a0000000-0000-0000-0000-000000000001'$$, 'ok');
-- 非owner社員は今まで通り編集できる
select pg_temp.try('T10 hr edits dave status (allowed)', $$update public.gw_employees set status='active', position='P' where id='d0000000-0000-0000-0000-000000000004'$$, 'ok');

-- T11: owner(alice) が erin に owner を付ける → 許可、履歴が残る
select pg_temp.as_user((select alice from ids));
select pg_temp.try('T11 owner grants owner to erin', $$insert into public.gw_role_grants(tenant_id,employee_id,role,granted_by) values ('11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000005','owner','a0000000-0000-0000-0000-000000000001')$$, 'ok');
reset role;
select 'T11 audit: ' || string_agg(action||'/'||coalesce(actor_id::text,'null'), ',') as chk from public.gw_activity_log where action like 'owner.%';

-- T12: 2人いる状態で alice が自分の owner を外す → 許可。1人になったら erin は外せない
set role authenticated; select pg_temp.as_user((select alice from ids));
select pg_temp.try('T12a owner alice revokes self while erin remains', $$delete from public.gw_role_grants where employee_id='a0000000-0000-0000-0000-000000000001' and role='owner'$$, 'ok');
reset role;
select 'T12 owners now: ' || string_agg(display_name, ',') as chk from public.gw_role_grants g join public.gw_employees e on e.id=g.employee_id where g.role='owner';
set role authenticated; select pg_temp.as_user((select erin from ids));
select pg_temp.try('T12b last owner erin revokes self', $$delete from public.gw_role_grants where employee_id='e0000000-0000-0000-0000-000000000005' and role='owner'$$, 'last_owner');
select pg_temp.try('T13 last owner erin sets self left', $$update public.gw_employees set status='left' where id='e0000000-0000-0000-0000-000000000005'$$, 'last_owner');
select pg_temp.try('T14 last owner erin deletes own employee', $$delete from public.gw_employees where id='e0000000-0000-0000-0000-000000000005'$$, 'last_owner');
reset role;
-- サービス側（auth.uid() が null）でも最後の owner は消せない
select pg_temp.as_user(null);
select pg_temp.try('T15 service deletes last owner grant', $$delete from public.gw_role_grants where role='owner'$$, 'last_owner');
select pg_temp.try('T16 service deletes last owner employee', $$delete from public.gw_employees where id='e0000000-0000-0000-0000-000000000005'$$, 'last_owner');
select pg_temp.try('T17 service demotes last owner role', $$update public.gw_role_grants set role='hr' where role='owner'$$, 'last_owner');
-- 復旧: 付けるのは止めない
select pg_temp.try('T18 service grants owner (recovery)', $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000001','owner')$$, 'ok');
-- 退職済みの owner は、外しても在籍数が減らない → 許可
update public.gw_employees set status='left' where id='a0000000-0000-0000-0000-000000000001';
select pg_temp.try('T19 revoke owner of a left employee (allowed)', $$delete from public.gw_role_grants where employee_id='a0000000-0000-0000-0000-000000000001' and role='owner'$$, 'ok');
-- T20: テナントごと消える cascade は止めない
insert into public.tenants(id,name) values ('22222222-2222-2222-2222-222222222222','T2');
insert into auth.users(id,email) values ('f0000000-0000-0000-0000-000000000006','f@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,status) values ('f0000000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','f0000000-0000-0000-0000-000000000006','f','active');
insert into public.gw_role_grants(tenant_id,employee_id,role) values ('22222222-2222-2222-2222-222222222222','f0000000-0000-0000-0000-000000000006','owner');
select pg_temp.try('T20 tenant delete cascades past guard', $$delete from public.tenants where id='22222222-2222-2222-2222-222222222222'$$, 'ok');
