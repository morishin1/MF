-- db/105_compensation.sql の検証（実際の PostgreSQL で流す）。
--
-- ■ 何を確かめるか
--   ・給与の履歴は追記だけ: 変更・削除・全消しができない（SQL Editor と同じ、権限の高い接続でも）
--   ・訂正は、同じ適用開始日の「次の版」。版と種別（初回・変更・訂正）がずれない
--   ・金額・種別・手当の形・理由を、DB でも検査する
--   ・記録を足すと、監査ログが自動で残る（API を通らなくても）。監査ログも追記だけ
--   ・見られる人: 経営者だけ。本人は自分の行だけ。人事・管理者・責任者・他の社員は 0 件。書き込みのポリシーは無い
--   ・社員は削除できない（履歴を残す）。テナントごと消えるときだけ、一緒に消える
--   ・もう一度流しても同じ（べき等）
\set ON_ERROR_STOP 0
\set c105 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/105_compensation.sql"`

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

insert into public.tenants(id,name) values ('55555555-5555-5555-5555-555555555555','T5');
insert into auth.users(id,email) select ('a5a0000' || n || '-0000-0000-0000-000000000000')::uuid, 'w' || n || '@x' from generate_series(1,7) n;
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '55555555-5555-5555-5555-555555555555', u.id, split_part(u.email,'@',1), u.email, 'active' from auth.users u where u.email ~ '^w[1-7]@x$';
-- w1=owner w2=hr w3=manager w4=admin(staff) w5=本人（給与を記録される人） w6=他の社員 w7=記録の無い社員
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('55555555-5555-5555-5555-555555555555','a5a00001-0000-0000-0000-000000000000','owner'),
 ('55555555-5555-5555-5555-555555555555','a5a00002-0000-0000-0000-000000000000','hr'),
 ('55555555-5555-5555-5555-555555555555','a5a00003-0000-0000-0000-000000000000','manager');
insert into public.memberships(tenant_id,user_id,role) values ('55555555-5555-5555-5555-555555555555','a5a00004-0000-0000-0000-000000000000','staff');

select pg_temp.try('A1 105 applies', :'c105', 'ok');
select pg_temp.try('A2 105 applies again (idempotent)', :'c105', 'ok');
grant all on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- ---- 記録を足す（サーバ＝権限の高い接続）----------------------------------------
select pg_temp.try('R1 initial record', $q$
  insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,allowances,commute_amount,kind,source,reason,created_by,created_by_name)
  values ('55555555-5555-5555-5555-555555555555','a5a00005-0000-0000-0000-000000000000','2026-04-01',1,'月給',300000,
          '[{"name":"役職手当","amount":20000}]',10000,'initial','contract_import','入社時の契約から','a5a00001-0000-0000-0000-000000000000','経営者')$q$, 'ok');
select pg_temp.try('R2 change from a later date', $q$
  insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,allowances,commute_amount,kind,reason,before,created_by,created_by_name)
  values ('55555555-5555-5555-5555-555555555555','a5a00005-0000-0000-0000-000000000000','2026-10-01',1,'月給',320000,'[{"name":"役職手当","amount":20000}]',10000,'change','定期昇給',
          '{"baseAmount":300000}','a5a00001-0000-0000-0000-000000000000','経営者')$q$, 'ok');
select pg_temp.try('R3 correction = next revision at the same date', $q$
  insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,allowances,commute_amount,kind,reason,before,created_by,created_by_name)
  values ('55555555-5555-5555-5555-555555555555','a5a00005-0000-0000-0000-000000000000','2026-10-01',2,'月給',330000,'[{"name":"役職手当","amount":20000}]',10000,'correction','入力ミスの訂正（320,000→330,000）',
          '{"baseAmount":320000}','a5a00001-0000-0000-0000-000000000000','経営者')$q$, 'ok');
select pg_temp.expect('R4 the earlier revisions are still there (history is kept)', (select count(*)::int from public.gw_compensations where employee_id='a5a00005-0000-0000-0000-000000000000'), 3);

-- ---- 監査ログが自動で残る -------------------------------------------------------
select pg_temp.expect('L1 audit written by trigger: 3 rows', (select count(*)::int from public.gw_pay_audit where action in ('create','correct')), 3);
select pg_temp.expect('L2 the correction is logged as correct', (select count(*)::int from public.gw_pay_audit where action = 'correct'), 1);
select pg_temp.expect('L3 audit has the actor and reason (no amounts)', (select count(*)::int from public.gw_pay_audit where actor_name = '経営者' and detail ->> 'reason' is not null and detail::text !~ '[0-9]{5,}'), 3);
select pg_temp.try('L4 a plain SQL insert (no created_by) is audited as db', $q$
  insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,kind,reason)
  values ('55555555-5555-5555-5555-555555555555','a5a00007-0000-0000-0000-000000000000','2026-05-01',1,'時給',1500,'initial','SQL から')$q$, 'ok');
select pg_temp.expect('L5 ...and the actor is recorded as db', (select count(*)::int from public.gw_pay_audit where actor_name = 'db'), 1);

-- ---- 検査（DB でも）---------------------------------------------------------------
select pg_temp.try('C1 negative base amount', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',-1,'initial','x')$q$, 'check constraint');
select pg_temp.try('C2 wage type outside the list', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','その他',1,'initial','x')$q$, 'check constraint');
select pg_temp.try('C3 allowance without a name', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,allowances,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',1,'[{"name":"","amount":1}]','initial','x')$q$, 'check constraint');
select pg_temp.try('C4 allowance with a negative amount', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,allowances,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',1,'[{"name":"住宅手当","amount":-5}]','initial','x')$q$, 'check constraint');
select pg_temp.try('C5 allowances that is not an array', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,allowances,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',1,'{"name":"x","amount":1}','initial','x')$q$, 'check constraint');
select pg_temp.try('C6 more than 20 allowances', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,allowances,kind,reason) select '55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',1,(select jsonb_agg(jsonb_build_object('name','手当'||g,'amount',1)) from generate_series(1,21) g),'initial','x'$q$, 'check constraint');
select pg_temp.try('C7 blank reason', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',1,'initial','   ')$q$, 'check constraint');
select pg_temp.try('C8 negative commute', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,commute_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',1,-1,'initial','x')$q$, 'check constraint');
select pg_temp.try('C9 a change with revision 2 (must be a correction)', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01',2,'月給',1,'change','x')$q$, 'check constraint');
select pg_temp.try('C10 a correction with revision 1', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01',1,'月給',1,'correction','x')$q$, 'check constraint');
select pg_temp.try('C11 the same (employee, date, revision) twice', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00005-0000-0000-0000-000000000000','2026-10-01',2,'月給',1,'correction','x')$q$, 'duplicate key');
select pg_temp.try('C12 unknown source', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,kind,source,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',1,'initial','csv','x')$q$, 'check constraint');
select pg_temp.expect('C13 none of the rejected rows got in', (select count(*)::int from public.gw_compensations where employee_id='a5a00006-0000-0000-0000-000000000000'), 0);

-- ---- 追記だけ ---------------------------------------------------------------------
select pg_temp.try('I1 update a record', $q$update public.gw_compensations set base_amount = 1 where employee_id='a5a00005-0000-0000-0000-000000000000'$q$, 'immutable');
select pg_temp.try('I2 update the reason', $q$update public.gw_compensations set reason = '書き換え'$q$, 'immutable');
select pg_temp.try('I3 delete a record', $q$delete from public.gw_compensations where employee_id='a5a00005-0000-0000-0000-000000000000'$q$, 'immutable');
select pg_temp.try('I4 delete all', $q$delete from public.gw_compensations$q$, 'immutable');
select pg_temp.try('I5 truncate', $q$truncate public.gw_compensations$q$, 'immutable');
select pg_temp.try('I6 update the audit log', $q$update public.gw_pay_audit set actor_name = '別人'$q$, 'immutable');
select pg_temp.try('I7 delete the audit log', $q$delete from public.gw_pay_audit$q$, 'immutable');
select pg_temp.try('I8 truncate the audit log', $q$truncate public.gw_pay_audit$q$, 'immutable');
select pg_temp.expect('I9 nothing changed', (select count(*)::int from public.gw_compensations where base_amount in (300000, 320000, 330000)), 3);

-- ---- 見られる人 -------------------------------------------------------------------
select pg_temp.expect('V1 owner reads all rows (4)', pg_temp.count_as('a5a00001-0000-0000-0000-000000000000','public.gw_compensations'), 4);
select pg_temp.expect('V2 the person reads only their own rows (3)', pg_temp.count_as('a5a00005-0000-0000-0000-000000000000','public.gw_compensations'), 3);
select pg_temp.expect('V3 hr reads none', pg_temp.count_as('a5a00002-0000-0000-0000-000000000000','public.gw_compensations'), 0);
select pg_temp.expect('V4 manager reads none', pg_temp.count_as('a5a00003-0000-0000-0000-000000000000','public.gw_compensations'), 0);
select pg_temp.expect('V5 admin (staff) reads none', pg_temp.count_as('a5a00004-0000-0000-0000-000000000000','public.gw_compensations'), 0);
select pg_temp.expect('V6 another employee reads none', pg_temp.count_as('a5a00006-0000-0000-0000-000000000000','public.gw_compensations'), 0);
select pg_temp.expect('V7 the employee with a db-inserted record reads only their own (1)', pg_temp.count_as('a5a00007-0000-0000-0000-000000000000','public.gw_compensations'), 1);
select pg_temp.expect('V8 owner reads the audit log (4)', pg_temp.count_as('a5a00001-0000-0000-0000-000000000000','public.gw_pay_audit'), 4);
select pg_temp.expect('V9 the person cannot read the audit log', pg_temp.count_as('a5a00005-0000-0000-0000-000000000000','public.gw_pay_audit'), 0);
select pg_temp.expect('V10 hr / manager / admin cannot read the audit log',
  pg_temp.count_as('a5a00002-0000-0000-0000-000000000000','public.gw_pay_audit') + pg_temp.count_as('a5a00003-0000-0000-0000-000000000000','public.gw_pay_audit') + pg_temp.count_as('a5a00004-0000-0000-0000-000000000000','public.gw_pay_audit'), 0);

-- ---- 書けるのは、サーバだけ（ブラウザからは、経営者でも書けない）----------------------
select pg_temp.try_as('W1 owner cannot insert from the browser', 'a5a00001-0000-0000-0000-000000000000', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',1,'initial','x')$q$, 'row-level security');
select pg_temp.try_as('W2 hr cannot insert from the browser', 'a5a00002-0000-0000-0000-000000000000', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00006-0000-0000-0000-000000000000','2026-06-01','月給',1,'initial','x')$q$, 'row-level security');
select pg_temp.try_as('W3 the person cannot insert their own raise', 'a5a00005-0000-0000-0000-000000000000', $q$insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,kind,reason) values ('55555555-5555-5555-5555-555555555555','a5a00005-0000-0000-0000-000000000000','2026-11-01',1,'月給',999999,'change','自分で')$q$, 'row-level security');
select pg_temp.try_as('W4 owner cannot write the audit log from the browser', 'a5a00001-0000-0000-0000-000000000000', $q$insert into public.gw_pay_audit(tenant_id,action) values ('55555555-5555-5555-5555-555555555555','view_list')$q$, 'row-level security');
select pg_temp.expect('W5 nothing got in', (select count(*)::int from public.gw_compensations) , 4);

-- ---- 社員は消せない・テナントごとなら消える ----------------------------------------
select pg_temp.try('E1 deleting an employee that has a pay history is refused', $q$delete from public.gw_employees where id='a5a00005-0000-0000-0000-000000000000'$q$, 'foreign key');
select pg_temp.try('E2 deleting an employee without a pay history is fine', $q$delete from public.gw_employees where id='a5a00006-0000-0000-0000-000000000000'$q$, 'ok');
insert into public.tenants(id,name) values ('66666666-6666-6666-6666-666666666666','T6');
insert into auth.users(id,email) values ('a6a00001-0000-0000-0000-000000000000','z1@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status) values ('a6a00001-0000-0000-0000-000000000000','66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000','z1','z1@x','active');
insert into public.gw_compensations(tenant_id,employee_id,effective_from,wage_type,base_amount,kind,reason) values ('66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000','2026-04-01','月給',200000,'initial','x');
select pg_temp.try('E3 deleting a whole tenant removes its history with it (the only exception)', $q$delete from public.tenants where id='66666666-6666-6666-6666-666666666666'$q$, 'ok');
select pg_temp.expect('E4 ...records and audit of that tenant are gone', (select count(*)::int from public.gw_compensations where tenant_id='66666666-6666-6666-6666-666666666666') + (select count(*)::int from public.gw_pay_audit where tenant_id='66666666-6666-6666-6666-666666666666'), 0);
select pg_temp.expect('E5 ...and the other tenant is untouched', (select count(*)::int from public.gw_compensations where tenant_id='55555555-5555-5555-5555-555555555555'), 4);
