-- db/138_sales_proposals.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（096 の gw_sales_events.channel）が無い DB では、138 は何も作らずにエラーで止まる（フェイルクローズ）
--   ・138 は2回流しても同じ（べき等）。確認 SQL（db/check_138）に ❌ が出ない
--   ・見える範囲：管理側（経営者・マネージャー・会計の管理者）は全件、営業担当は自分が担当の提案だけ。
--     担当が未定の提案は管理側だけ。別テナント・Sales を使えない社員・退職者・anon は見えない
--     （PostgREST を直接呼ぶのと同じ条件＝ authenticated ロール＋JWT の sub で確かめる）
--   ・営業担当は担当を他人へ付け替えられない（管理側の仕事）。担当は同じテナントの在籍中の社員だけ
--   ・同じ dx.enger の提案は1件。同じ自動タスクは1つ。電話の記録は結果と実施者が要る
--   ・タスクは記録なしで完了にできない。別の提案の記録では完了にできない。終わったタスクは開き直せない
--   ・提案・記録・タスクは消せない。記録は書き換えられない。連携の記録は管理側しか読めず、利用者は書けない
--   ・戻す SQL（rollback）で消え、もう一度 138 を流せば元どおり
--
\set ON_ERROR_STOP 0
\set c088 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/088_sales.sql"`
\set c094 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/094_recruit_sales_roles.sql"`
\set c096 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/096_sales_channels.sql"`
\set c119 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/119_app_grants.sql"`
\set c120 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/120_left_gate.sql"`
\set c130 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/130_sales_access_align.sql"`
\set c138 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/138_sales_proposals.sql"`
\set crb `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_138_sales_proposals.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_138_sales_proposals.sql"`

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
create or replace function pg_temp.check_fails(sql text) returns int language plpgsql as $$
declare n int;
begin execute format('select count(*) from (%s) x where x."状態" = %L', sql, '❌') into n; return n; end $$;

do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; end $$;
grant usage on schema public, auth to anon;

-- ---------------------------------------------------------------------------
-- A. 前提が無い DB（088・094 だけ。096 の channel が無い）では止まる
-- ---------------------------------------------------------------------------
select pg_temp.try('A0 088 applies', :'c088', 'ok');
select pg_temp.try('A0 094 applies', :'c094', 'ok');
select pg_temp.try('A1 138 は 096 が無ければエラーで止まる（フェイルクローズ）', :'c138', 'db/096');
select pg_temp.expect_true('A2 止まったときは表を作っていない', to_regclass('public.gw_sales_proposals') is null);

select pg_temp.try('A3 096 applies', :'c096', 'ok');
select pg_temp.try('A4 138 は 130 の前（gw_has_app が無い）でも止まる', :'c138', 'db/119');
select pg_temp.try('A5 119 applies', :'c119', 'ok');
select pg_temp.try('A5 120 applies', :'c120', 'ok');
select pg_temp.try('A5 130 applies', :'c130', 'ok');

-- ---------------------------------------------------------------------------
-- B. 138 を適用（2回流しても同じ）
-- ---------------------------------------------------------------------------
select pg_temp.try('B0 138 applies', :'c138', 'ok');
select pg_temp.try('B0 138 は2回流しても同じ（べき等）', :'c138', 'ok');
grant all on all tables in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;
grant select on all tables in schema public to anon;

-- ---------------------------------------------------------------------------
-- 人とデータ
--   T8：p1 経営者 / p2 マネージャー＋Salesアプリ / p3 営業（Salesアプリ） / p4 営業（Salesアプリ）
--       p5 権限なし / p6 退職者（Salesアプリが残っている） / p8 会計の管理者（staff）＋Salesアプリ
--   T9：p7 経営者
-- ---------------------------------------------------------------------------
insert into public.tenants(id, name) values
  ('88888888-8888-8888-8888-888888888888', 'T8'), ('99999999-9999-9999-9999-999999999999', 'T9');
insert into auth.users(id, email)
  select ('b8b0000' || n || '-0000-0000-0000-000000000000')::uuid, 'p' || n || '@x' from generate_series(1, 8) n;
insert into public.gw_employees(id, tenant_id, user_id, display_name, email, status)
  select u.id,
         case when u.email = 'p7@x' then '99999999-9999-9999-9999-999999999999'::uuid else '88888888-8888-8888-8888-888888888888'::uuid end,
         u.id, split_part(u.email, '@', 1), u.email,
         case when u.email = 'p6@x' then 'left' else 'active' end
    from auth.users u where u.email ~ '^p[1-8]@x$';
insert into public.memberships(user_id, tenant_id, role) values
  ('b8b00008-0000-0000-0000-000000000000', '88888888-8888-8888-8888-888888888888', 'staff');
insert into public.gw_role_grants(tenant_id, employee_id, role) values
  ('88888888-8888-8888-8888-888888888888', 'b8b00001-0000-0000-0000-000000000000', 'owner'),
  ('88888888-8888-8888-8888-888888888888', 'b8b00002-0000-0000-0000-000000000000', 'manager'),
  ('99999999-9999-9999-9999-999999999999', 'b8b00007-0000-0000-0000-000000000000', 'owner');
insert into public.gw_app_grants(tenant_id, employee_id, app_key) values
  ('88888888-8888-8888-8888-888888888888', 'b8b00002-0000-0000-0000-000000000000', 'sales'),
  ('88888888-8888-8888-8888-888888888888', 'b8b00003-0000-0000-0000-000000000000', 'sales'),
  ('88888888-8888-8888-8888-888888888888', 'b8b00004-0000-0000-0000-000000000000', 'sales'),
  ('88888888-8888-8888-8888-888888888888', 'b8b00006-0000-0000-0000-000000000000', 'sales'),
  ('88888888-8888-8888-8888-888888888888', 'b8b00008-0000-0000-0000-000000000000', 'sales');
insert into public.gw_sales_companies(id, tenant_id, name, domain) values
  ('c8000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', 'T8 一社', 'one.example'),
  ('c9000000-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999999', 'T9 一社', 'nine.example');
-- 提案：P1 p3担当 / P2 p4担当 / P3 担当未定（dx.enger から） / P9 T9
insert into public.gw_sales_proposals(id, tenant_id, source_system, source_proposal_id, company_id, company_name, title, sales_owner_id, sent_at) values
  ('d8000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', 'enger', 'enger-p1', 'c8000000-0000-0000-0000-000000000001', 'T8 一社', 'Java / T.K.', 'b8b00003-0000-0000-0000-000000000000', now()),
  ('d8000000-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888', 'enger', 'enger-p2', null, 'B社', 'PM / S.Y.', 'b8b00004-0000-0000-0000-000000000000', now()),
  ('d8000000-0000-0000-0000-000000000003', '88888888-8888-8888-8888-888888888888', 'enger', 'enger-p3', null, 'C社', 'インフラ / A.A.', null, now()),
  ('d9000000-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999999', 'manual', null, 'c9000000-0000-0000-0000-000000000001', 'T9 一社', 'PCレンタル', null, now());
insert into public.gw_sales_proposal_tasks(id, tenant_id, proposal_id, kind, title, assignee_id, due_at, auto, source_event) values
  ('e8000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000001', 'call', '初回電話', 'b8b00003-0000-0000-0000-000000000000', now() + interval '30 minutes', true, 'auto:first_call'),
  ('e8000000-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000002', 'call', '初回電話', 'b8b00004-0000-0000-0000-000000000000', now() + interval '30 minutes', true, 'auto:first_call');
insert into public.gw_sales_proposal_sync_log(tenant_id, event_id, event_type, source_proposal_id, status, message) values
  ('88888888-8888-8888-8888-888888888888', 'evt-00000001', 'proposal.sent', 'enger-p3', 'warning', 'owner_unmatched');

-- ---------------------------------------------------------------------------
-- C. 見える範囲
-- ---------------------------------------------------------------------------
select pg_temp.expect('C1 経営者は T8 の提案を全部見る', pg_temp.count_as('b8b00001-0000-0000-0000-000000000000', 'public.gw_sales_proposals'), 3);
select pg_temp.expect('C2 マネージャー（Salesアプリ）は全部見る', pg_temp.count_as('b8b00002-0000-0000-0000-000000000000', 'public.gw_sales_proposals'), 3);
select pg_temp.expect('C3 会計の管理者（staff＋Salesアプリ）は全部見る', pg_temp.count_as('b8b00008-0000-0000-0000-000000000000', 'public.gw_sales_proposals'), 3);
select pg_temp.expect('C4 営業担当は自分が担当の提案だけ（未定・他人の担当は見えない）', pg_temp.count_as('b8b00003-0000-0000-0000-000000000000', 'public.gw_sales_proposals'), 1);
select pg_temp.expect('C4 営業担当が見えるのは自分の提案', pg_temp.count_as('b8b00003-0000-0000-0000-000000000000',
  'public.gw_sales_proposals where id = ''d8000000-0000-0000-0000-000000000001'''), 1);
select pg_temp.expect('C5 営業担当には他人の提案のタスクが見えない', pg_temp.count_as('b8b00003-0000-0000-0000-000000000000', 'public.gw_sales_proposal_tasks'), 1);
select pg_temp.expect('C6 権限の無い社員は見えない', pg_temp.count_as('b8b00005-0000-0000-0000-000000000000', 'public.gw_sales_proposals'), 0);
select pg_temp.expect('C7 退職者（Salesアプリが残っていても）は見えない', pg_temp.count_as('b8b00006-0000-0000-0000-000000000000', 'public.gw_sales_proposals'), 0);
select pg_temp.expect('C8 他テナントの経営者は T8 の提案を見えない', pg_temp.count_as('b8b00007-0000-0000-0000-000000000000',
  'public.gw_sales_proposals where tenant_id = ''88888888-8888-8888-8888-888888888888'''), 0);
select pg_temp.expect('C8 他テナントの経営者は自分のテナントの提案だけ', pg_temp.count_as('b8b00007-0000-0000-0000-000000000000', 'public.gw_sales_proposals'), 1);
select pg_temp.expect('C9 ログインしていない（JWT なし）は見えない', pg_temp.count_as(null, 'public.gw_sales_proposals'), 0);
select pg_temp.expect('C9 anon は見えない', pg_temp.count_anon('public.gw_sales_proposals'), 0);
select pg_temp.expect('C10 連携の記録は営業担当には見えない', pg_temp.count_as('b8b00003-0000-0000-0000-000000000000', 'public.gw_sales_proposal_sync_log'), 0);
select pg_temp.expect('C10 連携の記録は管理側に見える', pg_temp.count_as('b8b00002-0000-0000-0000-000000000000', 'public.gw_sales_proposal_sync_log'), 1);

-- ---------------------------------------------------------------------------
-- D. 書き込み
-- ---------------------------------------------------------------------------
select pg_temp.try_as('D1 営業担当は自分の提案に電話を記録できる', 'b8b00003-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_proposal_activities(id, tenant_id, proposal_id, kind, result, employee_id, occurred_at)
     values ('f8000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000001', 'call', 'no_answer', 'b8b00003-0000-0000-0000-000000000000', now())$q$, 'ok');
-- 見張りのトリガーは呼んだ人の権限で提案を探すので、見えない提案は「見つからない」で止まる（RLS より先に止まる）
select pg_temp.try_as('D2 営業担当は他人の提案に記録できない', 'b8b00003-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_proposal_activities(tenant_id, proposal_id, kind, result, employee_id)
     values ('88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000002', 'call', 'no_answer', 'b8b00003-0000-0000-0000-000000000000')$q$, '提案が見つかりません');
select pg_temp.try_as('D2 営業担当は他人の提案にタスクを足せない', 'b8b00003-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_proposal_tasks(tenant_id, proposal_id, kind, title, due_at)
     values ('88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000002', 'manual', 'x', now())$q$, '提案が見つかりません');
select pg_temp.try('D3 電話の記録は結果が要る（「電話した」だけでは記録にしない）',
  $q$insert into public.gw_sales_proposal_activities(tenant_id, proposal_id, kind, employee_id)
     values ('88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000001', 'call', 'b8b00003-0000-0000-0000-000000000000')$q$, 'gw_sales_proposal_activities_call');
select pg_temp.try('D3 電話の記録は実施者が要る',
  $q$insert into public.gw_sales_proposal_activities(tenant_id, proposal_id, kind, result)
     values ('88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000001', 'call', 'connected')$q$, 'gw_sales_proposal_activities_call');
select pg_temp.try('D3 期限の変更は理由が要る',
  $q$insert into public.gw_sales_proposal_activities(tenant_id, proposal_id, kind, note)
     values ('88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000001', 'due_change', '  ')$q$, 'gw_sales_proposal_activities_due');
select pg_temp.try('D4 記録は別テナントの提案に付けられない',
  $q$insert into public.gw_sales_proposal_activities(tenant_id, proposal_id, kind, note)
     values ('99999999-9999-9999-9999-999999999999', 'd8000000-0000-0000-0000-000000000001', 'memo', 'x')$q$, '提案が見つかりません');

select pg_temp.expect('D5 営業担当は記録を書き換えられない（0行）', pg_temp.rows_as('b8b00003-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposal_activities set note = 'x' where id = 'f8000000-0000-0000-0000-000000000001'$q$), 0);
select pg_temp.expect('D5 経営者も記録を消せない（0行）', pg_temp.rows_as('b8b00001-0000-0000-0000-000000000000',
  $q$delete from public.gw_sales_proposal_activities where id = 'f8000000-0000-0000-0000-000000000001'$q$), 0);
select pg_temp.expect('D5 経営者も提案を消せない（0行）', pg_temp.rows_as('b8b00001-0000-0000-0000-000000000000',
  $q$delete from public.gw_sales_proposals where id = 'd8000000-0000-0000-0000-000000000001'$q$), 0);

-- タスク：記録なしでは完了にできない
select pg_temp.try('D6 タスクは記録なしでは完了にできない',
  $q$update public.gw_sales_proposal_tasks set status = 'done', done_at = now() where id = 'e8000000-0000-0000-0000-000000000001'$q$, 'gw_sales_proposal_tasks_done');
select pg_temp.try('D7 別の提案の記録では完了にできない',
  $q$update public.gw_sales_proposal_tasks set status = 'done', done_at = now(), done_activity_id = 'f8000000-0000-0000-0000-000000000001'
      where id = 'e8000000-0000-0000-0000-000000000002'$q$, 'この提案のものではありません');
select pg_temp.expect('D8 営業担当は自分の提案のタスクを、記録とひも付けて完了にできる', pg_temp.rows_as('b8b00003-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposal_tasks set status = 'done', done_at = now(), done_activity_id = 'f8000000-0000-0000-0000-000000000001'
      where id = 'e8000000-0000-0000-0000-000000000001'$q$), 1);
select pg_temp.try('D9 終わったタスクは開き直せない',
  $q$update public.gw_sales_proposal_tasks set status = 'open', done_at = null, done_activity_id = null where id = 'e8000000-0000-0000-0000-000000000001'$q$, '変えられません');
select pg_temp.try('D10 取り消しは理由が要る',
  $q$update public.gw_sales_proposal_tasks set status = 'canceled' where id = 'e8000000-0000-0000-0000-000000000002'$q$, 'gw_sales_proposal_tasks_cancel');
select pg_temp.try('D11 同じ提案に同じ自動タスクは作れない（重複生成しない）',
  $q$insert into public.gw_sales_proposal_tasks(tenant_id, proposal_id, kind, title, due_at, auto, source_event)
     values ('88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000001', 'call', '初回電話', now(), true, 'auto:first_call')$q$, 'uq_gw_sales_proposal_tasks_event');
select pg_temp.try('D12 タスクの担当者は同じテナントの社員だけ',
  $q$insert into public.gw_sales_proposal_tasks(tenant_id, proposal_id, kind, title, due_at, assignee_id)
     values ('88888888-8888-8888-8888-888888888888', 'd8000000-0000-0000-0000-000000000001', 'manual', 'x', now(), 'b8b00007-0000-0000-0000-000000000000')$q$, '在籍中の社員ではありません');

-- 提案
select pg_temp.try('D13 同じ dx.enger の提案は2件目を作れない',
  $q$insert into public.gw_sales_proposals(tenant_id, source_system, source_proposal_id, company_name, title, sent_at)
     values ('88888888-8888-8888-8888-888888888888', 'enger', 'enger-p1', 'A社', 'x', now())$q$, 'uq_gw_sales_proposals_source');
select pg_temp.try('D13 dx.enger の提案は連携キーが要る',
  $q$insert into public.gw_sales_proposals(tenant_id, source_system, company_name, title, sent_at)
     values ('88888888-8888-8888-8888-888888888888', 'enger', 'A社', 'x', now())$q$, 'gw_sales_proposals_source_key');
select pg_temp.try('D14 見送りは理由コードが要る',
  $q$update public.gw_sales_proposals set status = 'lost', closed_at = now() where id = 'd8000000-0000-0000-0000-000000000001'$q$, 'gw_sales_proposals_reason');
select pg_temp.try('D14 終わった提案は終わった日時が要る',
  $q$update public.gw_sales_proposals set status = 'won' where id = 'd8000000-0000-0000-0000-000000000001'$q$, 'gw_sales_proposals_closed');
select pg_temp.try('D15 連携キー・送信日時はあとから変えられない',
  $q$update public.gw_sales_proposals set source_proposal_id = 'enger-zz' where id = 'd8000000-0000-0000-0000-000000000001'$q$, '変えられません');
select pg_temp.try('D16 営業担当は別テナントの社員にできない',
  $q$update public.gw_sales_proposals set sales_owner_id = 'b8b00007-0000-0000-0000-000000000000' where id = 'd8000000-0000-0000-0000-000000000001'$q$, '在籍中の社員ではありません');
select pg_temp.try('D16 営業担当は退職者にできない',
  $q$update public.gw_sales_proposals set sales_owner_id = 'b8b00006-0000-0000-0000-000000000000' where id = 'd8000000-0000-0000-0000-000000000001'$q$, '在籍中の社員ではありません');
select pg_temp.try('D16 企業は別テナントのものにできない',
  $q$update public.gw_sales_proposals set company_id = 'c9000000-0000-0000-0000-000000000001' where id = 'd8000000-0000-0000-0000-000000000002'$q$, '企業が見つかりません');

select pg_temp.expect('D17 営業担当は自分の提案の状態を変えられる', pg_temp.rows_as('b8b00003-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposals set status = 'mail_wait' where id = 'd8000000-0000-0000-0000-000000000001'$q$), 1);
select pg_temp.expect('D18 営業担当は他人の提案を変えられない（0行）', pg_temp.rows_as('b8b00003-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposals set status = 'mail_wait' where id = 'd8000000-0000-0000-0000-000000000002'$q$), 0);
select pg_temp.try_as('D19 営業担当は担当を他人へ付け替えられない（管理側の仕事）', 'b8b00003-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposals set sales_owner_id = 'b8b00004-0000-0000-0000-000000000000' where id = 'd8000000-0000-0000-0000-000000000001'$q$, 'row-level security');
select pg_temp.expect('D20 マネージャーは担当未定の提案を営業担当に割り当てられる', pg_temp.rows_as('b8b00002-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposals set sales_owner_id = 'b8b00003-0000-0000-0000-000000000000' where id = 'd8000000-0000-0000-0000-000000000003'$q$), 1);
select pg_temp.expect('D20 割り当てられた営業担当に見えるようになる', pg_temp.count_as('b8b00003-0000-0000-0000-000000000000', 'public.gw_sales_proposals'), 2);
select pg_temp.try_as('D21 営業担当は担当未定の提案を自分で作れない（担当を自分にすれば作れる）', 'b8b00004-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_proposals(tenant_id, company_name, title, sent_at) values ('88888888-8888-8888-8888-888888888888', 'D社', 'x', now())$q$, 'row-level security');
select pg_temp.try_as('D21 営業担当は自分が担当の提案を手で足せる', 'b8b00004-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_proposals(tenant_id, company_name, title, sent_at, sales_owner_id, service)
     values ('88888888-8888-8888-8888-888888888888', 'D社', 'PCレンタル', now(), 'b8b00004-0000-0000-0000-000000000000', 'PCレンタル')$q$, 'ok');

-- 連携の記録・設定
select pg_temp.try_as('D22 マネージャーでも連携の記録は足せない（書くのはサーバだけ）', 'b8b00002-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_proposal_sync_log(tenant_id, event_id, event_type, status) values ('88888888-8888-8888-8888-888888888888', 'evt-00000002', 'proposal.sent', 'ok')$q$, 'row-level security');
select pg_temp.expect('D23 マネージャーは連携エラーを確認済みにできる', pg_temp.rows_as('b8b00002-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposal_sync_log set resolved_at = now() where event_id = 'evt-00000001'$q$), 1);
select pg_temp.try_as('D24 営業担当は設定を変えられない', 'b8b00003-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_proposal_settings(tenant_id, first_call_minutes) values ('88888888-8888-8888-8888-888888888888', 60)$q$, 'row-level security');
select pg_temp.try_as('D25 マネージャーは設定を変えられる', 'b8b00002-0000-0000-0000-000000000000',
  $q$insert into public.gw_sales_proposal_settings(tenant_id, first_call_minutes) values ('88888888-8888-8888-8888-888888888888', 60)$q$, 'ok');
select pg_temp.try('D26 営業時間は始まりが終わりより前',
  $q$update public.gw_sales_proposal_settings set biz_start = '19:00' where tenant_id = '88888888-8888-8888-8888-888888888888'$q$, 'gw_sales_proposal_settings_hours');
select pg_temp.expect('D27 営業担当も設定は読める（期限の計算に使う）', pg_temp.count_as('b8b00003-0000-0000-0000-000000000000', 'public.gw_sales_proposal_settings'), 1);

-- 確認 SQL
select pg_temp.expect('E1 db/check_138_sales_proposals.sql に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);

-- ---------------------------------------------------------------------------
-- G. 戻す（rollback）→ もう一度 138
-- ---------------------------------------------------------------------------
select pg_temp.try('G1 rollback applies', :'crb', 'ok');
select pg_temp.expect_true('G2 戻すと提案管理の表が無くなる', to_regclass('public.gw_sales_proposals') is null and to_regclass('public.gw_sales_proposal_tasks') is null);
select pg_temp.expect_true('G2 戻しても既存の企業はそのまま', (select count(*) from public.gw_sales_companies) = 2);
select pg_temp.expect('G3 戻したあとの確認 SQL はエラーにならず ❌ を出す', (pg_temp.check_fails(:'cchk') > 0)::int, 1);
select pg_temp.try('G4 もう一度 138 を流せる', :'c138', 'ok');
select pg_temp.expect_true('G4 表が戻る', to_regclass('public.gw_sales_proposals') is not null);
