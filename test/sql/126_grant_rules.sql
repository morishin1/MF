-- db/126_grant_rules.sql の、権限別シナリオ検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   経営者でない人事・管理者は、通常の業務の権限（hr / finance / manager / recruiter / sales）とアプリだけ付け外しできる。
--   IT・管理（it）・社労士（labor_advisor）・owner は経営者だけ。自分自身の行は、経営者でなければ付け外しできない。
--   キャリアの給与がある表（給与レンジ・評価の給与メモ）は、経営者だけが直接読める。
--   一般の社員・責任者は、これまでどおり何も書けない。
--
\set ON_ERROR_STOP 0
\set c092 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/092_career.sql"`
\set c119 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/119_app_grants.sql"`
\set c126 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/126_grant_rules.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_grant_rules.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;
-- 書けたら ok、RLS で止まったら 'row-level security'。delete・update は「0行」も止まった扱い（rows で数を返す）
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
create or replace function pg_temp.count_as(uid uuid, tbl text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  execute 'set local role authenticated';
  execute format('select count(*) from %s', tbl) into n;
  execute 'reset role';
  return n;
end $$;

select pg_temp.try('A0 092 applies', :'c092', 'ok');
select pg_temp.try('A0 119 applies', :'c119', 'ok');
-- Supabase は新しい表に authenticated の権限を自動で付ける（その代わり）
grant all on all tables in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

-- w1=経営者 w2=人事 w3=管理者（会計の staff） w4=責任者 w5=一般 w6=対象の社員
insert into public.tenants(id,name) values ('66666666-6666-6666-6666-666666666666','T6');
insert into auth.users(id,email) select ('a6a0000' || n || '-0000-0000-0000-000000000000')::uuid, 'g' || n || '@x' from generate_series(1,6) n;
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '66666666-6666-6666-6666-666666666666', u.id, split_part(u.email,'@',1), u.email, 'active' from auth.users u where u.email ~ '^g[1-6]@x$';
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000','owner'),
 ('66666666-6666-6666-6666-666666666666','a6a00002-0000-0000-0000-000000000000','hr'),
 ('66666666-6666-6666-6666-666666666666','a6a00004-0000-0000-0000-000000000000','manager'),
 ('66666666-6666-6666-6666-666666666666','a6a00006-0000-0000-0000-000000000000','it');
insert into public.memberships(tenant_id,user_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00003-0000-0000-0000-000000000000','staff');
insert into public.gw_app_grants(tenant_id,employee_id,app_key) values
 ('66666666-6666-6666-6666-666666666666','a6a00002-0000-0000-0000-000000000000','office');
-- キャリア（給与レンジ・給与メモ）
insert into public.gw_career_tracks(id,tenant_id,name) values ('a6c00000-0000-0000-0000-000000000001','66666666-6666-6666-6666-666666666666','エンジニア');
insert into public.gw_career_levels(tenant_id,track_id,level_no,level_name,salary_min,salary_max)
 values ('66666666-6666-6666-6666-666666666666','a6c00000-0000-0000-0000-000000000001',1,'L1',250000,300000);

-- 適用前：人事は IT・管理を付けられた（これを止める）
select pg_temp.try_as('B0 before 126: hr can grant it to others', 'a6a00002-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','it')$$, 'ok');
delete from public.gw_role_grants where employee_id = 'a6a00005-0000-0000-0000-000000000000';
select pg_temp.expect('B1 before 126: hr reads career levels (salary)', pg_temp.count_as('a6a00002-0000-0000-0000-000000000000','public.gw_career_levels'), 1);

select pg_temp.try('A1 126 applies', :'c126', 'ok');
select pg_temp.try('A2 126 applies again (idempotent)', :'c126', 'ok');
grant all on all tables in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

-- ---- 人事（w2）--------------------------------------------------------------
select pg_temp.try_as('H1 hr grants finance to others (allowed)', 'a6a00002-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','finance')$$, 'ok');
-- recruiter・sales は、この検証用の土台（db/005 の role の check）にまだ無いので、関数で確かめる
select pg_temp.try_as('H2 hr grants manager/hr to others (allowed)', 'a6a00002-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values
    ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','manager'),
    ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','hr')$$, 'ok');
select pg_temp.expect('H2b rule allows recruiter/sales for others, not for self',
  (select count(*)::int from (values ('recruiter'), ('sales')) r(x) where
     (select public.gw_can_grant_role('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000', r.x)
        from (select set_config('request.jwt.claim.sub','a6a00002-0000-0000-0000-000000000000', false)) _)
     and not (select public.gw_can_grant_role('66666666-6666-6666-6666-666666666666','a6a00002-0000-0000-0000-000000000000', r.x))), 2);
select pg_temp.try_as('H3 hr cannot grant it', 'a6a00002-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','it')$$, 'row-level security');
select pg_temp.try_as('H4 hr cannot grant labor_advisor', 'a6a00002-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','labor_advisor')$$, 'row-level security');
select pg_temp.try_as('H5 hr cannot grant owner', 'a6a00002-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','owner')$$, 'row-level security');
select pg_temp.try_as('H6 hr cannot grant finance to self', 'a6a00002-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00002-0000-0000-0000-000000000000','finance')$$, 'row-level security');
select pg_temp.expect('H7 hr cannot remove it from others (0 rows)', pg_temp.rows_as('a6a00002-0000-0000-0000-000000000000',
  $$delete from public.gw_role_grants where employee_id = 'a6a00006-0000-0000-0000-000000000000' and role = 'it'$$), 0);
select pg_temp.expect('H8 hr cannot remove own hr (0 rows)', pg_temp.rows_as('a6a00002-0000-0000-0000-000000000000',
  $$delete from public.gw_role_grants where employee_id = 'a6a00002-0000-0000-0000-000000000000' and role = 'hr'$$), 0);
select pg_temp.try_as('H9 hr cannot turn a finance row into it (update)', 'a6a00002-0000-0000-0000-000000000000',
  $$update public.gw_role_grants set role = 'it' where employee_id = 'a6a00005-0000-0000-0000-000000000000' and role = 'finance'$$, 'row-level security');
select pg_temp.try_as('H10 hr cannot move a grant onto self (update)', 'a6a00002-0000-0000-0000-000000000000',
  $$update public.gw_role_grants set employee_id = 'a6a00002-0000-0000-0000-000000000000' where employee_id = 'a6a00005-0000-0000-0000-000000000000' and role = 'finance'$$, 'row-level security');
select pg_temp.expect('H11 hr removes finance from others (1 row)', pg_temp.rows_as('a6a00002-0000-0000-0000-000000000000',
  $$delete from public.gw_role_grants where employee_id = 'a6a00005-0000-0000-0000-000000000000' and role = 'finance'$$), 1);
-- アプリ
select pg_temp.try_as('H12 hr grants office app to others (allowed)', 'a6a00002-0000-0000-0000-000000000000',
  $$insert into public.gw_app_grants(tenant_id,employee_id,app_key) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','office')$$, 'ok');
select pg_temp.try_as('H13 hr cannot grant apps to self', 'a6a00002-0000-0000-0000-000000000000',
  $$insert into public.gw_app_grants(tenant_id,employee_id,app_key) values ('66666666-6666-6666-6666-666666666666','a6a00002-0000-0000-0000-000000000000','sales')$$, 'row-level security');
select pg_temp.expect('H14 hr cannot remove own office app (0 rows)', pg_temp.rows_as('a6a00002-0000-0000-0000-000000000000',
  $$delete from public.gw_app_grants where employee_id = 'a6a00002-0000-0000-0000-000000000000'$$), 0);
-- キャリアの給与
select pg_temp.expect('H15 hr cannot read career levels (salary) directly', pg_temp.count_as('a6a00002-0000-0000-0000-000000000000','public.gw_career_levels'), 0);
select pg_temp.expect('H16 hr cannot read career reviews directly', pg_temp.count_as('a6a00002-0000-0000-0000-000000000000','public.gw_career_reviews'), 0);
select pg_temp.expect('H17 hr still reads career tracks (no salary)', pg_temp.count_as('a6a00002-0000-0000-0000-000000000000','public.gw_career_tracks'), 1);

-- ---- 管理者（w3：会計の staff ＝ 人事扱い）------------------------------------
select pg_temp.try_as('S1 staff grants manager to others (allowed)', 'a6a00003-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','finance')$$, 'ok');
select pg_temp.try_as('S2 staff cannot grant it', 'a6a00003-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00004-0000-0000-0000-000000000000','it')$$, 'row-level security');
select pg_temp.try_as('S3 staff cannot grant hr to self', 'a6a00003-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00003-0000-0000-0000-000000000000','hr')$$, 'row-level security');
select pg_temp.expect('S4 staff cannot read career levels directly', pg_temp.count_as('a6a00003-0000-0000-0000-000000000000','public.gw_career_levels'), 0);

-- ---- 責任者・一般（w4・w5）は、これまでどおり書けない -------------------------
select pg_temp.try_as('M1 manager cannot grant anything', 'a6a00004-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','sales')$$, 'row-level security');
select pg_temp.try_as('M2 member cannot grant apps', 'a6a00005-0000-0000-0000-000000000000',
  $$insert into public.gw_app_grants(tenant_id,employee_id,app_key) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','hr')$$, 'row-level security');

-- ---- 経営者（w1）は全部 -------------------------------------------------------
select pg_temp.try_as('O1 owner grants it', 'a6a00001-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00005-0000-0000-0000-000000000000','it')$$, 'ok');
select pg_temp.try_as('O2 owner grants labor_advisor', 'a6a00001-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00004-0000-0000-0000-000000000000','labor_advisor')$$, 'ok');
select pg_temp.try_as('O3 owner changes own roles', 'a6a00001-0000-0000-0000-000000000000',
  $$insert into public.gw_role_grants(tenant_id,employee_id,role) values ('66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000','finance')$$, 'ok');
select pg_temp.expect('O4 owner removes it from others (1 row)', pg_temp.rows_as('a6a00001-0000-0000-0000-000000000000',
  $$delete from public.gw_role_grants where employee_id = 'a6a00006-0000-0000-0000-000000000000' and role = 'it'$$), 1);
select pg_temp.try_as('O5 owner grants own app row', 'a6a00001-0000-0000-0000-000000000000',
  $$insert into public.gw_app_grants(tenant_id,employee_id,app_key) values ('66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000','hr')$$, 'ok');
select pg_temp.expect('O6 owner reads career levels', pg_temp.count_as('a6a00001-0000-0000-0000-000000000000','public.gw_career_levels'), 1);
-- 最後の owner は、これまでどおり外せない（db/099 のトリガ）
select pg_temp.try_as('O7 last owner still cannot be removed', 'a6a00001-0000-0000-0000-000000000000',
  $$delete from public.gw_role_grants where employee_id = 'a6a00001-0000-0000-0000-000000000000' and role = 'owner'$$, 'owner');

-- ---- 確認用 SQL（db/check_grant_rules.sql）が、適用後にすべて ✅ になる ----------
select pg_temp.try('C0 check sql runs', format('create temp table chk as %s', :'cchk'), 'ok');
select pg_temp.expect('C1 check sql: all 5 items ✅', (select count(*)::int from chk where 状態 = '✅'), 5);
select pg_temp.expect('C2 check sql: no ❌', (select count(*)::int from chk where 状態 = '❌'), 0);
