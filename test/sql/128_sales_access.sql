-- db/128_sales_access_align.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（gw_app_grants・gw_has_app）が無い DB では、128 は何も変えずにエラーで止まる（フェイルクローズ）
--   ・適用前は API と DB の判定がずれている（アプリ権限だけの人は DB で止まり、ロールだけの人は DB を通る）
--   ・適用後は「owner ロール または Sales のアプリ権限」の人だけが gw_sales_* を読み書きできる
--     （PostgREST を直接呼ぶのと同じ条件＝ authenticated ロール＋JWT の sub で確かめる）
--   ・退職者・他テナントの人・権限の無い社員・anon は読めない・書けない
--   ・実行時に判定の部品が無ければ拒否になる（行を返さない）
--   ・戻す SQL（rollback）で元の判定に戻り、もう一度 128 を流しても同じ（べき等）
--   ・確認 SQL（db/check_128_sales_access.sql）に ❌ が出ない
--
\set ON_ERROR_STOP 0
\set c088 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/088_sales.sql"`
\set c094 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/094_recruit_sales_roles.sql"`
\set c119 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/119_app_grants.sql"`
\set c120 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/120_left_gate.sql"`
\set c128 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/128_sales_access_align.sql"`
\set crb `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_128_sales_access.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_128_sales_access.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.expect_true(label text, got boolean) returns void language plpgsql as $$
begin raise notice '% : %', case when coalesce(got, false) then 'PASS' else 'FAIL' end || ' ' || label, coalesce(got::text, 'null'); end $$;
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;
-- PostgREST と同じ条件（authenticated ロール＋JWT の sub）で実行する
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
create or replace function pg_temp.rows_as(uid uuid, stmt text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  execute 'set local role authenticated';
  execute stmt;
  get diagnostics n = row_count;
  execute 'reset role';
  return n;
end $$;
create or replace function pg_temp.count_as(uid uuid, src text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  execute 'set local role authenticated';
  execute format('select count(*) from %s', src) into n;
  execute 'reset role';
  return n;
end $$;
create or replace function pg_temp.count_anon(src text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set local role anon';
  execute format('select count(*) from %s', src) into n;
  execute 'reset role';
  return n;
end $$;
create or replace function pg_temp.is_sales_def() returns text language sql as $$
  select coalesce(pg_get_functiondef(to_regprocedure('public.gw_is_sales(uuid)')), '') $$;
create or replace function pg_temp.check_fails(sql text) returns int language plpgsql as $$
declare n int;
begin execute format('select count(*) from (%s) x where x."状態" = %L', sql, '❌') into n; return n; end $$;

do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; end $$;
grant usage on schema public, auth to anon;

-- ---------------------------------------------------------------------------
-- A. Sales（088・094）だけの DB：前提（119 の gw_app_grants・gw_has_app）が無い
-- ---------------------------------------------------------------------------
select pg_temp.try('A0 088 applies', :'c088', 'ok');
select pg_temp.try('A0 094 applies', :'c094', 'ok');
select pg_temp.try('A1 128 は前提が無ければエラーで止まる（フェイルクローズ）', :'c128', 'gw_app_grants');
select pg_temp.expect_true('A2 止まったときは gw_is_sales を変えていない（ロール判定のまま）',
  pg_temp.is_sales_def() ilike '%''manager''%' and pg_temp.is_sales_def() not ilike '%gw_has_app%');

select pg_temp.try('A3 119 applies', :'c119', 'ok');
select pg_temp.try('A3 120 applies', :'c120', 'ok');
grant all on all tables in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;
grant select on all tables in schema public to anon;

-- ---------------------------------------------------------------------------
-- 人とデータ
--   T8 の社員：s1 経営者 / s2 責任者＋Salesアプリ / s3 sales ロールだけ / s4 Salesアプリだけ
--              s5 manager ロールだけ / s6 退職者（sales ロール＋Salesアプリ） / s8 権限なし
--   T9 の社員：s7 経営者＋Salesアプリ（他テナント）
-- ---------------------------------------------------------------------------
insert into public.tenants(id, name) values
  ('88888888-8888-8888-8888-888888888888', 'T8'), ('99999999-9999-9999-9999-999999999999', 'T9');
insert into auth.users(id, email)
  select ('a8a0000' || n || '-0000-0000-0000-000000000000')::uuid, 's' || n || '@x' from generate_series(1, 8) n;
insert into public.gw_employees(id, tenant_id, user_id, display_name, email, status)
  select u.id,
         case when u.email = 's7@x' then '99999999-9999-9999-9999-999999999999'::uuid else '88888888-8888-8888-8888-888888888888'::uuid end,
         u.id, split_part(u.email, '@', 1), u.email,
         case when u.email = 's6@x' then 'left' else 'active' end
    from auth.users u where u.email ~ '^s[1-8]@x$';
insert into public.gw_role_grants(tenant_id, employee_id, role) values
  ('88888888-8888-8888-8888-888888888888', 'a8a00001-0000-0000-0000-000000000000', 'owner'),
  ('88888888-8888-8888-8888-888888888888', 'a8a00002-0000-0000-0000-000000000000', 'manager'),
  ('88888888-8888-8888-8888-888888888888', 'a8a00003-0000-0000-0000-000000000000', 'sales'),
  ('88888888-8888-8888-8888-888888888888', 'a8a00005-0000-0000-0000-000000000000', 'manager'),
  ('88888888-8888-8888-8888-888888888888', 'a8a00006-0000-0000-0000-000000000000', 'sales'),
  ('99999999-9999-9999-9999-999999999999', 'a8a00007-0000-0000-0000-000000000000', 'owner');
insert into public.gw_app_grants(tenant_id, employee_id, app_key) values
  ('88888888-8888-8888-8888-888888888888', 'a8a00002-0000-0000-0000-000000000000', 'sales'),
  ('88888888-8888-8888-8888-888888888888', 'a8a00004-0000-0000-0000-000000000000', 'sales'),
  ('88888888-8888-8888-8888-888888888888', 'a8a00006-0000-0000-0000-000000000000', 'sales'),
  ('99999999-9999-9999-9999-999999999999', 'a8a00007-0000-0000-0000-000000000000', 'sales');
insert into public.gw_sales_companies(id, tenant_id, name, domain) values
  ('c8000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', 'T8 一社', 'one.example'),
  ('c8000000-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888', 'T8 二社', 'two.example'),
  ('c9000000-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999999', 'T9 一社', 'nine.example');

-- ---------------------------------------------------------------------------
-- B. 128 の前（094 のロール判定）：API とずれている
-- ---------------------------------------------------------------------------
select pg_temp.expect('B1 128 の前：sales ロールだけの人は DB を通る（API では止まる）',
  pg_temp.count_as('a8a00003-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 2);
select pg_temp.expect('B2 128 の前：Sales アプリだけの人は DB で止まる（API は通る）',
  pg_temp.count_as('a8a00004-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 0);

-- ---------------------------------------------------------------------------
-- C. 128 を適用
-- ---------------------------------------------------------------------------
select pg_temp.try('C0 128 applies', :'c128', 'ok');
select pg_temp.try('C0 128 は2回流しても同じ（べき等）', :'c128', 'ok');
select pg_temp.expect_true('C1 gw_is_sales は owner ロール または Sales アプリ',
  pg_temp.is_sales_def() ilike '%gw_has_role(p_tenant, ''owner'')%' and pg_temp.is_sales_def() ilike '%gw_has_app(p_tenant, ''sales'')%'
  and pg_temp.is_sales_def() not ilike '%''manager''%');

-- 読む（T8 の企業は2社）
select pg_temp.expect('C2 経営者は読める', pg_temp.count_as('a8a00001-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 2);
select pg_temp.expect('C3 責任者＋Salesアプリは読める', pg_temp.count_as('a8a00002-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 2);
select pg_temp.expect('C4 sales ロールだけ（アプリ権限なし）は読めない', pg_temp.count_as('a8a00003-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 0);
select pg_temp.expect('C5 Sales アプリだけは読める', pg_temp.count_as('a8a00004-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 2);
select pg_temp.expect('C6 manager ロールだけ（アプリ権限なし）は読めない', pg_temp.count_as('a8a00005-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 0);
select pg_temp.expect('C7 退職者（ロール・アプリが残っていても）は読めない', pg_temp.count_as('a8a00006-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 0);
select pg_temp.expect('C8 他テナントの経営者には T8 の企業は見えない',
  pg_temp.count_as('a8a00007-0000-0000-0000-000000000000', 'public.gw_sales_companies where tenant_id = ''88888888-8888-8888-8888-888888888888'''), 0);
select pg_temp.expect('C8 他テナントの経営者は自分のテナントだけ見える',
  pg_temp.count_as('a8a00007-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 1);
select pg_temp.expect('C9 権限の無い社員は読めない', pg_temp.count_as('a8a00008-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 0);
select pg_temp.expect('C9 ログインしていない（JWT なし）は読めない', pg_temp.count_as(null, 'public.gw_sales_companies'), 0);
select pg_temp.expect('C9 anon は読めない', pg_temp.count_anon('public.gw_sales_companies'), 0);
select pg_temp.expect('C10 sales ロールだけの人はアタック記録も読めない',
  pg_temp.count_as('a8a00003-0000-0000-0000-000000000000', 'public.gw_sales_approaches'), 0);

-- 書く
select pg_temp.try_as('D1 Sales アプリだけの人は企業を足せる', 'a8a00004-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_companies(tenant_id, name, domain) values ('88888888-8888-8888-8888-888888888888', 'アプリだけが追加', 'app.example')$q$, 'ok');
select pg_temp.expect('D2 Sales アプリだけの人は更新できる',
  pg_temp.rows_as('a8a00004-0000-0000-0000-000000000000',
    $q$update public.gw_sales_companies set note = 'x' where id = 'c8000000-0000-0000-0000-000000000001'$q$), 1);
select pg_temp.try_as('D3 sales ロールだけの人は企業を足せない', 'a8a00003-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_companies(tenant_id, name, domain) values ('88888888-8888-8888-8888-888888888888', 'ロールだけ', 'role.example')$q$, 'row-level security');
select pg_temp.expect('D4 manager ロールだけの人は更新できない（0行）',
  pg_temp.rows_as('a8a00005-0000-0000-0000-000000000000',
    $q$update public.gw_sales_companies set note = 'y' where id = 'c8000000-0000-0000-0000-000000000001'$q$), 0);
select pg_temp.try_as('D5 退職者は企業を足せない', 'a8a00006-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_companies(tenant_id, name, domain) values ('88888888-8888-8888-8888-888888888888', '退職者', 'left.example')$q$, 'row-level security');
select pg_temp.try_as('D6 他テナントの経営者は T8 に企業を足せない', 'a8a00007-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_companies(tenant_id, name, domain) values ('88888888-8888-8888-8888-888888888888', '他社から', 'other.example')$q$, 'row-level security');
select pg_temp.expect('D7 他テナントの経営者は T8 の企業を消せない（0行）',
  pg_temp.rows_as('a8a00007-0000-0000-0000-000000000000',
    $q$delete from public.gw_sales_companies where id = 'c8000000-0000-0000-0000-000000000002'$q$), 0);

-- 確認 SQL に ❌ が出ない
select pg_temp.expect('E1 db/check_128_sales_access.sql に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);

-- ---------------------------------------------------------------------------
-- F. 実行時に判定の部品が読めなければ拒否（行を返さない）
-- ---------------------------------------------------------------------------
alter table public.gw_app_grants rename to gw_app_grants_moved;
select pg_temp.try_as('F1 gw_app_grants が無いときは読めない（エラー＝拒否）', 'a8a00004-0000-0000-0000-000000000000',
  'select count(*) from public.gw_sales_companies', 'gw_app_grants');
alter table public.gw_app_grants_moved rename to gw_app_grants;

-- ---------------------------------------------------------------------------
-- G. 戻す（rollback）→ もう一度 128
-- ---------------------------------------------------------------------------
select pg_temp.try('G1 rollback applies', :'crb', 'ok');
select pg_temp.expect('G2 戻すと sales ロールだけの人がまた読める（元の判定）',
  pg_temp.count_as('a8a00003-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 3);
select pg_temp.expect('G2 戻すと Sales アプリだけの人はまた読めない',
  pg_temp.count_as('a8a00004-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 0);
select pg_temp.expect('G3 戻した状態では確認 SQL に ❌ が出る', (pg_temp.check_fails(:'cchk') > 0)::int, 1);
select pg_temp.try('G4 128 をもう一度 applies', :'c128', 'ok');
select pg_temp.expect('G5 もう一度流すと Sales アプリだけの人が読める',
  pg_temp.count_as('a8a00004-0000-0000-0000-000000000000', 'public.gw_sales_companies'), 3);
select pg_temp.expect('G6 もう一度流したあとも確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
