-- db/103_tool_access.sql の検証（実際の PostgreSQL で流す）。
--
-- ■ 何を確かめるか
--   ・db/101（給与の元の列を空にする）が済んでいないと、責任者を HR に加える前に止まる（何も変えない）
--   ・101 のあと、責任者は採用HRの表（応募者）を読める。給与は、どこにも見えない
--   ・HR は経営者・責任者・人事・採用担当。Sales・経理・一般・会計の管理者だけの人は読めない
--   ・Office は経営者・責任者・経理。人事・採用担当・営業・一般は含めない
--   ・もう一度流しても同じ（べき等）
\set ON_ERROR_STOP 0
\set c103 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/103_tool_access.sql"`
\set c101 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/101_hr_pay_clear.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;
create or replace function pg_temp.tool(uid uuid, fn text) returns int language plpgsql as $$
declare r boolean;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  execute format('select public.%I(%L::uuid)', fn, '77777777-7777-7777-7777-777777777777') into r;
  return case when r then 1 else 0 end;
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

insert into public.tenants(id,name) values ('77777777-7777-7777-7777-777777777777','T7');
insert into auth.users(id,email) select ('a7a0000' || n || '-0000-0000-0000-000000000000')::uuid, 'u' || n || '@x' from generate_series(1,9) n;
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '77777777-7777-7777-7777-777777777777', u.id, split_part(u.email,'@',1), u.email, 'active' from auth.users u where u.email like 'u%@x' and u.email ~ '^u[1-9]@x$';
-- u1=owner u2=hr u3=manager u4=recruiter u5=sales u6=finance u7=member u8=staff(admin) u9=it
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('77777777-7777-7777-7777-777777777777','a7a00001-0000-0000-0000-000000000000','owner'),
 ('77777777-7777-7777-7777-777777777777','a7a00002-0000-0000-0000-000000000000','hr'),
 ('77777777-7777-7777-7777-777777777777','a7a00003-0000-0000-0000-000000000000','manager'),
 ('77777777-7777-7777-7777-777777777777','a7a00004-0000-0000-0000-000000000000','recruiter');
insert into public.memberships(tenant_id,user_id,role) values ('77777777-7777-7777-7777-777777777777','a7a00008-0000-0000-0000-000000000000','staff');
-- 採用HRの表（給与つきの応募者。101 のあと、元の列は空になり、給与は gw_hr_pay へ）
insert into public.gw_hr_applicants(id,tenant_id,name,source,wage_type,wage_amount) values
 ('e7000000-0000-0000-0000-000000000001','77777777-7777-7777-7777-777777777777','候補者','リファラル','月給',500000);
insert into public.gw_hr_pay(tenant_id,applicant_id,wage_type,wage_amount) values ('77777777-7777-7777-7777-777777777777','e7000000-0000-0000-0000-000000000001','月給',500000);

-- 順序: 101 が済んでいない → 止まる。何も変わらない
select pg_temp.try('P1 103 stops before 101 is applied', :'c103', '責任者を採用HRに加える前に、db/101_hr_pay_clear.sql');
select pg_temp.expect('P1 manager is still not an HR user (nothing changed)', pg_temp.tool('a7a00003-0000-0000-0000-000000000000','gw_is_recruiting'), 0);

-- 101 を流す（給与は gw_hr_pay にあるので通る）
select pg_temp.try('P2 101 applies', :'c101', 'ok');
select pg_temp.try('P3 103 applies after 101', :'c103', 'ok');

-- HR: 経営者・責任者・人事・採用担当
select pg_temp.expect('H1 owner is HR',       pg_temp.tool('a7a00001-0000-0000-0000-000000000000','gw_is_recruiting'), 1);
select pg_temp.expect('H2 hr is HR',          pg_temp.tool('a7a00002-0000-0000-0000-000000000000','gw_is_recruiting'), 1);
select pg_temp.expect('H3 manager is HR',     pg_temp.tool('a7a00003-0000-0000-0000-000000000000','gw_is_recruiting'), 1);
select pg_temp.expect('H4 recruiter is HR',   pg_temp.tool('a7a00004-0000-0000-0000-000000000000','gw_is_recruiting'), 1);
select pg_temp.expect('H5 sales is not HR',   pg_temp.tool('a7a00005-0000-0000-0000-000000000000','gw_is_recruiting'), 0);
select pg_temp.expect('H6 finance is not HR', pg_temp.tool('a7a00006-0000-0000-0000-000000000000','gw_is_recruiting'), 0);
select pg_temp.expect('H7 member is not HR',  pg_temp.tool('a7a00007-0000-0000-0000-000000000000','gw_is_recruiting'), 0);
select pg_temp.expect('H8 accounting admin only is not HR', pg_temp.tool('a7a00008-0000-0000-0000-000000000000','gw_is_recruiting'), 0);

-- Office: 経営者・責任者・経理
select pg_temp.expect('O1 owner is Office',      pg_temp.tool('a7a00001-0000-0000-0000-000000000000','gw_is_office'), 1);
select pg_temp.expect('O2 manager is Office',    pg_temp.tool('a7a00003-0000-0000-0000-000000000000','gw_is_office'), 1);
select pg_temp.expect('O3 hr is not Office',     pg_temp.tool('a7a00002-0000-0000-0000-000000000000','gw_is_office'), 0);
select pg_temp.expect('O4 recruiter is not Office', pg_temp.tool('a7a00004-0000-0000-0000-000000000000','gw_is_office'), 0);
select pg_temp.expect('O5 sales is not Office',  pg_temp.tool('a7a00005-0000-0000-0000-000000000000','gw_is_office'), 0);
select pg_temp.expect('O6 accounting admin only is not Office', pg_temp.tool('a7a00008-0000-0000-0000-000000000000','gw_is_office'), 0);
insert into public.gw_role_grants(tenant_id,employee_id,role) values ('77777777-7777-7777-7777-777777777777','a7a00006-0000-0000-0000-000000000000','finance');
select pg_temp.expect('O7 finance is Office',    pg_temp.tool('a7a00006-0000-0000-0000-000000000000','gw_is_office'), 1);
select pg_temp.expect('O8 finance is still not HR', pg_temp.tool('a7a00006-0000-0000-0000-000000000000','gw_is_recruiting'), 0);

-- 経営: 経営者だけ
select pg_temp.expect('K1 owner is keiei',       pg_temp.tool('a7a00001-0000-0000-0000-000000000000','gw_is_owner'), 1);
select pg_temp.expect('K2 manager is not keiei', pg_temp.tool('a7a00003-0000-0000-0000-000000000000','gw_is_owner'), 0);
select pg_temp.expect('K3 hr is not keiei',      pg_temp.tool('a7a00002-0000-0000-0000-000000000000','gw_is_owner'), 0);
select pg_temp.expect('K4 accounting admin is not keiei', pg_temp.tool('a7a00008-0000-0000-0000-000000000000','gw_is_owner'), 0);
select pg_temp.expect('K5 finance is not keiei', pg_temp.tool('a7a00006-0000-0000-0000-000000000000','gw_is_owner'), 0);

-- 責任者は、採用HRの表（応募者）を読める。給与は、どこにも見えない
select pg_temp.expect('R1 manager reads applicants', pg_temp.count_as('a7a00003-0000-0000-0000-000000000000','public.gw_hr_applicants'), 1);
select pg_temp.expect('R2 manager sees no wage in the applicants table',
  (select count(*)::int from (select 1 from public.gw_hr_applicants where wage_amount is not null or wage_type is not null) x), 0);
select pg_temp.expect('R3 manager cannot read gw_hr_pay', pg_temp.count_as('a7a00003-0000-0000-0000-000000000000','public.gw_hr_pay'), 0);
select pg_temp.expect('R4 recruiter cannot read gw_hr_pay', pg_temp.count_as('a7a00004-0000-0000-0000-000000000000','public.gw_hr_pay'), 0);
select pg_temp.expect('R5 hr reads gw_hr_pay (stage 1)', pg_temp.count_as('a7a00002-0000-0000-0000-000000000000','public.gw_hr_pay'), 1);
select pg_temp.expect('R6 sales cannot read applicants', pg_temp.count_as('a7a00005-0000-0000-0000-000000000000','public.gw_hr_applicants'), 0);

-- もう一度流しても同じ
select pg_temp.try('I1 rerun is a no-op', :'c103', 'ok');
select pg_temp.expect('I1 manager is still HR', pg_temp.tool('a7a00003-0000-0000-0000-000000000000','gw_is_recruiting'), 1);
