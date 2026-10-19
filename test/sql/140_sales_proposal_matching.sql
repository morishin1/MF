-- db/140_sales_proposal_matching.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・138 が無い DB では、140 は何も変えずにエラーで止まる。確認 SQL は流す前でもエラーにならず ❌ が並ぶ
--   ・140 は2回流しても同じ（べき等）。確認 SQL（check_140・check_138）に ❌ が出ない。既存の提案は変えない
--   ・提案待ち（マッチング確定）は送信日時が空。提案待ちなのに送信日時あり・起点（確定・送信）の無い提案は入らない
--   ・送信日時・確定日時は「空 → 日時」の1回だけ（service_role でも変えられない・消せない）
--   ・記録の「マッチング確定」・タスクの「提案準備」が入る。知らない種類は入らない
--   ・Slack の印は、空のときだけ入れる更新で1件だけが取れる（同じ提案で2回流さない）
--   ・営業担当は自分の提案待ちを見て「企業へ送った」を書ける。ほかの人の提案は見えない（db/138 の RLS のまま）
--   ・設定の Slack のメンバーIDは JSON のオブジェクトだけ
--   ・戻す SQL：提案待ちが残っていると止まる。片付ければ戻せる（行は種類を写して残す）。もう一度流せる
--
\set ON_ERROR_STOP 0
\set c088 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/088_sales.sql"`
\set c094 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/094_recruit_sales_roles.sql"`
\set c096 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/096_sales_channels.sql"`
\set c119 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/119_app_grants.sql"`
\set c120 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/120_left_gate.sql"`
\set c130 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/130_sales_access_align.sql"`
\set c138 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/138_sales_proposals.sql"`
\set c140 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/140_sales_proposal_matching.sql"`
\set crb `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_140_sales_proposal_matching.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_140_sales_proposal_matching.sql"`
\set cchk138 `sed 's/;\s*$//' "$SCEN_ROOT/db/check_138_sales_proposals.sql"`

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
create or replace function pg_temp.has_col(t text, c text) returns int language sql as $$
  select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = t and column_name = c $$;

-- ---------------------------------------------------------------------------
-- A. 138 が無い DB では止まる
-- ---------------------------------------------------------------------------
select pg_temp.expect('A1 流す前の確認 SQL はエラーにならず ❌ が並ぶ', (pg_temp.check_fails(:'cchk') >= 5)::int, 1);
select pg_temp.try('A2 140 は 138 の前に流すと止まる', :'c140', 'db/138_sales_proposals.sql');
select pg_temp.try('A3 088 applies', :'c088', 'ok');
select pg_temp.try('A3 094 applies', :'c094', 'ok');
select pg_temp.try('A3 096 applies', :'c096', 'ok');
select pg_temp.try('A3 119 applies', :'c119', 'ok');
select pg_temp.try('A3 120 applies', :'c120', 'ok');
select pg_temp.try('A3 130 applies', :'c130', 'ok');
select pg_temp.try('A3 138 applies', :'c138', 'ok');
grant all on all tables in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

-- 人：p1 経営者 / p3 営業（Salesアプリ） / p4 営業（Salesアプリ）
insert into public.tenants(id, name) values ('14014014-0000-0000-0000-000000000001', 'T140');
insert into auth.users(id, email) values
  ('a1400001-0000-0000-0000-000000000000', 'p1@x'), ('a1400003-0000-0000-0000-000000000000', 'p3@x'), ('a1400004-0000-0000-0000-000000000000', 'p4@x');
insert into public.gw_employees(id, tenant_id, user_id, display_name, email, status) values
  ('a1400001-0000-0000-0000-000000000000', '14014014-0000-0000-0000-000000000001', 'a1400001-0000-0000-0000-000000000000', '経営', 'p1@x', 'active'),
  ('a1400003-0000-0000-0000-000000000000', '14014014-0000-0000-0000-000000000001', 'a1400003-0000-0000-0000-000000000000', '営業3', 'p3@x', 'active'),
  ('a1400004-0000-0000-0000-000000000000', '14014014-0000-0000-0000-000000000001', 'a1400004-0000-0000-0000-000000000000', '営業4', 'p4@x', 'active');
insert into public.gw_role_grants(tenant_id, employee_id, role) values
  ('14014014-0000-0000-0000-000000000001', 'a1400001-0000-0000-0000-000000000000', 'owner');
insert into public.gw_app_grants(tenant_id, employee_id, app_key) values
  ('14014014-0000-0000-0000-000000000001', 'a1400003-0000-0000-0000-000000000000', 'sales'),
  ('14014014-0000-0000-0000-000000000001', 'a1400004-0000-0000-0000-000000000000', 'sales');
-- 140 を流す前からある提案（db/138 のとき：送った時点で起票）
insert into public.gw_sales_proposals(id, tenant_id, source_system, source_proposal_id, company_name, title, sales_owner_id, sent_at) values
  ('b1400001-0000-0000-0000-000000000000', '14014014-0000-0000-0000-000000000001', 'enger', 'old-1', '既存社', 'Java / T.K.', 'a1400003-0000-0000-0000-000000000000', now() - interval '2 days');

-- ---------------------------------------------------------------------------
-- B. 140 を適用（2回流しても同じ）
-- ---------------------------------------------------------------------------
select pg_temp.try('B1 140 applies', :'c140', 'ok');
select pg_temp.try('B2 140 は2回流しても同じ（べき等）', :'c140', 'ok');
select pg_temp.expect('B3 確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
select pg_temp.expect('B4 db/138 の確認 SQL も ❌ が無い', pg_temp.check_fails(:'cchk138'), 0);
select pg_temp.expect('B5 既存の提案は変えない（電話待ち・送信日時あり・確定日時は空）',
  (select count(*)::int from public.gw_sales_proposals where id = 'b1400001-0000-0000-0000-000000000000'
     and status = 'call_wait' and sent_at is not null and matched_at is null), 1);

-- ---------------------------------------------------------------------------
-- C. 提案待ち・起点・種類
-- ---------------------------------------------------------------------------
select pg_temp.try('C1 マッチング確定で起票（提案待ち・送信日時は空）',
  $q$insert into public.gw_sales_proposals(id, tenant_id, source_system, source_proposal_id, company_name, title, sales_owner_id, matched_at, status)
     values ('b1400002-0000-0000-0000-000000000000', '14014014-0000-0000-0000-000000000001', 'enger', 'm-1', '確定社', 'PM / S.Y.',
             'a1400003-0000-0000-0000-000000000000', now() - interval '10 minutes', 'proposal_wait')$q$, 'ok');
select pg_temp.try('C2 提案待ちなのに送信日時がある提案は入らない',
  $q$insert into public.gw_sales_proposals(tenant_id, source_system, source_proposal_id, company_name, title, matched_at, sent_at, status)
     values ('14014014-0000-0000-0000-000000000001', 'enger', 'm-2', 'x', 'x', now(), now(), 'proposal_wait')$q$, 'gw_sales_proposals_wait_chk');
select pg_temp.try('C3 起点（確定・送信）の無い提案は入らない',
  $q$insert into public.gw_sales_proposals(tenant_id, source_system, source_proposal_id, company_name, title, status)
     values ('14014014-0000-0000-0000-000000000001', 'enger', 'm-3', 'x', 'x', 'call_wait')$q$, 'gw_sales_proposals_start_chk');
select pg_temp.try('C4 知らない状態は入らない',
  $q$insert into public.gw_sales_proposals(tenant_id, source_system, source_proposal_id, company_name, title, matched_at, status)
     values ('14014014-0000-0000-0000-000000000001', 'enger', 'm-4', 'x', 'x', now(), 'draft')$q$, 'gw_sales_proposals_status_chk');
select pg_temp.try('C5 マッチング確定の記録が入る',
  $q$insert into public.gw_sales_proposal_activities(id, tenant_id, proposal_id, kind, result, evidence, occurred_at, source_event)
     values ('c1400001-0000-0000-0000-000000000000', '14014014-0000-0000-0000-000000000001', 'b1400002-0000-0000-0000-000000000000',
             'matched', 'matched', 'system', now() - interval '10 minutes', 'enger:proposal.matched:m-1:fixed01')$q$, 'ok');
select pg_temp.try('C6 提案準備のタスクが入る',
  $q$insert into public.gw_sales_proposal_tasks(id, tenant_id, proposal_id, kind, title, assignee_id, due_at, auto, source_event)
     values ('d1400001-0000-0000-0000-000000000000', '14014014-0000-0000-0000-000000000001', 'b1400002-0000-0000-0000-000000000000',
             'prepare', '提案準備', 'a1400003-0000-0000-0000-000000000000', now() + interval '6 hours', true, 'auto:prepare')$q$, 'ok');
select pg_temp.try('C7 同じ提案に提案準備は1つだけ（source_event の一意索引）',
  $q$insert into public.gw_sales_proposal_tasks(tenant_id, proposal_id, kind, title, due_at, auto, source_event)
     values ('14014014-0000-0000-0000-000000000001', 'b1400002-0000-0000-0000-000000000000', 'prepare', '提案準備', now(), true, 'auto:prepare')$q$, 'uq_gw_sales_proposal_tasks_event');
select pg_temp.try('C8 知らないタスクの種類は入らない',
  $q$insert into public.gw_sales_proposal_tasks(tenant_id, proposal_id, kind, title, due_at)
     values ('14014014-0000-0000-0000-000000000001', 'b1400002-0000-0000-0000-000000000000', 'slack', 'x', now())$q$, 'gw_sales_proposal_tasks_kind_chk');
select pg_temp.try('C9 知らない記録の種類は入らない',
  $q$insert into public.gw_sales_proposal_activities(tenant_id, proposal_id, kind)
     values ('14014014-0000-0000-0000-000000000001', 'b1400002-0000-0000-0000-000000000000', 'draft')$q$, 'gw_sales_proposal_activities_kind_chk');

-- ---------------------------------------------------------------------------
-- D. 見える範囲（db/138 の RLS のまま）・営業担当が「企業へ送った」を書く
-- ---------------------------------------------------------------------------
select pg_temp.expect('D1 営業担当は自分の提案待ちを見る', pg_temp.count_as('a1400003-0000-0000-0000-000000000000',
  'public.gw_sales_proposals where status = ''proposal_wait'''), 1);
select pg_temp.expect('D2 ほかの営業担当には見えない', pg_temp.count_as('a1400004-0000-0000-0000-000000000000', 'public.gw_sales_proposals'), 0);
select pg_temp.try_as('D3 担当の営業が「企業へ送った」を記録して電話待ちへ（送信日時は空 → 日時）', 'a1400003-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposals set sent_at = now(), status = 'call_wait' where id = 'b1400002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('D4 ほかの営業担当は書けない（0行）', pg_temp.rows_as('a1400004-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposals set status = 'lost' where id = 'b1400002-0000-0000-0000-000000000000'$q$), 0);

-- ---------------------------------------------------------------------------
-- E. 送信日時・確定日時は1回だけ（service_role でも）
-- ---------------------------------------------------------------------------
select pg_temp.try('E1 送った日時はあとから変えられない',
  $q$update public.gw_sales_proposals set sent_at = now() - interval '1 day' where id = 'b1400002-0000-0000-0000-000000000000'$q$, '送信日時は変えられません');
select pg_temp.try('E2 送った日時を空に戻せない（service_role でも）',
  $q$set local role service_role; update public.gw_sales_proposals set sent_at = null, status = 'proposal_wait' where id = 'b1400002-0000-0000-0000-000000000000'$q$, '送信日時は変えられません');
reset role;
select pg_temp.try('E3 確定日時はあとから変えられない',
  $q$update public.gw_sales_proposals set matched_at = now() where id = 'b1400002-0000-0000-0000-000000000000'$q$, 'マッチング確定の日時は変えられません');
select pg_temp.try('E4 確定日時が空の提案（送信が先に届いた）には、あとから入れられる',
  $q$update public.gw_sales_proposals set matched_at = now() - interval '3 days' where id = 'b1400001-0000-0000-0000-000000000000'$q$, 'ok');

-- ---------------------------------------------------------------------------
-- F. Slack の印は1件だけが取れる
-- ---------------------------------------------------------------------------
select pg_temp.expect('F1 1回目は取れる', pg_temp.rows_as('a1400003-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposals set slack_notified_at = now() where id = 'b1400002-0000-0000-0000-000000000000' and slack_notified_at is null$q$), 1);
select pg_temp.expect('F2 2回目は取れない（同じ提案で2回流さない）', pg_temp.rows_as('a1400003-0000-0000-0000-000000000000',
  $q$update public.gw_sales_proposals set slack_notified_at = now() where id = 'b1400002-0000-0000-0000-000000000000' and slack_notified_at is null$q$), 0);

-- ---------------------------------------------------------------------------
-- G. 設定：Slack のメンバーID
-- ---------------------------------------------------------------------------
select pg_temp.try('G1 社員ID → メンバーID のオブジェクトは入る',
  $q$insert into public.gw_sales_proposal_settings(tenant_id, slack_members)
     values ('14014014-0000-0000-0000-000000000001', '{"a1400003-0000-0000-0000-000000000000":"U0123ABCD"}')$q$, 'ok');
select pg_temp.try('G2 配列は入らない',
  $q$update public.gw_sales_proposal_settings set slack_members = '["U0123ABCD"]' where tenant_id = '14014014-0000-0000-0000-000000000001'$q$, 'gw_sales_proposal_settings_slack_chk');

-- ---------------------------------------------------------------------------
-- H. 戻す・もう一度流す
-- ---------------------------------------------------------------------------
insert into public.gw_sales_proposals(id, tenant_id, source_system, source_proposal_id, company_name, title, matched_at, status) values
  ('b1400003-0000-0000-0000-000000000000', '14014014-0000-0000-0000-000000000001', 'enger', 'm-9', '待ち社', 'Go / K.K.', now(), 'proposal_wait');
select pg_temp.try('H1 提案待ちが残っていると、戻す SQL は止まる', :'crb', '企業へまだ提案していない提案');
select pg_temp.expect('H2 止まったときは何も変えていない', pg_temp.has_col('gw_sales_proposals', 'matched_at'), 1);
update public.gw_sales_proposals set sent_at = now(), status = 'call_wait' where id = 'b1400003-0000-0000-0000-000000000000';
select pg_temp.try('H3 片付ければ戻せる', :'crb', 'ok');
select pg_temp.expect('H4 列が消え、送信日時は必須に戻る',
  pg_temp.has_col('gw_sales_proposals', 'matched_at') + pg_temp.has_col('gw_sales_proposals', 'slack_notified_at')
  + pg_temp.has_col('gw_sales_proposal_settings', 'slack_members')
  + (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'gw_sales_proposals'
       and column_name = 'sent_at' and is_nullable = 'YES'), 0);
select pg_temp.expect('H5 マッチング確定の記録は「dx.enger からの更新」、提案準備は手動タスクとして残る',
  (select count(*)::int from public.gw_sales_proposal_activities where id = 'c1400001-0000-0000-0000-000000000000' and kind = 'sync')
  + (select count(*)::int from public.gw_sales_proposal_tasks where id = 'd1400001-0000-0000-0000-000000000000' and kind = 'manual'), 2);
select pg_temp.expect('H6 db/138 の確認 SQL は ❌ が無い', pg_temp.check_fails(:'cchk138'), 0);
select pg_temp.try('H7 db/138 の形に戻った（送信日時はあとから変えられない）',
  $q$update public.gw_sales_proposals set sent_at = now() - interval '9 days' where id = 'b1400001-0000-0000-0000-000000000000'$q$, '送信日時は変えられません');
select pg_temp.try('H8 もう一度流せる', :'c140', 'ok');
select pg_temp.expect('H9 流し直したあとも確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
