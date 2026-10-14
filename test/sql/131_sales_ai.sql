-- db/131_sales_ai.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（Sales の表）が無い DB では、131 は何も作らずにエラーで止まる
--   ・Supabase と同じ「新しい表・関数に anon / authenticated の権限が自動で付く」状態でも、
--       - AI営業の表は Sales の人だけが読める（他テナント・権限の無い社員・退職者・anon は読めない）
--       - 誰も書けない（INSERT は RLS で拒否、UPDATE / DELETE は 0 行）→ 書くのは API の service_role だけ
--       - 予約・確定の関数は authenticated / anon から呼べない（service_role は呼べる）
--   ・承認した人が作った人・申請した人と同じなら、service_role でも保存できない（自己承認の禁止）
--   ・承認済みの本文・件名は変えられない（承認をやり直せば変えられる）。1社に承認待ち・承認済みは1つまで
--   ・予算：止まっている間は予約できない／月・日の上限を超える予約はできない／1日の分析社数の上限／
--           1時間の呼び出し数を超えたら止まる／確定で月の上限に達したら止まる／失敗が続いたら止まる／
--           10分たった予約は解放される
--     （並列で呼ばれても上限を超えないことは run.sh の「131 並列」で、実際に psql を同時に走らせて確かめる）
--   ・確認 SQL（db/check_131_sales_ai.sql）に ❌ が出ない。戻す SQL で消え、もう一度流しても同じ（べき等）
--
\set ON_ERROR_STOP 0
\set c088 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/088_sales.sql"`
\set c094 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/094_recruit_sales_roles.sql"`
\set c096 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/096_sales_channels.sql"`
\set c119 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/119_app_grants.sql"`
\set c120 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/120_left_gate.sql"`
\set c130 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/130_sales_access_align.sql"`
\set c131 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/131_sales_ai.sql"`
\set crb `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_131_sales_ai.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_131_sales_ai.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || coalesce(got::text, 'null') || ' / want ' || want; end $$;
create or replace function pg_temp.expect_text(label text, got text, want text) returns void language plpgsql as $$
begin raise notice '% : %', case when got is not distinct from want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || coalesce(got, 'null') || ' / want ' || coalesce(want, 'null'); end $$;
create or replace function pg_temp.expect_true(label text, got boolean) returns void language plpgsql as $$
begin raise notice '% : %', case when coalesce(got, false) then 'PASS' else 'FAIL' end || ' ' || label, coalesce(got::text, 'null'); end $$;
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;
create or replace function pg_temp.try_role(label text, role text, uid uuid, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  execute format('set local role %I', role);
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
create or replace function pg_temp.count_as(role text, uid uuid, src text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  execute format('set local role %I', role);
  execute format('select count(*) from %s', src) into n;
  execute 'reset role';
  return n;
end $$;
create or replace function pg_temp.check_fails(sql text) returns int language plpgsql as $$
declare n int;
begin execute format('select count(*) from (%s) x where x."状態" = %L', sql, '❌') into n; return n; end $$;
-- 予約して、断られた理由（予約できたら 'ok'）を返す
create or replace function pg_temp.reserve(est numeric, purpose text default 'analysis') returns text language plpgsql as $$
declare r record;
begin
  select * into r from public.gw_sales_ai_reserve('88888888-8888-8888-8888-888888888888', est, purpose, 'claude-haiku-5-5',
                                                  'c8000000-0000-0000-0000-000000000001', 'a8a00003-0000-0000-0000-000000000000');
  return case when r.reservation_id is not null then 'ok' else r.reason end;
end $$;
-- 表ができる前に作るので plpgsql（中身は呼んだときに解決される）
create or replace function pg_temp.reserve_id(est numeric) returns uuid language plpgsql as $$
begin
  return (select reservation_id from public.gw_sales_ai_reserve('88888888-8888-8888-8888-888888888888', est, 'draft', 'claude-sonnet-5-5',
                                                                'c8000000-0000-0000-0000-000000000001', 'a8a00003-0000-0000-0000-000000000000'));
end $$;
create or replace function pg_temp.reset_usage(cap numeric, daycap numeric) returns void language plpgsql as $$
begin
  delete from public.gw_sales_ai_usage;
  update public.gw_sales_ai_settings set enabled = true, paused_reason = null, paused_at = null,
         monthly_cap_usd = cap, daily_cap_usd = daycap, daily_company_limit = 100, hourly_call_limit = 200
   where tenant_id = '88888888-8888-8888-8888-888888888888';
end $$;
create or replace function pg_temp.paused() returns text language plpgsql as $$
begin
  return (select case when enabled then null else coalesce(paused_reason, 'disabled') end
            from public.gw_sales_ai_settings where tenant_id = '88888888-8888-8888-8888-888888888888');
end $$;

do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; end $$;
grant usage on schema public, auth to anon;

-- ---------------------------------------------------------------------------
-- A. 前提が無い DB：131 は止まる
-- ---------------------------------------------------------------------------
select pg_temp.try('A1 131 は Sales の表が無ければエラーで止まる', :'c131', 'db/088');
select pg_temp.expect_true('A2 止まったときは何も作っていない', to_regclass('public.gw_sales_ai_settings') is null);

select pg_temp.try('A3 088 applies', :'c088', 'ok');
select pg_temp.try('A3 094 applies', :'c094', 'ok');
select pg_temp.try('A3 096 applies', :'c096', 'ok');
select pg_temp.try('A3 119 applies', :'c119', 'ok');
select pg_temp.try('A3 120 applies', :'c120', 'ok');
select pg_temp.try('A3 130 applies', :'c130', 'ok');
grant all on all tables in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
-- Supabase と同じ：これから作る表・関数にも anon / authenticated / service_role の権限が自動で付く
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

select pg_temp.try('A4 131 applies', :'c131', 'ok');
select pg_temp.try('A5 131 は2回流しても同じ（べき等）', :'c131', 'ok');
select pg_temp.expect('A6 db/check_131_sales_ai.sql に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);

-- ---------------------------------------------------------------------------
-- 人とデータ
--   T8：u1 経営者 / u2 責任者（manager）＋Salesアプリ / u3 Salesアプリだけ（営業担当）/ u4 権限なし / u6 退職者（Salesアプリ）
--   T9：u5 経営者＋Salesアプリ（他テナント）
-- ---------------------------------------------------------------------------
insert into public.tenants(id, name) values
  ('88888888-8888-8888-8888-888888888888', 'T8'), ('99999999-9999-9999-9999-999999999999', 'T9');
insert into auth.users(id, email)
  select ('a8a0000' || n || '-0000-0000-0000-000000000000')::uuid, 'u' || n || '@x' from generate_series(1, 6) n;
insert into public.gw_employees(id, tenant_id, user_id, display_name, email, status)
  select u.id,
         case when u.email = 'u5@x' then '99999999-9999-9999-9999-999999999999'::uuid else '88888888-8888-8888-8888-888888888888'::uuid end,
         u.id, split_part(u.email, '@', 1), u.email, case when u.email = 'u6@x' then 'left' else 'active' end
    from auth.users u where u.email ~ '^u[1-6]@x$';
insert into public.gw_role_grants(tenant_id, employee_id, role) values
  ('88888888-8888-8888-8888-888888888888', 'a8a00001-0000-0000-0000-000000000000', 'owner'),
  ('88888888-8888-8888-8888-888888888888', 'a8a00002-0000-0000-0000-000000000000', 'manager'),
  ('99999999-9999-9999-9999-999999999999', 'a8a00005-0000-0000-0000-000000000000', 'owner');
insert into public.gw_app_grants(tenant_id, employee_id, app_key) values
  ('88888888-8888-8888-8888-888888888888', 'a8a00002-0000-0000-0000-000000000000', 'sales'),
  ('88888888-8888-8888-8888-888888888888', 'a8a00003-0000-0000-0000-000000000000', 'sales'),
  ('88888888-8888-8888-8888-888888888888', 'a8a00006-0000-0000-0000-000000000000', 'sales'),
  ('99999999-9999-9999-9999-999999999999', 'a8a00005-0000-0000-0000-000000000000', 'sales');
insert into public.gw_sales_companies(id, tenant_id, name, domain) values
  ('c8000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', 'T8 一社', 'one.example'),
  ('c8000000-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888', 'T8 二社', 'two.example'),
  ('c9000000-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999999', 'T9 一社', 'nine.example');
insert into public.gw_sales_ai_settings(tenant_id, enabled) values
  ('88888888-8888-8888-8888-888888888888', true), ('99999999-9999-9999-9999-999999999999', true);
insert into public.gw_sales_ai_analyses(id, tenant_id, company_id, status, score) values
  ('aa000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', 'c8000000-0000-0000-0000-000000000001', 'ok', 70),
  ('aa000000-0000-0000-0000-000000000009', '99999999-9999-9999-9999-999999999999', 'c9000000-0000-0000-0000-000000000001', 'ok', 50);
insert into public.gw_sales_ai_drafts(id, tenant_id, company_id, analysis_id, body, created_by) values
  ('dd000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', 'c8000000-0000-0000-0000-000000000001',
   'aa000000-0000-0000-0000-000000000001', '本文1', 'a8a00003-0000-0000-0000-000000000000'),
  ('dd000000-0000-0000-0000-000000000009', '99999999-9999-9999-9999-999999999999', 'c9000000-0000-0000-0000-000000000001',
   'aa000000-0000-0000-0000-000000000009', '本文9', 'a8a00005-0000-0000-0000-000000000000');
insert into public.gw_sales_ai_usage(tenant_id, purpose, model, status, cost_usd) values
  ('88888888-8888-8888-8888-888888888888', 'analysis', 'claude-haiku-5-5', 'committed', 0.001),
  ('99999999-9999-9999-9999-999999999999', 'analysis', 'claude-haiku-5-5', 'committed', 0.001);
insert into public.gw_sales_ai_classifications(company_id, tenant_id, best_service, fits, source) values
  ('c8000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', '8EC・8RENT', '{"8EC・8RENT": 8}', 'site'),
  ('c9000000-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999999', 'ENGER', '{"ENGER": 6}', 'meta');

-- ---------------------------------------------------------------------------
-- B. 読む：Sales の人だけ・自分のテナントだけ
-- ---------------------------------------------------------------------------
select pg_temp.expect('B1 経営者は自分のテナントの分析を読める', pg_temp.count_as('authenticated', 'a8a00001-0000-0000-0000-000000000000', 'public.gw_sales_ai_analyses'), 1);
select pg_temp.expect('B2 責任者（manager＋Salesアプリ）は営業文を読める', pg_temp.count_as('authenticated', 'a8a00002-0000-0000-0000-000000000000', 'public.gw_sales_ai_drafts'), 1);
select pg_temp.expect('B3 営業担当（Salesアプリ）は設定を読める', pg_temp.count_as('authenticated', 'a8a00003-0000-0000-0000-000000000000', 'public.gw_sales_ai_settings'), 1);
select pg_temp.expect('B4 営業担当は利用量を読める', pg_temp.count_as('authenticated', 'a8a00003-0000-0000-0000-000000000000', 'public.gw_sales_ai_usage'), 1);
select pg_temp.expect('B5 権限の無い社員は分析を読めない', pg_temp.count_as('authenticated', 'a8a00004-0000-0000-0000-000000000000', 'public.gw_sales_ai_analyses'), 0);
select pg_temp.expect('B6 権限の無い社員は営業文を読めない', pg_temp.count_as('authenticated', 'a8a00004-0000-0000-0000-000000000000', 'public.gw_sales_ai_drafts'), 0);
select pg_temp.expect('B7 退職者は営業文を読めない', pg_temp.count_as('authenticated', 'a8a00006-0000-0000-0000-000000000000', 'public.gw_sales_ai_drafts'), 0);
select pg_temp.expect('B8 他テナントの人には自分のテナントの行だけ', pg_temp.count_as('authenticated', 'a8a00005-0000-0000-0000-000000000000', 'public.gw_sales_ai_drafts where tenant_id = ''88888888-8888-8888-8888-888888888888'''), 0);
select pg_temp.expect('B9 anon は営業文を読めない', pg_temp.count_as('anon', null, 'public.gw_sales_ai_drafts'), 0);
select pg_temp.expect('B10 anon は利用量を読めない', pg_temp.count_as('anon', null, 'public.gw_sales_ai_usage'), 0);
select pg_temp.expect('B11 営業担当は自分のテナントの一次分類を読める', pg_temp.count_as('authenticated', 'a8a00003-0000-0000-0000-000000000000', 'public.gw_sales_ai_classifications'), 1);
select pg_temp.expect('B12 権限の無い社員・退職者・anon は一次分類を読めない',
  pg_temp.count_as('authenticated', 'a8a00004-0000-0000-0000-000000000000', 'public.gw_sales_ai_classifications')
  + pg_temp.count_as('authenticated', 'a8a00006-0000-0000-0000-000000000000', 'public.gw_sales_ai_classifications')
  + pg_temp.count_as('anon', null, 'public.gw_sales_ai_classifications'), 0);

-- ---------------------------------------------------------------------------
-- C. 書く：authenticated（PostgREST 直接）からは誰も書けない
-- ---------------------------------------------------------------------------
select pg_temp.try_role('C1 経営者でも営業文を直接は作れない', 'authenticated', 'a8a00001-0000-0000-0000-000000000000',
  $$insert into public.gw_sales_ai_drafts(tenant_id, company_id, body) values ('88888888-8888-8888-8888-888888888888', 'c8000000-0000-0000-0000-000000000002', 'x')$$,
  'row-level security');
select pg_temp.expect('C2 責任者でも営業文を直接は承認できない（0行）', pg_temp.rows_as('a8a00002-0000-0000-0000-000000000000',
  $$update public.gw_sales_ai_drafts set status = 'approved', decided_by = 'a8a00002-0000-0000-0000-000000000000', approved_body_hash = 'h' where id = 'dd000000-0000-0000-0000-000000000001'$$), 0);
select pg_temp.expect('C3 営業担当は設定を直接は変えられない（0行）', pg_temp.rows_as('a8a00003-0000-0000-0000-000000000000',
  $$update public.gw_sales_ai_settings set monthly_cap_usd = 1000$$), 0);
select pg_temp.expect('C4 営業担当は利用量を消せない（0行）', pg_temp.rows_as('a8a00003-0000-0000-0000-000000000000',
  $$delete from public.gw_sales_ai_usage$$), 0);
select pg_temp.try_role('C5 営業担当は利用量を直接は足せない', 'authenticated', 'a8a00003-0000-0000-0000-000000000000',
  $$insert into public.gw_sales_ai_usage(tenant_id, purpose, model) values ('88888888-8888-8888-8888-888888888888', 'analysis', 'm')$$,
  'row-level security');
select pg_temp.expect('C6 経営者でも分析を直接は消せない（0行）', pg_temp.rows_as('a8a00001-0000-0000-0000-000000000000',
  $$delete from public.gw_sales_ai_analyses$$), 0);
select pg_temp.try_role('C7 営業担当は予約の関数を呼べない', 'authenticated', 'a8a00003-0000-0000-0000-000000000000',
  $$select public.gw_sales_ai_reserve('88888888-8888-8888-8888-888888888888', 0, 'analysis', 'm', null, null)$$, 'permission denied');
select pg_temp.try_role('C8 経営者でも確定の関数を呼べない', 'authenticated', 'a8a00001-0000-0000-0000-000000000000',
  $$select public.gw_sales_ai_settle(gen_random_uuid(), 0, 0, 0, 'ok', null, 0)$$, 'permission denied');
select pg_temp.try_role('C9 anon は予約の関数を呼べない', 'anon', null,
  $$select public.gw_sales_ai_reserve('88888888-8888-8888-8888-888888888888', 0, 'analysis', 'm', null, null)$$, 'permission denied');
select pg_temp.try_role('C10 service_role は予約の関数を呼べる', 'service_role', null,
  $$select public.gw_sales_ai_reserve('99999999-9999-9999-9999-999999999999', 0.01, 'analysis', 'm', null, null)$$, 'ok');
select pg_temp.try_role('C13 経営者でも一次分類を直接は書けない', 'authenticated', 'a8a00001-0000-0000-0000-000000000000',
  $$insert into public.gw_sales_ai_classifications(company_id, tenant_id, source) values ('c8000000-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888', 'meta')$$,
  'row-level security');
select pg_temp.expect('C14 営業担当は一次分類を書き換えられない（0行）', pg_temp.rows_as('a8a00003-0000-0000-0000-000000000000',
  $$update public.gw_sales_ai_classifications set best_service = 'ENGER'$$), 0);
select pg_temp.try('C15 一次分類の出どころは site / meta だけ',
  $$insert into public.gw_sales_ai_classifications(company_id, tenant_id, source) values ('c8000000-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888', 'guess')$$, 'check');
select pg_temp.expect('C11 書けなかったあとも営業文は下書きのまま',
  (select count(*)::int from public.gw_sales_ai_drafts where id = 'dd000000-0000-0000-0000-000000000001' and status = 'draft'), 1);
select pg_temp.expect('C12 書けなかったあとも上限は 100 ドルのまま',
  (select count(*)::int from public.gw_sales_ai_settings where monthly_cap_usd = 100), 2);

-- ---------------------------------------------------------------------------
-- D. 承認（service_role で書いても、表の制約が止める）
-- ---------------------------------------------------------------------------
update public.gw_sales_ai_drafts set status = 'pending', requested_by = 'a8a00003-0000-0000-0000-000000000000', requested_at = now()
 where id = 'dd000000-0000-0000-0000-000000000001';
select pg_temp.try('D1 作った人は承認できない',
  $$update public.gw_sales_ai_drafts set status = 'approved', decided_by = 'a8a00003-0000-0000-0000-000000000000', decided_at = now(), approved_body_hash = 'h'
     where id = 'dd000000-0000-0000-0000-000000000001'$$, 'gw_sales_ai_drafts_no_self_approval');
update public.gw_sales_ai_drafts set created_by = 'a8a00001-0000-0000-0000-000000000000' where id = 'dd000000-0000-0000-0000-000000000001';
select pg_temp.try('D2 申請した人も承認できない（作った人が別でも）',
  $$update public.gw_sales_ai_drafts set status = 'approved', decided_by = 'a8a00003-0000-0000-0000-000000000000', decided_at = now(), approved_body_hash = 'h'
     where id = 'dd000000-0000-0000-0000-000000000001'$$, 'gw_sales_ai_drafts_no_self_approval');
select pg_temp.try('D3 承認者が空のまま承認にはできない',
  $$update public.gw_sales_ai_drafts set status = 'approved', approved_body_hash = 'h' where id = 'dd000000-0000-0000-0000-000000000001'$$,
  'gw_sales_ai_drafts_no_self_approval');
select pg_temp.try('D4 承認したときの本文のハッシュが無いと承認にできない',
  $$update public.gw_sales_ai_drafts set status = 'approved', decided_by = 'a8a00002-0000-0000-0000-000000000000', decided_at = now()
     where id = 'dd000000-0000-0000-0000-000000000001'$$, 'gw_sales_ai_drafts_approved_hash');
select pg_temp.try('D5 別の人（責任者）なら承認できる',
  $$update public.gw_sales_ai_drafts set status = 'approved', decided_by = 'a8a00002-0000-0000-0000-000000000000', decided_at = now(), approved_body_hash = 'h'
     where id = 'dd000000-0000-0000-0000-000000000001'$$, 'ok');
select pg_temp.try('D6 承認済みの本文は変えられない',
  $$update public.gw_sales_ai_drafts set body = '書き換え' where id = 'dd000000-0000-0000-0000-000000000001'$$, '承認済みの営業文は変えられません');
select pg_temp.try('D7 承認済みの件名も変えられない',
  $$update public.gw_sales_ai_drafts set subject = '書き換え' where id = 'dd000000-0000-0000-0000-000000000001'$$, '承認済みの営業文は変えられません');
select pg_temp.try('D8 会社は付け替えられない',
  $$update public.gw_sales_ai_drafts set company_id = 'c8000000-0000-0000-0000-000000000002' where id = 'dd000000-0000-0000-0000-000000000001'$$, 'company_id');
select pg_temp.try('D9 1社に承認待ち・承認済みは1つまで',
  $$insert into public.gw_sales_ai_drafts(tenant_id, company_id, body, status, requested_by) values
      ('88888888-8888-8888-8888-888888888888', 'c8000000-0000-0000-0000-000000000001', '二つ目', 'pending', 'a8a00003-0000-0000-0000-000000000000')$$,
  'uq_gw_sales_ai_drafts_active');
select pg_temp.try('D10 承認をやり直す（下書きに戻す）と本文を直せる',
  $$update public.gw_sales_ai_drafts set status = 'draft', decided_by = null, decided_at = null, approved_body_hash = null, body = '直した本文'
     where id = 'dd000000-0000-0000-0000-000000000001'$$, 'ok');
select pg_temp.try('D11 同じ会社でも、下書きなら2つ目を作れる',
  $$insert into public.gw_sales_ai_drafts(tenant_id, company_id, body) values ('88888888-8888-8888-8888-888888888888', 'c8000000-0000-0000-0000-000000000001', '別案')$$, 'ok');
select pg_temp.try('D12 アタックに AI 文面を結び付けられる（ai_draft_id）',
  $$insert into public.gw_sales_approaches(tenant_id, company_id, tracking_token, ai_draft_id) values
      ('88888888-8888-8888-8888-888888888888', 'c8000000-0000-0000-0000-000000000001', 'tok131', 'dd000000-0000-0000-0000-000000000001')$$, 'ok');

-- ---------------------------------------------------------------------------
-- E. 予算（予約・確定・自動停止）
-- ---------------------------------------------------------------------------
select pg_temp.reset_usage(1.00, 0.50);
update public.gw_sales_ai_settings set enabled = false where tenant_id = '88888888-8888-8888-8888-888888888888';
select pg_temp.expect_text('E1 止まっている間は予約できない', pg_temp.reserve(0.01), 'disabled');
update public.gw_sales_ai_settings set paused_reason = 'manual' where tenant_id = '88888888-8888-8888-8888-888888888888';
select pg_temp.expect_text('E2 手動で止めたときは理由が返る', pg_temp.reserve(0.01), 'paused:manual');
select pg_temp.reset_usage(1.00, 0.50);
select pg_temp.expect_text('E3 動いていれば予約できる', pg_temp.reserve(0.20), 'ok');
select pg_temp.expect_text('E4 日の上限まで予約できる（0.20＋0.30＝0.50）', pg_temp.reserve(0.30), 'ok');
select pg_temp.expect_text('E5 日の上限を超える予約はできない', pg_temp.reserve(0.01), 'daily_cap');
-- 月の上限：日の上限を広げて、月の上限だけで止まることを見る（すでに確定した 0.45 を足す）
update public.gw_sales_ai_settings set daily_cap_usd = 10 where tenant_id = '88888888-8888-8888-8888-888888888888';
insert into public.gw_sales_ai_usage(tenant_id, purpose, model, status, cost_usd, settled_at)
  values ('88888888-8888-8888-8888-888888888888', 'analysis', 'm', 'committed', 0.45, now());
select pg_temp.expect_text('E6 月の上限まで予約できる（0.95＋0.05＝1.00）', pg_temp.reserve(0.05), 'ok');
select pg_temp.expect_text('E7 月の上限を超える予約はできない', pg_temp.reserve(0.001), 'monthly_cap');
select pg_temp.expect('E8 断った予約は台帳に残らない（予約3つ＋確定1つ）',
  (select count(*)::int from public.gw_sales_ai_usage where tenant_id = '88888888-8888-8888-8888-888888888888'), 4);
-- 確定：見込みより安く済めば、差額が空く
select pg_temp.reset_usage(1.00, 10);
do $$ declare rid uuid := pg_temp.reserve_id(0.80); begin
  perform pg_temp.expect_text('E9 確定しても月の上限前なら止まらない', public.gw_sales_ai_settle(rid, 1000, 200, 0.10, 'ok', null, 1200), null);
end $$;
select pg_temp.expect_text('E10 確定で空いた分をまた予約できる（0.10＋0.85＝0.95）', pg_temp.reserve(0.85), 'ok');
select pg_temp.expect('E11 確定は実際のトークン・費用を残す',
  (select count(*)::int from public.gw_sales_ai_usage where status = 'committed' and input_tokens = 1000 and output_tokens = 200 and cost_usd = 0.10 and outcome = 'ok'), 1);
-- 確定で月の上限に達したら止まる
select pg_temp.reset_usage(0.30, 10);
do $$ declare rid uuid := pg_temp.reserve_id(0.30); begin
  perform pg_temp.expect_text('E12 確定で月の上限に達したら止まる', public.gw_sales_ai_settle(rid, 1, 1, 0.30, 'ok', null, 10), 'monthly_cap');
end $$;
select pg_temp.expect_text('E13 止まったことが設定に残る', pg_temp.paused(), 'monthly_cap');
select pg_temp.expect_text('E14 止まったあとは予約できない', pg_temp.reserve(0.001), 'paused:monthly_cap');
-- 失敗が続いたら止まる（直近20回のうち5回）
select pg_temp.reset_usage(10, 10);
do $$ declare i int; why text; begin
  for i in 1..4 loop why := public.gw_sales_ai_settle(pg_temp.reserve_id(0.01), 0, 0, 0, 'error', 'overloaded', 10); end loop;
  perform pg_temp.expect_text('E15 失敗が4回ではまだ止まらない', why, null);
  why := public.gw_sales_ai_settle(pg_temp.reserve_id(0.01), 0, 0, 0, 'invalid_output', null, 10);
  perform pg_temp.expect_text('E16 失敗が5回で止まる', why, 'errors');
end $$;
select pg_temp.expect_text('E17 失敗で止まったことが設定に残る', pg_temp.paused(), 'errors');
-- 1日の分析社数の上限
select pg_temp.reset_usage(10, 10);
update public.gw_sales_ai_settings set daily_company_limit = 2 where tenant_id = '88888888-8888-8888-8888-888888888888';
select pg_temp.expect_text('E18 分析1社目', pg_temp.reserve(0.001), 'ok');
select pg_temp.expect_text('E19 分析2社目', pg_temp.reserve(0.001), 'ok');
select pg_temp.expect_text('E20 分析3社目は1日の上限で止める', pg_temp.reserve(0.001), 'daily_company_limit');
select pg_temp.expect_text('E21 文面づくりは分析社数の上限に数えない', pg_temp.reserve(0.001, 'draft'), 'ok');
-- 1時間の呼び出し数を超えたら止まる（暴走の検知）
select pg_temp.reset_usage(10, 10);
update public.gw_sales_ai_settings set hourly_call_limit = 3 where tenant_id = '88888888-8888-8888-8888-888888888888';
select pg_temp.reserve(0.001, 'draft'), pg_temp.reserve(0.001, 'draft'), pg_temp.reserve(0.001, 'draft');
select pg_temp.expect_text('E22 1時間の呼び出し数を超えたら断る', pg_temp.reserve(0.001, 'draft'), 'burst');
select pg_temp.expect_text('E23 そのまま止まる（人が再開するまで）', pg_temp.paused(), 'burst');
-- 応答が無いまま10分たった予約は解放する
select pg_temp.reset_usage(0.50, 10);
insert into public.gw_sales_ai_usage(tenant_id, purpose, model, status, reserved_usd, created_at)
  values ('88888888-8888-8888-8888-888888888888', 'draft', 'm', 'reserved', 0.50, now() - interval '11 minutes');
select pg_temp.expect_text('E24 10分たった予約は解放され、その分をまた予約できる', pg_temp.reserve(0.40), 'ok');
select pg_temp.expect('E25 解放した予約は expired として残る',
  (select count(*)::int from public.gw_sales_ai_usage where status = 'released' and outcome = 'expired'), 1);
select pg_temp.try('E26 見込み額がマイナスなら断る',
  $$select public.gw_sales_ai_reserve('88888888-8888-8888-8888-888888888888', -1, 'analysis', 'm', null, null)$$, '見込み額');
select pg_temp.expect_text('E28 商材の一次分類（classify）も予約できる（分析社数の上限には数えない）', pg_temp.reserve(0.001, 'classify'), 'ok');
select pg_temp.expect_text('E27 他テナントの使いすぎは、こちらの予約に影響しない',
  (select case when reservation_id is not null then 'ok' else reason end
     from public.gw_sales_ai_reserve('99999999-9999-9999-9999-999999999999', 0.01, 'analysis', 'm', null, null)), 'ok');

-- ---------------------------------------------------------------------------
-- F. 戻す（rollback）→ もう一度 131
-- ---------------------------------------------------------------------------
select pg_temp.try('F1 rollback applies', :'crb', 'ok');
select pg_temp.expect_true('F2 戻すと AI営業の表が消える', to_regclass('public.gw_sales_ai_drafts') is null and to_regclass('public.gw_sales_ai_usage') is null
  and to_regclass('public.gw_sales_ai_classifications') is null);
select pg_temp.expect('F2b 戻しても企業マスタは消えない', (select count(*)::int from public.gw_sales_companies), 3);
select pg_temp.expect('F3 戻しても既存のアタックは消えない', (select count(*)::int from public.gw_sales_approaches where tracking_token = 'tok131'), 1);
select pg_temp.expect('F4 戻した状態では確認 SQL に ❌ が出る', (pg_temp.check_fails(:'cchk') > 0)::int, 1);
select pg_temp.try('F5 もう一度 131 を流せる', :'c131', 'ok');
select pg_temp.expect('F6 もう一度流したあとも確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
