-- db/102_contracts_pay_rls.sql の検証。gw_contracts は本物（db/029）ではなく、賃金の列だけを持つ代用の表で確かめる。
--
-- ■ 何を確かめるか
--   ・029 の最初の RLS（責任者を含む gw_is_internal_staff）のままだと、責任者が賃金を読める
--   ・102 のあと、責任者・採用担当は読めない。人事・管理者・経営者と、本人（自分の分だけ）は読める
--   ・段階2（gw_can_see_salary を経営者だけに）で、人事・管理者も読めなくなる（本人は読める）
--   ・gw_contracts が無い環境では、何もしない
\set ON_ERROR_STOP 0
\set root `echo "$SCEN_ROOT"`
create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.count_as(uid uuid, tbl text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  execute 'set local role authenticated';
  execute format('select count(*) from %s', tbl) into n;
  execute 'reset role';
  return n;
end $$;

-- gw_contracts が無い環境では、何もしない（エラーにならない）
\i :root/db/102_contracts_pay_rls.sql
select pg_temp.expect('N1 without gw_contracts: 102 does nothing and does not fail', 1, 1);

insert into public.tenants(id,name) values ('66666666-6666-6666-6666-666666666666','T6');
insert into auth.users(id,email) values
 ('a6a00000-0000-0000-0000-000000000001','owner6@x'), ('a6a00000-0000-0000-0000-000000000002','hr6@x'),
 ('a6a00000-0000-0000-0000-000000000003','staff6@x'), ('a6a00000-0000-0000-0000-000000000004','recruiter6@x'),
 ('a6a00000-0000-0000-0000-000000000005','manager6@x'), ('a6a00000-0000-0000-0000-000000000007','member6@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '66666666-6666-6666-6666-666666666666', u.id, split_part(u.email,'@',1), u.email, 'active'
   from auth.users u where u.email like '%6@x';
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('66666666-6666-6666-6666-666666666666','a6a00000-0000-0000-0000-000000000001','owner'),
 ('66666666-6666-6666-6666-666666666666','a6a00000-0000-0000-0000-000000000002','hr'),
 ('66666666-6666-6666-6666-666666666666','a6a00000-0000-0000-0000-000000000004','recruiter'),
 ('66666666-6666-6666-6666-666666666666','a6a00000-0000-0000-0000-000000000005','manager');
insert into public.memberships(tenant_id,user_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00000-0000-0000-0000-000000000003','staff');

-- 029 のころの状態を再現する: 責任者を含む gw_is_internal_staff（代用）と、それを使う RLS
create table public.gw_contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  wage_type text, wage_amount numeric
);
create or replace function public.gw_is_internal_staff() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.gw_role_grants g join public.gw_employees e on e.id = g.employee_id
                  where e.user_id = auth.uid() and g.role in ('owner','hr','manager')) or exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.role in ('admin','staff')) $$;
alter table public.gw_contracts enable row level security;
create policy gw_contracts_select on public.gw_contracts for select to authenticated
  using (public.gw_is_internal_staff() or employee_id = public.gw_employee_id(tenant_id));
grant all on public.gw_contracts to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;
insert into public.gw_contracts(tenant_id,employee_id,wage_type,wage_amount) values
 ('66666666-6666-6666-6666-666666666666','a6a00000-0000-0000-0000-000000000007','月給',250000);

select pg_temp.expect('B1 (before 102) manager CAN read contracts', pg_temp.count_as('a6a00000-0000-0000-0000-000000000005','public.gw_contracts'), 1);

\i :root/db/102_contracts_pay_rls.sql

select pg_temp.expect('A1 owner reads contracts',     pg_temp.count_as('a6a00000-0000-0000-0000-000000000001','public.gw_contracts'), 1);
select pg_temp.expect('A2 hr reads contracts',        pg_temp.count_as('a6a00000-0000-0000-0000-000000000002','public.gw_contracts'), 1);
select pg_temp.expect('A3 staff(admin) reads contracts', pg_temp.count_as('a6a00000-0000-0000-0000-000000000003','public.gw_contracts'), 1);
select pg_temp.expect('A4 manager cannot read contracts', pg_temp.count_as('a6a00000-0000-0000-0000-000000000005','public.gw_contracts'), 0);
select pg_temp.expect('A5 recruiter cannot read contracts', pg_temp.count_as('a6a00000-0000-0000-0000-000000000004','public.gw_contracts'), 0);
select pg_temp.expect('A6 the person reads their own contract', pg_temp.count_as('a6a00000-0000-0000-0000-000000000007','public.gw_contracts'), 1);

-- 段階2: gw_can_see_salary を経営者だけに。人事・管理者も読めなくなる。本人は自分の分を読める
create or replace function public.gw_can_see_salary(p_tenant uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.gw_is_owner(p_tenant) $$;
select pg_temp.expect('S2 owner reads contracts',     pg_temp.count_as('a6a00000-0000-0000-0000-000000000001','public.gw_contracts'), 1);
select pg_temp.expect('S2 hr cannot read contracts',  pg_temp.count_as('a6a00000-0000-0000-0000-000000000002','public.gw_contracts'), 0);
select pg_temp.expect('S2 staff(admin) cannot read contracts', pg_temp.count_as('a6a00000-0000-0000-0000-000000000003','public.gw_contracts'), 0);
select pg_temp.expect('S2 the person still reads their own', pg_temp.count_as('a6a00000-0000-0000-0000-000000000007','public.gw_contracts'), 1);

-- もう一度流しても同じ
\i :root/db/102_contracts_pay_rls.sql
select pg_temp.expect('I1 rerun keeps the policy (stage 2 still applies via the function)', pg_temp.count_as('a6a00000-0000-0000-0000-000000000002','public.gw_contracts'), 0);
