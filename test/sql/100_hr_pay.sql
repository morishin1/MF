-- db/100_hr_pay.sql の、権限別シナリオ検証（実際の PostgreSQL で流す）。
--
-- ■ 何を確かめるか
--   応募者・合格通知の給与（gw_hr_pay）は、給与を見られる人（人事・管理者・経営者）だけが読める。
--   採用担当・責任者・経理・営業・一般は、採用HRの表（応募者）が読めても、給与は読めない。
--   ブラウザ（authenticated）からは書き込めない。いまの給与が、写されている。
--   段階2（gw_can_see_salary を経営者だけに差し替える）で、人事・管理者も読めなくなる。
--
-- ■ 流し方: test/sql/run.sh（結果は NOTICE の PASS / FAIL）
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(uid::text,''), false); end $$;

create or replace function pg_temp.count_as(uid uuid, tbl text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  execute 'set local role authenticated';
  execute format('select count(*) from %s', tbl) into n;
  execute 'reset role';
  return n;
end $$;

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;

create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;

-- テナント・社員・権限
insert into public.tenants(id,name) values ('44444444-4444-4444-4444-444444444444','T4');
insert into auth.users(id,email) values
 ('a1a00000-0000-0000-0000-000000000001','owner@x'), ('a1a00000-0000-0000-0000-000000000002','hr@x'),
 ('a1a00000-0000-0000-0000-000000000003','staff@x'), ('a1a00000-0000-0000-0000-000000000004','recruiter@x'),
 ('a1a00000-0000-0000-0000-000000000005','manager@x'), ('a1a00000-0000-0000-0000-000000000006','sales@x'),
 ('a1a00000-0000-0000-0000-000000000007','member@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '44444444-4444-4444-4444-444444444444', u.id, split_part(u.email,'@',1), u.email, 'active'
   from auth.users u where u.email in ('owner@x','hr@x','staff@x','recruiter@x','manager@x','sales@x','member@x');
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('44444444-4444-4444-4444-444444444444','a1a00000-0000-0000-0000-000000000001','owner'),
 ('44444444-4444-4444-4444-444444444444','a1a00000-0000-0000-0000-000000000002','hr'),
 ('44444444-4444-4444-4444-444444444444','a1a00000-0000-0000-0000-000000000004','recruiter'),
 ('44444444-4444-4444-4444-444444444444','a1a00000-0000-0000-0000-000000000005','manager');
insert into public.memberships(tenant_id,user_id,role) values ('44444444-4444-4444-4444-444444444444','a1a00000-0000-0000-0000-000000000003','staff');

-- 応募者・合格通知（給与つき）と、100 のあとに足した行
insert into public.gw_hr_applicants(id,tenant_id,name,source,wage_type,wage_amount) values
 ('c2000000-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444','候補者','リファラル','月給',500000);
insert into public.gw_hr_offers(id,tenant_id,applicant_id,version,wage_type,wage_amount,token_hash,expires_at) values
 ('d2000000-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444','c2000000-0000-0000-0000-000000000001',1,'月給',500000,'hh1',now()+interval '1 day');

-- 移行の確認: 100 をもう一度流すと、あとから入った給与つきの行が写される（足りない行だけ）
select pg_temp.expect('M1 backfill copies applicant + offer wage (rerun adds 2 rows)',
  (select count(*)::int from public.gw_hr_pay where tenant_id = '44444444-4444-4444-4444-444444444444'), 0);
insert into public.gw_hr_pay (tenant_id, applicant_id, offer_id, wage_type, wage_amount)
select a.tenant_id, a.id, null, a.wage_type, a.wage_amount from public.gw_hr_applicants a
 where a.tenant_id = '44444444-4444-4444-4444-444444444444' and (a.wage_type is not null or a.wage_amount is not null)
   and not exists (select 1 from public.gw_hr_pay p where p.applicant_id = a.id and p.offer_id is null);
insert into public.gw_hr_pay (tenant_id, applicant_id, offer_id, wage_type, wage_amount)
select o.tenant_id, o.applicant_id, o.id, o.wage_type, o.wage_amount from public.gw_hr_offers o
 where o.tenant_id = '44444444-4444-4444-4444-444444444444' and (o.wage_type is not null or o.wage_amount is not null)
   and not exists (select 1 from public.gw_hr_pay p where p.offer_id = o.id);
select pg_temp.expect('M2 backfill rows present',
  (select count(*)::int from public.gw_hr_pay where tenant_id = '44444444-4444-4444-4444-444444444444'), 2);

-- 段階1: 人事・管理者・経営者は読める。採用担当・責任者・営業・一般は読めない
select pg_temp.expect('S1 owner reads pay',      pg_temp.count_as('a1a00000-0000-0000-0000-000000000001','public.gw_hr_pay'), 2);
select pg_temp.expect('S1 hr reads pay',         pg_temp.count_as('a1a00000-0000-0000-0000-000000000002','public.gw_hr_pay'), 2);
select pg_temp.expect('S1 staff(admin) reads pay', pg_temp.count_as('a1a00000-0000-0000-0000-000000000003','public.gw_hr_pay'), 2);
select pg_temp.expect('S1 recruiter cannot read pay', pg_temp.count_as('a1a00000-0000-0000-0000-000000000004','public.gw_hr_pay'), 0);
select pg_temp.expect('S1 manager cannot read pay',   pg_temp.count_as('a1a00000-0000-0000-0000-000000000005','public.gw_hr_pay'), 0);
select pg_temp.expect('S1 sales cannot read pay',     pg_temp.count_as('a1a00000-0000-0000-0000-000000000006','public.gw_hr_pay'), 0);
select pg_temp.expect('S1 member cannot read pay',    pg_temp.count_as('a1a00000-0000-0000-0000-000000000007','public.gw_hr_pay'), 0);

-- 採用担当は、応募者の表そのものは読める（採用HRの業務）。給与は、その表の列ではなくなる（101 のあと）
select pg_temp.expect('R1 recruiter still reads applicants', pg_temp.count_as('a1a00000-0000-0000-0000-000000000004','public.gw_hr_applicants'), 1);

-- ブラウザ（authenticated）からは書き込めない
set role authenticated; select pg_temp.as_user('a1a00000-0000-0000-0000-000000000001');
select pg_temp.try('W1 owner cannot insert pay from the browser', $$insert into public.gw_hr_pay(tenant_id,applicant_id,wage_type,wage_amount) values ('44444444-4444-4444-4444-444444444444','c2000000-0000-0000-0000-000000000001','月給',1)$$, 'row-level security');
select pg_temp.try('W2 owner cannot update pay from the browser (no rows visible-to-write)', $$update public.gw_hr_pay set wage_amount = 1$$, 'ok');
reset role;
select pg_temp.expect('W2 pay unchanged', (select count(*)::int from public.gw_hr_pay where wage_amount = 1), 0);

-- 応募者を消すと、給与も消える（cascade）
insert into public.gw_hr_applicants(id,tenant_id,name,source,wage_type,wage_amount) values
 ('c2000000-0000-0000-0000-000000000009','44444444-4444-4444-4444-444444444444','消す人','リファラル','月給',1);
insert into public.gw_hr_pay(tenant_id,applicant_id,wage_type,wage_amount) values ('44444444-4444-4444-4444-444444444444','c2000000-0000-0000-0000-000000000009','月給',1);
delete from public.gw_hr_applicants where id = 'c2000000-0000-0000-0000-000000000009';
select pg_temp.expect('C1 deleting an applicant removes its pay',
  (select count(*)::int from public.gw_hr_pay where applicant_id = 'c2000000-0000-0000-0000-000000000009'), 0);

-- 1応募者に「現在の条件」は1行、1版に1行（二重に入らない）
select pg_temp.try('U1 one current-terms row per applicant', $$insert into public.gw_hr_pay(tenant_id,applicant_id,wage_type,wage_amount) values ('44444444-4444-4444-4444-444444444444','c2000000-0000-0000-0000-000000000001','月給',2)$$, 'uq_gw_hr_pay_applicant');
select pg_temp.try('U2 one row per offer version', $$insert into public.gw_hr_pay(tenant_id,applicant_id,offer_id,wage_type,wage_amount) values ('44444444-4444-4444-4444-444444444444','c2000000-0000-0000-0000-000000000001','d2000000-0000-0000-0000-000000000001','月給',2)$$, 'uq_gw_hr_pay_offer');

-- 段階2: gw_can_see_salary を経営者だけに差し替えると、人事・管理者も読めなくなる
create or replace function public.gw_can_see_salary(p_tenant uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.gw_is_owner(p_tenant) $$;
select pg_temp.expect('S2 owner still reads pay',   pg_temp.count_as('a1a00000-0000-0000-0000-000000000001','public.gw_hr_pay'), 2);
select pg_temp.expect('S2 hr cannot read pay',      pg_temp.count_as('a1a00000-0000-0000-0000-000000000002','public.gw_hr_pay'), 0);
select pg_temp.expect('S2 staff(admin) cannot read pay', pg_temp.count_as('a1a00000-0000-0000-0000-000000000003','public.gw_hr_pay'), 0);
select pg_temp.expect('S2 recruiter cannot read pay', pg_temp.count_as('a1a00000-0000-0000-0000-000000000004','public.gw_hr_pay'), 0);
