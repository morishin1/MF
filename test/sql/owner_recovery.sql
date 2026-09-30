-- docs/keiei-owner-recovery.md の緊急復旧 SQL を、文書のまま流して確かめる。
--
-- ■ 何を確かめるか
--   ・2-A（認証アプリを失った）: 認証の登録とセッションが消え、再登録の窓（gw_mfa_resets）と操作の記録が残る
--   ・2-C（経営者が誰もいない）: 在籍中の人に owner を付け直せる。記録が残る（db/099 のトリガが止めるのは、消す・変えるだけ）
--   ・4（復旧のあとの確認）: 読み取りの SQL が、エラーなく動く
--   Supabase の auth スキーマは、この手順が触る表だけの代用品（本物にもある表・列）
\set ON_ERROR_STOP 0
\set blocks `echo "$SCEN_BLOCKS"`
\set c071 `sed -n '/create table if not exists public.gw_mfa_resets/,/create index if not exists idx_gw_mfa_resets_user/p' "$SCEN_ROOT/db/071_onboarding_stage2.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;

create table if not exists auth.mfa_factors(id uuid primary key default gen_random_uuid(), user_id uuid, factor_type text, status text, created_at timestamptz default now());
create table if not exists auth.sessions(id uuid primary key default gen_random_uuid(), user_id uuid);
:c071 on public.gw_mfa_resets(user_id, reset_at desc);

insert into public.tenants(id,name) values ('99999999-9999-9999-9999-999999999999','T9');
insert into auth.users(id,email) values ('a9000001-0000-0000-0000-000000000000','owner@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 values ('a9000001-0000-0000-0000-000000000000','99999999-9999-9999-9999-999999999999','a9000001-0000-0000-0000-000000000000','経営者','owner@x','active');
insert into public.gw_role_grants(tenant_id,employee_id,role) values ('99999999-9999-9999-9999-999999999999','a9000001-0000-0000-0000-000000000000','owner');
insert into auth.mfa_factors(user_id,factor_type,status) values ('a9000001-0000-0000-0000-000000000000','totp','verified');
insert into auth.sessions(user_id) values ('a9000001-0000-0000-0000-000000000000');

-- 2-A の前: 認証もセッションもある
select pg_temp.expect('B1 before: the owner has a verified factor', (select count(*)::int from auth.mfa_factors), 1);

-- 2-C の前に、経営者が0人の状態にする（ふつうは止まるので、トリガを外して再現する。復旧の前提の状態）
alter table public.gw_role_grants disable trigger user;
delete from public.gw_role_grants where role = 'owner';
alter table public.gw_role_grants enable trigger user;
select pg_temp.expect('B2 no owner left (the state 2-C recovers from)', (select count(*)::int from public.gw_role_grants where role = 'owner'), 0);

-- 文書の SQL を、そのまま流す（2-A → 2-C → 4）
\i :blocks

select pg_temp.expect('A1 2-A removed the factor', (select count(*)::int from auth.mfa_factors where user_id = 'a9000001-0000-0000-0000-000000000000'), 0);
select pg_temp.expect('A2 2-A ended the sessions', (select count(*)::int from auth.sessions where user_id = 'a9000001-0000-0000-0000-000000000000'), 0);
select pg_temp.expect('A3 2-A opened the re-enrollment window (7 days)',
  (select count(*)::int from public.gw_mfa_resets where user_id = 'a9000001-0000-0000-0000-000000000000' and used_at is null and expires_at > now() + interval '6 days'), 1);
select pg_temp.expect('A4 2-A left a record', (select count(*)::int from public.gw_activity_log where action = 'owner.break_glass_mfa_reset'), 1);
select pg_temp.expect('C1 2-C granted owner again', (select count(*)::int from public.gw_role_grants where role = 'owner' and employee_id = 'a9000001-0000-0000-0000-000000000000'), 1);
select pg_temp.expect('C2 2-C left a record', (select count(*)::int from public.gw_activity_log where action = 'owner.break_glass_grant'), 1);
select pg_temp.expect('C3 2-C is idempotent (no duplicate owner row)', (select count(*)::int from public.gw_role_grants where role = 'owner'), 1);
