-- db/127_retire_cert_requests.sql（退職証明書の本人申請）の検証。実際の PostgreSQL で流す（test/sql/run.sh）。
--
-- ■ 何を確かめるか
--   ・前提（121 退職書類）の上に、2回流しても同じ（べき等）
--   ・ログインした人（本人・人事・経営者）は、直接は読めない・書けない（RLS・ポリシーなし。読み書きは API だけ）
--   ・記載項目は5つのうち1つ以上・決まった鍵だけ。誓約の文面・版・同意日時は必須
--   ・申請中は1人1件。発行済み・取り下げのあとは、もう一度申請できる
--   ・申請中は決定日時なし、発行済み・取り下げは決定日時あり
--   ・確認用 SQL（db/check_retire_cert_requests.sql）が、流す前は ❌・表なし（エラーにならない）、流したあとは全部 ✅
\set ON_ERROR_STOP 0
\set root `echo "$SCEN_ROOT"`
\set c127 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/127_retire_cert_requests.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_retire_cert_requests.sql"`

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

\i :root/db/121_retire_docs.sql

-- 流す前：確認用 SQL はエラーにならず、❌・表なし
select pg_temp.try('C0 check sql runs before 127', format('create temp table chk0 as %s', :'cchk'), 'ok');
select pg_temp.expect('C0b before: no ✅ for the table', (select count(*)::int from chk0 where 状態 = '✅'), 0);
select pg_temp.expect('C0c before: counts say 表なし', (select count(*)::int from chk0 where 詳細 = '表なし'), 2);

select pg_temp.try('A1 127 applies', :'c127', 'ok');
select pg_temp.try('A2 127 applies again (idempotent)', :'c127', 'ok');
grant all on all tables in schema public to authenticated, service_role;

-- w1=退職者本人 w2=人事 w3=経営者 w4=ほかの人
insert into public.tenants(id,name) values ('77777777-7777-7777-7777-777777777777','T7');
insert into auth.users(id,email) select ('a7a0000' || n || '-0000-0000-0000-000000000000')::uuid, 'r' || n || '@x' from generate_series(1,4) n;
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '77777777-7777-7777-7777-777777777777', u.id, split_part(u.email,'@',1), u.email, case when u.email = 'r1@x' then 'leaving' else 'active' end
   from auth.users u where u.email ~ '^r[1-4]@x$';
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('77777777-7777-7777-7777-777777777777','a7a00002-0000-0000-0000-000000000000','hr'),
 ('77777777-7777-7777-7777-777777777777','a7a00003-0000-0000-0000-000000000000','owner');

\set T 77777777-7777-7777-7777-777777777777
\set E a7a00001-0000-0000-0000-000000000000
-- 申請（サーバー＝権限の高い接続）
select pg_temp.try('R1 request (2 items, NDA)', format($q$
  insert into public.gw_retire_cert_requests(tenant_id, employee_id, items, nda_text, nda_version, nda_agreed_at, nda_ip, nda_user_agent, requested_by)
  values (%L, %L, array['period','cause'], '入社時に同意した秘密保持契約（NDA）…を遵守することを誓約します', '2026-10-08', now(), '203.0.113.1', 'UA', %L)$q$, :'T', :'E', :'E'), 'ok');
select pg_temp.try('R2 second open request for the same person is refused', format($q$
  insert into public.gw_retire_cert_requests(tenant_id, employee_id, items, nda_text, nda_version, nda_agreed_at)
  values (%L, %L, array['wage'], 'x', 'v', now())$q$, :'T', :'E'), 'uq_gw_retire_cert_requests_open');
select pg_temp.try('R3 unknown item is refused', format($q$
  insert into public.gw_retire_cert_requests(tenant_id, employee_id, items, nda_text, nda_version, nda_agreed_at)
  values (%L, 'a7a00004-0000-0000-0000-000000000000', array['salary_note'], 'x', 'v', now())$q$, :'T'), 'gw_retire_cert_requests_items');
select pg_temp.try('R4 empty items are refused', format($q$
  insert into public.gw_retire_cert_requests(tenant_id, employee_id, items, nda_text, nda_version, nda_agreed_at)
  values (%L, 'a7a00004-0000-0000-0000-000000000000', array[]::text[], 'x', 'v', now())$q$, :'T'), 'gw_retire_cert_requests_items');
select pg_temp.try('R5 NDA agreement time is required', format($q$
  insert into public.gw_retire_cert_requests(tenant_id, employee_id, items, nda_text, nda_version)
  values (%L, 'a7a00004-0000-0000-0000-000000000000', array['job'], 'x', 'v')$q$, :'T'), 'nda_agreed_at');
select pg_temp.try('R6 NDA text is required (empty refused)', format($q$
  insert into public.gw_retire_cert_requests(tenant_id, employee_id, items, nda_text, nda_version, nda_agreed_at)
  values (%L, 'a7a00004-0000-0000-0000-000000000000', array['job'], '', 'v', now())$q$, :'T'), 'gw_retire_cert_requests_nda');
select pg_temp.try('R7 issued needs a decision time', format($q$
  update public.gw_retire_cert_requests set status = 'issued' where employee_id = %L$q$, :'E'), 'gw_retire_cert_requests_decided');
select pg_temp.try('R8 issue with decision time', format($q$
  update public.gw_retire_cert_requests set status = 'issued', decided_at = now(), decided_by_name = 'w3' where employee_id = %L$q$, :'E'), 'ok');
select pg_temp.try('R9 after issue, a new request can be made', format($q$
  insert into public.gw_retire_cert_requests(tenant_id, employee_id, items, nda_text, nda_version, nda_agreed_at)
  values (%L, %L, array['wage'], 'x', 'v', now())$q$, :'T', :'E'), 'ok');
select pg_temp.expect('R10 two rows for the person (issued + requested)', (select count(*)::int from public.gw_retire_cert_requests where employee_id = 'a7a00001-0000-0000-0000-000000000000'), 2);

-- ログインした人は、直接は読めない・書けない
select pg_temp.expect('L1 the person cannot read directly', pg_temp.count_as('a7a00001-0000-0000-0000-000000000000', 'public.gw_retire_cert_requests'), 0);
select pg_temp.expect('L2 hr cannot read directly', pg_temp.count_as('a7a00002-0000-0000-0000-000000000000', 'public.gw_retire_cert_requests'), 0);
select pg_temp.expect('L3 owner cannot read directly', pg_temp.count_as('a7a00003-0000-0000-0000-000000000000', 'public.gw_retire_cert_requests'), 0);
select pg_temp.try_as('L4 the person cannot insert directly', 'a7a00001-0000-0000-0000-000000000000', format($q$
  insert into public.gw_retire_cert_requests(tenant_id, employee_id, items, nda_text, nda_version, nda_agreed_at)
  values (%L, 'a7a00004-0000-0000-0000-000000000000', array['job'], 'x', 'v', now())$q$, :'T'), 'row-level security');

-- 流したあと：確認用 SQL が全部 ✅
select pg_temp.try('C1 check sql runs after 127', format('create temp table chk1 as %s', :'cchk'), 'ok');
select pg_temp.expect('C2 after: all 4 items ✅', (select count(*)::int from chk1 where 状態 = '✅'), 4);
select pg_temp.expect('C3 after: no ❌', (select count(*)::int from chk1 where 状態 = '❌'), 0);
select pg_temp.expect('C4 after: counts (1 requested)', (select count(*)::int from chk1 where 項目 = 'ℹ 申請中の件数' and 詳細 = '1'), 1);
