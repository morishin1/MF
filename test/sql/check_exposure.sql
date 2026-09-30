-- db/check_salary_exposure.sql（本番で最初に流す、読み取りだけの確認）が、実際の PostgreSQL で動き、
-- 適用状況を正しく言い当てることを確かめる。
--
-- ■ 何を確かめるか
--   ・そのまま流せる（構文・関数・表なしの扱い）。何も書き換えない
--   ・101・102・103・104・105 を流す前は「未適用」、流したあとは「適用済み」と出る（099・100 は、流した状態から始まる）
--   ・流したあとの給与の件数の行（元の列に残る給与）が 0
\set ON_ERROR_STOP 0
\set body `cat "$SCEN_ROOT/db/check_salary_exposure.sql"`
\set c101 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/101_hr_pay_clear.sql"`
\set c102 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/102_contracts_pay_rls.sql"`
\set c103 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/103_tool_access.sql"`
\set c104 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/104_onboarding_guide.sql"`
\set c105 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/105_compensation.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.state_of(prefix text) returns text language plpgsql as $$
declare r text;
begin
  select "状態" into r from exp where "項目" like prefix || '%' and "区分" = 'A. 適用状況' limit 1;
  return r;
end $$;

-- 029 のころの契約の表（代用。賃金の列と、責任者を含む RLS）。本番には、この形の表がある
create table public.gw_contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  wage_type text, wage_amount numeric
);
alter table public.gw_contracts enable row level security;
create policy gw_contracts_select on public.gw_contracts for select to authenticated
  using (public.gw_is_hr(tenant_id) or employee_id = public.gw_employee_id(tenant_id));

-- 1回目: 099・100 だけ
create temp table exp as :body;
select pg_temp.expect('E1 the script returns rows', (select case when count(*) > 20 then 1 else 0 end from exp), 1);
select pg_temp.expect('E2 099 is applied', (select case when pg_temp.state_of('099') like '✅%' then 1 else 0 end), 1);
select pg_temp.expect('E3 100 is applied', (select case when pg_temp.state_of('100') like '✅%' then 1 else 0 end), 1);
select pg_temp.expect('E3b 035 (contracts limited to HR) is applied', (select case when pg_temp.state_of('035') like '✅%' then 1 else 0 end), 1);
select pg_temp.expect('E4 101 is NOT applied yet', (select case when pg_temp.state_of('101') like '❌%' then 1 else 0 end), 1);
select pg_temp.expect('E5 102 is NOT applied yet', (select case when pg_temp.state_of('102') like '❌%' then 1 else 0 end), 1);
select pg_temp.expect('E6 103 is NOT applied yet', (select case when pg_temp.state_of('103') like '❌%' then 1 else 0 end), 1);
select pg_temp.expect('E7 104 is NOT applied yet', (select case when pg_temp.state_of('104') like '❌%' then 1 else 0 end), 1);
select pg_temp.expect('E7b 105 is NOT applied yet', (select case when pg_temp.state_of('105') like '❌%' then 1 else 0 end), 1);
select pg_temp.expect('E8 the check wrote nothing (no new tables from it)', (select count(*)::int from pg_tables where schemaname = 'public' and tablename like 'gw_onboarding%'), 0);

-- 流す（安全装置を通るよう、101 → 102 → 103 → 104）
:c101
:c102
:c103
:c104
:c105

drop table exp;
create temp table exp as :body;
select pg_temp.expect('F1 101 is applied', (select case when pg_temp.state_of('101') like '✅%' then 1 else 0 end), 1);
select pg_temp.expect('F1b 035 stays "applied" after 102 (the condition is stricter, not gone)', (select case when pg_temp.state_of('035') like '✅%' then 1 else 0 end), 1);
select pg_temp.expect('F2 102 is applied', (select case when pg_temp.state_of('102') like '✅%' then 1 else 0 end), 1);
select pg_temp.expect('F3 103 is applied', (select case when pg_temp.state_of('103') like '✅%' then 1 else 0 end), 1);
select pg_temp.expect('F4 104 is applied', (select case when pg_temp.state_of('104') like '✅%' then 1 else 0 end), 1);
select pg_temp.expect('F4b 105 is applied', (select case when pg_temp.state_of('105') like '✅%' then 1 else 0 end), 1);
select pg_temp.expect('F5 no wage is left in the old columns (applicants)', (select regexp_replace("状態", '[^0-9]', '', 'g')::int from exp where "項目" like '応募者の元の列%'), 0);
select pg_temp.expect('F6 no wage is left in the old columns (offers)', (select regexp_replace("状態", '[^0-9]', '', 'g')::int from exp where "項目" like '合格通知の元の列%'), 0);
