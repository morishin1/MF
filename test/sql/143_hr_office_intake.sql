-- db/143_hr_office_intake.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（db/129・132・133・137・139）が無い DB では、143 は何も変えずにエラーで止まる。確認 SQL は流す前でもエラーにならない
--   ・2回流しても同じ（べき等）。既存の応募者・オファーは1行も変えない（backfill しない）
--   ・社長判断：社長（owner）・管理者だけが記録できる（採用担当・人事・他社の人は不可。service role でも）。書き換え・削除できない
--   ・ヒアリング：社長の合格のあとだけ。例外の承認は社長・管理者だけ。引き渡したら固定（給与の表も）
--   ・早期引き渡し：合格（最新）・オファーの版なし・ヒアリング確認済み・不足なし（未確定は承認と理由つき）・育成枠以外・
--     終了していない・無限道場以外 だけ。有効なものは1人に1つ（2回目は一意違反）。引き渡した内容は変えられない・削除できない
--     差し戻し（理由つき）のあとは新しい引き渡しを足せる（履歴は消えない）
--   ・既存の handoff_at・accepted_at・formal_signed_at・employee_id は変わらない
--   ・応募者の削除：契約の履歴（オファー・社長判断・ヒアリング・引き渡し）があると止まる。無ければ消せる。会社ごと消すのは止めない
--   ・画面から直接（authenticated）：承諾済み・完了・社員の結びつけ・（社長以外の）合格・引き渡し済みの人の状態は書けない
--   ・見える範囲：採用HR・人事は読める／給与は gw_can_see_salary だけ／一般・他社は読めない／ログインした人は書けない
--   ・戻す SQL：有効な引き渡しがあると止まる。差し戻したあとなら戻せる。もう一度流せる
--
\set ON_ERROR_STOP 0
\set c129 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/129_hr_offer_type.sql"`
\set c132 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/132_hr_offer_documents.sql"`
\set c133 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/133_hr_offer_handoff.sql"`
\set c137 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/137_hr_finish.sql"`
\set c139 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/139_hr_contract_procedure.sql"`
\set c143 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/143_hr_office_intake.sql"`
\set crb `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_143_hr_office_intake.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_143_hr_office_intake.sql"`
\set cchk133 `sed 's/;\s*$//' "$SCEN_ROOT/db/check_133_hr_offer_handoff.sql"`
\set cchk139 `sed 's/;\s*$//' "$SCEN_ROOT/db/check_139_hr_contract_procedure.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;
create or replace function pg_temp.check_fails(sql text) returns int language plpgsql as $$
declare n int;
begin execute format('select count(*) from (%s) x where x."状態" = %L', sql, '❌') into n; return n; end $$;
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
create or replace function pg_temp.has_tbl(t text) returns int language sql as $$ select (to_regclass('public.' || t) is not null)::int $$;

-- Supabase は新しい表に、ログインした人（authenticated）への権限を自動で付ける。その代わり（143 が外すことを確かめる）
alter default privileges in schema public grant all on tables to authenticated, service_role;

-- ---- 前提が無い DB では止まる -------------------------------------------------
select pg_temp.try('A1 db/129 を流す', :'c129', 'ok');
select pg_temp.try('A2 db/133 の前に流すと止まる', :'c143', 'db/133_hr_offer_handoff.sql');
select pg_temp.expect('A3 止まったときは表を足していない', pg_temp.has_tbl('gw_hr_ceo_decisions') + pg_temp.has_tbl('gw_hr_office_intakes'), 0);
select pg_temp.expect('A4 流す前の確認 SQL はエラーにならず ❌ が並ぶ', (pg_temp.check_fails(:'cchk') >= 10)::int, 1);
select pg_temp.try('A5 db/132・133 を流す', :'c132' || ';' || :'c133', 'ok');
select pg_temp.try('A6 db/137 の前に流すと止まる', :'c143', 'db/137_hr_finish.sql');
select pg_temp.try('A7 db/137 を流す', :'c137', 'ok');
select pg_temp.try('A8 db/139 の前に流すと止まる', :'c143', 'db/139_hr_contract_procedure.sql');
select pg_temp.try('A9 db/139 を流す', :'c139', 'ok');

-- 会社・人（実在の人ではない）
--   …01 経営者（owner）／…02 管理者（memberships admin）／…03 採用担当（recruiter）／…04 人事（hr）／…05 一般／…06 他社の経営者
insert into public.tenants(id, name) values
  ('14314314-0000-0000-0000-000000000001', 'テスト会社'), ('14314314-0000-0000-0000-000000000002', '別の会社');
insert into auth.users(id, email) values
  ('a1430001-0000-0000-0000-000000000000', 'owner@example.test'),
  ('a1430002-0000-0000-0000-000000000000', 'admin@example.test'),
  ('a1430003-0000-0000-0000-000000000000', 'recruiter@example.test'),
  ('a1430004-0000-0000-0000-000000000000', 'hr@example.test'),
  ('a1430005-0000-0000-0000-000000000000', 'member@example.test'),
  ('a1430006-0000-0000-0000-000000000000', 'other-owner@example.test');
insert into public.gw_employees(id, tenant_id, user_id, display_name, email, status) values
  ('e1430001-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'a1430001-0000-0000-0000-000000000000', '社長', 'owner@example.test', 'active'),
  ('e1430003-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'a1430003-0000-0000-0000-000000000000', '採用', 'recruiter@example.test', 'active'),
  ('e1430004-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'a1430004-0000-0000-0000-000000000000', '人事', 'hr@example.test', 'active'),
  ('e1430005-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'a1430005-0000-0000-0000-000000000000', '一般', 'member@example.test', 'active'),
  ('e1430006-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000002', 'a1430006-0000-0000-0000-000000000000', '他社社長', 'other-owner@example.test', 'active');
insert into public.gw_role_grants(tenant_id, employee_id, role) values
  ('14314314-0000-0000-0000-000000000001', 'e1430001-0000-0000-0000-000000000000', 'owner'),
  ('14314314-0000-0000-0000-000000000001', 'e1430003-0000-0000-0000-000000000000', 'recruiter'),
  ('14314314-0000-0000-0000-000000000001', 'e1430004-0000-0000-0000-000000000000', 'hr'),
  ('14314314-0000-0000-0000-000000000002', 'e1430006-0000-0000-0000-000000000000', 'owner');
insert into public.memberships(user_id, tenant_id, role) values
  ('a1430002-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'admin');

-- 応募者：c1 新フロー（これから合格）／c2 旧フロー（オファーの版あり・承諾済み・引き渡し済み）／c3 削除してよい人（履歴なし）
--         c4 育成枠で渡そうとする人／c5 他社の応募者／c6 見送り済み
insert into public.gw_hr_applicants(id, tenant_id, name, email, job_title, source, stage, status) values
  ('c1430001-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', '新 候補者', 'new@example.test', 'テスト', 'テスト', 'ceo_interview', 'ceo_decision_pending'),
  ('c1430002-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', '旧 候補者', 'old@example.test', 'テスト', 'テスト', 'offer', 'accepted'),
  ('c1430003-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', '誤登録', 'typo@example.test', 'テスト', 'テスト', 'applied', 'todo'),
  ('c1430004-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', '育成 候補者', 'trainee@example.test', 'テスト', 'テスト', 'ceo_interview', 'ceo_decision_pending'),
  ('c1430005-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000002', '他社 候補者', 'other@example.test', 'テスト', 'テスト', 'ceo_interview', 'ceo_decision_pending'),
  ('c1430006-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', '見送り 候補者', 'passed@example.test', 'テスト', 'テスト', 'ceo_interview', 'ceo_decision_pending');
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type, sent_at, accepted_at,
                                notice_title, notice_pdf_path, notice_pdf_sha256) values
  ('b1430002-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'c1430002-0000-0000-0000-000000000000', 1, 'k2',
   now() + interval '3 days', 'part_time', now() - interval '3 days', now() - interval '2 days',
   '労働条件通知書', 't/offers/c2/b2/notice-v1.pdf', repeat('b', 64));
update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/old', formal_signed_at = now(), formal_signed_by = 'a1430004-0000-0000-0000-000000000000'
 where id = 'b1430002-0000-0000-0000-000000000000';
update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1430004-0000-0000-0000-000000000000'
 where id = 'b1430002-0000-0000-0000-000000000000';

select pg_temp.try('A10 db/143 を流す', :'c143', 'ok');
select pg_temp.try('A11 もう一度流しても同じ（べき等）', :'c143', 'ok');
select pg_temp.expect('A12 確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
select pg_temp.expect('A13 db/133・139 の確認 SQL も ❌ が無い（それらの trigger・制約は変えていない）',
  pg_temp.check_fails(:'cchk133') + pg_temp.check_fails(:'cchk139'), 0);
select pg_temp.expect('A14 backfill しない（社長判断・ヒアリング・引き渡しは0件）',
  (select count(*)::int from public.gw_hr_ceo_decisions) + (select count(*)::int from public.gw_hr_hearings)
  + (select count(*)::int from public.gw_hr_office_intakes), 0);
select pg_temp.expect('A15 既存のオファー（承諾・引き渡し）は変わらない',
  (select count(*)::int from public.gw_hr_offers where id = 'b1430002-0000-0000-0000-000000000000'
     and accepted_at is not null and handoff_at is not null and handoff_by = 'a1430004-0000-0000-0000-000000000000'), 1);

-- ---- 社長判断 ------------------------------------------------------------------
set role service_role;
select pg_temp.try('B1 採用担当は（サーバ経由でも）合格を記録できない',
  $q$insert into public.gw_hr_ceo_decisions(tenant_id, applicant_id, decision, decided_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'pass', 'a1430003-0000-0000-0000-000000000000')$q$, '社長・管理者だけ');
select pg_temp.try('B2 人事（hr）も合格を記録できない',
  $q$insert into public.gw_hr_ceo_decisions(tenant_id, applicant_id, decision, decided_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'pass', 'a1430004-0000-0000-0000-000000000000')$q$, '社長・管理者だけ');
select pg_temp.try('B3 他社の社長はこの会社の応募者の合格を記録できない',
  $q$insert into public.gw_hr_ceo_decisions(tenant_id, applicant_id, decision, decided_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'pass', 'a1430006-0000-0000-0000-000000000000')$q$, '社長・管理者だけ');
select pg_temp.try('B4 別の会社の応募者には記録できない',
  $q$insert into public.gw_hr_ceo_decisions(tenant_id, applicant_id, decision, decided_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430005-0000-0000-0000-000000000000', 'pass', 'a1430001-0000-0000-0000-000000000000')$q$, '同じ会社にありません');
select pg_temp.try('B5 判断は合格・保留・見送りだけ',
  $q$insert into public.gw_hr_ceo_decisions(tenant_id, applicant_id, decision, decided_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'hired', 'a1430001-0000-0000-0000-000000000000')$q$, 'gw_hr_ceo_decisions_decision_chk');
select pg_temp.try('B6 社長（owner）は合格を記録できる',
  $q$insert into public.gw_hr_ceo_decisions(id, tenant_id, applicant_id, decision, decided_by, decided_at)
     values ('d1430001-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'pass',
             'a1430001-0000-0000-0000-000000000000', now() - interval '1 hour')$q$, 'ok');
select pg_temp.try('B7 管理者（memberships admin）も記録できる（育成枠の人の合格）',
  $q$insert into public.gw_hr_ceo_decisions(id, tenant_id, applicant_id, decision, decided_by)
     values ('d1430004-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'c1430004-0000-0000-0000-000000000000', 'pass',
             'a1430002-0000-0000-0000-000000000000')$q$, 'ok');
select pg_temp.try('B8 記録した判断は書き換えられない（service role でも）',
  $q$update public.gw_hr_ceo_decisions set decision = 'reject' where id = 'd1430001-0000-0000-0000-000000000000'$q$, '書き換え・削除できません');
select pg_temp.try('B9 記録した判断は削除できない',
  $q$delete from public.gw_hr_ceo_decisions where id = 'd1430001-0000-0000-0000-000000000000'$q$, '書き換え・削除できません');
reset role;
select pg_temp.try_as('B10 採用担当は画面から直接は記録できない（権限）', 'a1430003-0000-0000-0000-000000000000',
  $q$insert into public.gw_hr_ceo_decisions(tenant_id, applicant_id, decision, decided_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'pass', 'a1430003-0000-0000-0000-000000000000')$q$, 'permission denied');
select pg_temp.try_as('B11 社長でも画面から直接は記録できない（サーバ＝service role だけが書く）', 'a1430001-0000-0000-0000-000000000000',
  $q$insert into public.gw_hr_ceo_decisions(tenant_id, applicant_id, decision, decided_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'pass', 'a1430001-0000-0000-0000-000000000000')$q$, 'permission denied');

-- ---- 応募者の安全装置（画面から直接） --------------------------------------------
select pg_temp.try_as('C1 採用担当は画面から直接「合格」にできない', 'a1430003-0000-0000-0000-000000000000',
  $q$update public.gw_hr_applicants set decision = 'hired' where id = 'c1430006-0000-0000-0000-000000000000'$q$, '合格にできるのは社長・管理者だけ');
select pg_temp.try_as('C2 社長は画面から合格にできる（旧フローの画面と同じ）', 'a1430001-0000-0000-0000-000000000000',
  $q$update public.gw_hr_applicants set decision = 'hired', stage = 'offer', status = 'offer_draft_pending' where id = 'c1430001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try_as('C3 採用担当は画面から直接「承諾済み」にできない', 'a1430003-0000-0000-0000-000000000000',
  $q$update public.gw_hr_applicants set status = 'accepted' where id = 'c1430006-0000-0000-0000-000000000000'$q$, '承諾済み・完了は');
select pg_temp.try_as('C4 社長でも画面から直接「完了」にはできない（社員登録の手続きだけ）', 'a1430001-0000-0000-0000-000000000000',
  $q$update public.gw_hr_applicants set status = 'done' where id = 'c1430006-0000-0000-0000-000000000000'$q$, '承諾済み・完了は');
select pg_temp.try_as('C5 画面から直接、社員を結びつけられない', 'a1430004-0000-0000-0000-000000000000',
  $q$update public.gw_hr_applicants set employee_id = 'e1430005-0000-0000-0000-000000000000' where id = 'c1430006-0000-0000-0000-000000000000'$q$, '社員登録の手続きでだけ');
select pg_temp.try_as('C6 採用担当でも、ふつうの状態の変更はこれまでどおりできる（見送り）', 'a1430003-0000-0000-0000-000000000000',
  $q$update public.gw_hr_applicants set status = 'passed', decision = 'rejected' where id = 'c1430006-0000-0000-0000-000000000000'$q$, 'ok');
set role service_role;
select pg_temp.try('C7 サーバ（本人の承諾・社員登録の流れ）は承諾済みにできる（既存の流れを止めない）',
  $q$update public.gw_hr_applicants set status = 'accepted' where id = 'c1430003-0000-0000-0000-000000000000'$q$, 'ok');
reset role;

-- ---- ヒアリング ----------------------------------------------------------------
set role service_role;
select pg_temp.try('D1 社長の合格が無い応募者にはヒアリングを記録できない',
  $q$insert into public.gw_hr_hearings(tenant_id, applicant_id, recorded_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430003-0000-0000-0000-000000000000', 'a1430003-0000-0000-0000-000000000000')$q$, '合格判断が確定していない');
select pg_temp.try('D2 合格した応募者にヒアリングを記録する（未確定：希望入社日・希望報酬）',
  $q$insert into public.gw_hr_hearings(id, tenant_id, applicant_id, offer_type, job_title, duties, work_location, remote_policy,
                                      weekly_days, weekly_hours, contract_period, unresolved, recorded_by)
     values ('f1430001-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000',
             'part_time', 'エンジニア', '開発', '東京', '週2リモート', 3, 24, '期間の定めなし', '["desired_join_date","desired_pay"]',
             'a1430003-0000-0000-0000-000000000000')$q$, 'ok');
select pg_temp.try('D3 編集中のヒアリングは1人に1つ',
  $q$insert into public.gw_hr_hearings(tenant_id, applicant_id, recorded_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'a1430003-0000-0000-0000-000000000000')$q$, 'uq_gw_hr_hearings_open');
select pg_temp.try('D4 例外（未確定のまま引き渡す）の承認は社長・管理者だけ（採用担当は不可）',
  $q$update public.gw_hr_hearings set exception_reason = '入社日は本人の退職交渉次第', exception_approved_by = 'a1430003-0000-0000-0000-000000000000',
       exception_approved_at = now() where id = 'f1430001-0000-0000-0000-000000000000'$q$, '社長・管理者だけ');
select pg_temp.try('D5 例外の承認には理由が要る',
  $q$update public.gw_hr_hearings set exception_reason = ' ', exception_approved_by = 'a1430001-0000-0000-0000-000000000000',
       exception_approved_at = now() where id = 'f1430001-0000-0000-0000-000000000000'$q$, 'gw_hr_hearings_exception_chk');
select pg_temp.try('D6 確認は人と日時がそろう',
  $q$update public.gw_hr_hearings set confirmed_at = now() where id = 'f1430001-0000-0000-0000-000000000000'$q$, 'gw_hr_hearings_confirm_chk');
select pg_temp.try('D7 応募者・記録した人は変えられない',
  $q$update public.gw_hr_hearings set applicant_id = 'c1430003-0000-0000-0000-000000000000' where id = 'f1430001-0000-0000-0000-000000000000'$q$, '変更できません');
select pg_temp.try('D8 ヒアリングは削除できない',
  $q$delete from public.gw_hr_hearings where id = 'f1430001-0000-0000-0000-000000000000'$q$, '削除できません');
select pg_temp.try('D9 給与（候補者希望）は別の表に入れる',
  $q$insert into public.gw_hr_hearing_pay(hearing_id, tenant_id, applicant_id, desired_wage_type, desired_note, updated_by)
     values ('f1430001-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000',
             'hourly', '未確定（Officeで確認）', 'a1430004-0000-0000-0000-000000000000')$q$, 'ok');
select pg_temp.try('D10 社内承認済みの額は、承認した人・日時がそろう',
  $q$update public.gw_hr_hearing_pay set approved_amount = 1500 where hearing_id = 'f1430001-0000-0000-0000-000000000000'$q$, 'gw_hr_hearing_pay_approved_chk');

-- ---- 早期引き渡し --------------------------------------------------------------
-- 条件がそろわないと入らない
select pg_temp.try('E1 確認前のヒアリングでは引き渡せない',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, unresolved_items, handed_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'd1430001-0000-0000-0000-000000000000',
             'f1430001-0000-0000-0000-000000000000', '["desired_join_date","desired_pay"]', 'a1430003-0000-0000-0000-000000000000')$q$, '内容確認がまだ');
update public.gw_hr_hearings set confirmed_by = 'a1430004-0000-0000-0000-000000000000', confirmed_at = now() where id = 'f1430001-0000-0000-0000-000000000000';
select pg_temp.try('E2 未確定の項目があるのに例外の承認が無いと引き渡せない',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, unresolved_items, handed_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'd1430001-0000-0000-0000-000000000000',
             'f1430001-0000-0000-0000-000000000000', '["desired_join_date","desired_pay"]', 'a1430003-0000-0000-0000-000000000000')$q$, 'gw_hr_office_intakes_exception_chk');
select pg_temp.try('E3 未確定の項目をヒアリングと違えて（隠して）渡せない',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, unresolved_items, handed_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'd1430001-0000-0000-0000-000000000000',
             'f1430001-0000-0000-0000-000000000000', '[]', 'a1430003-0000-0000-0000-000000000000')$q$, 'ヒアリングと違います');
update public.gw_hr_hearings set exception_reason = '入社日は本人の退職交渉次第。報酬は Office で確定', exception_approved_by = 'a1430001-0000-0000-0000-000000000000',
       exception_approved_at = now() where id = 'f1430001-0000-0000-0000-000000000000';
select pg_temp.try('E4 社長判断が最新でない（根拠が違う）と引き渡せない',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, unresolved_items, exception_reason, exception_approved_by, exception_approved_at, handed_by)
     select '14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'd1430004-0000-0000-0000-000000000000',
            id, unresolved, exception_reason, exception_approved_by, exception_approved_at, 'a1430003-0000-0000-0000-000000000000'
       from public.gw_hr_hearings where id = 'f1430001-0000-0000-0000-000000000000'$q$, '最新ではありません');
select pg_temp.try('E5 引き渡しは「未着手」で記録する（状態を飛ばせない）',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, unresolved_items, exception_reason, exception_approved_by, exception_approved_at, handed_by, office_status)
     select '14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'd1430001-0000-0000-0000-000000000000',
            id, unresolved, exception_reason, exception_approved_by, exception_approved_at, 'a1430003-0000-0000-0000-000000000000', 'completed'
       from public.gw_hr_hearings where id = 'f1430001-0000-0000-0000-000000000000'$q$, '未着手');
select pg_temp.try('E6 そろえば引き渡せる（例外は承認と理由つき）',
  $q$insert into public.gw_hr_office_intakes(id, tenant_id, applicant_id, ceo_decision_id, hearing_id, hearing_snapshot, unresolved_items,
                                            exception_reason, exception_approved_by, exception_approved_at, handed_by, office_assignee_id)
     select 'aa430001-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000', 'd1430001-0000-0000-0000-000000000000',
            id, '{"job_title":"エンジニア"}', unresolved, exception_reason, exception_approved_by, exception_approved_at,
            'a1430003-0000-0000-0000-000000000000', 'e1430004-0000-0000-0000-000000000000'
       from public.gw_hr_hearings where id = 'f1430001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('E7 引き渡したらヒアリングが固定される',
  (select count(*)::int from public.gw_hr_hearings where id = 'f1430001-0000-0000-0000-000000000000' and locked_at is not null), 1);
-- 二重の引き渡し（同時押し・API 直呼びを含む）：2つ目は一意違反。新しいヒアリングを用意しても止まる
reset role;
insert into public.gw_hr_hearings(id, tenant_id, applicant_id, offer_type, job_title, duties, desired_join_date, work_location, remote_policy,
                                  weekly_days, weekly_hours, contract_period, unresolved, recorded_by, confirmed_by, confirmed_at)
  values ('f1430002-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'c1430001-0000-0000-0000-000000000000',
          'part_time', 'エンジニア', '開発', current_date + 30, '東京', '週2リモート', 3, 24, '期間の定めなし', '["desired_pay"]',
          'a1430003-0000-0000-0000-000000000000', 'a1430004-0000-0000-0000-000000000000', now());
update public.gw_hr_hearings set exception_reason = '報酬は Office で確定', exception_approved_by = 'a1430002-0000-0000-0000-000000000000', exception_approved_at = now()
 where id = 'f1430002-0000-0000-0000-000000000000';
set role service_role;
select pg_temp.try('E8 同じ応募者への2回目の引き渡しは入らない（一意違反）',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, unresolved_items, exception_reason, exception_approved_by, exception_approved_at, handed_by)
     select tenant_id, applicant_id, 'd1430001-0000-0000-0000-000000000000', id, unresolved, exception_reason, exception_approved_by, exception_approved_at, 'a1430004-0000-0000-0000-000000000000'
       from public.gw_hr_hearings where id = 'f1430002-0000-0000-0000-000000000000'$q$, 'uq_gw_hr_office_intakes_active');
select pg_temp.expect('E9 有効な引き渡しは1件だけ', (select count(*)::int from public.gw_hr_office_intakes where applicant_id = 'c1430001-0000-0000-0000-000000000000'), 1);
select pg_temp.try('E10 引き渡した人・日時は変えられない（service role でも）',
  $q$update public.gw_hr_office_intakes set handed_at = now() - interval '1 day' where id = 'aa430001-0000-0000-0000-000000000000'$q$, 'handed_at は引き渡したあと変更できません');
select pg_temp.try('E11 未確定の項目・例外の承認は変えられない',
  $q$update public.gw_hr_office_intakes set unresolved_items = '[]' where id = 'aa430001-0000-0000-0000-000000000000'$q$, 'unresolved_items は引き渡したあと変更できません');
select pg_temp.try('E12 引き渡しは削除できない',
  $q$delete from public.gw_hr_office_intakes where id = 'aa430001-0000-0000-0000-000000000000'$q$, '削除できません');
select pg_temp.try('E13 固定したヒアリングは変えられない',
  $q$update public.gw_hr_hearings set job_title = '別の職種' where id = 'f1430001-0000-0000-0000-000000000000'$q$, '引き渡したあと変更できません');
select pg_temp.try('E14 固定したヒアリングの給与も変えられない',
  $q$update public.gw_hr_hearing_pay set desired_note = '変更' where hearing_id = 'f1430001-0000-0000-0000-000000000000'$q$, '引き渡したあと変更できません');
select pg_temp.try('E15 Office の状態（PR B）は9つの値だけ',
  $q$update public.gw_hr_office_intakes set office_status = 'signed' where id = 'aa430001-0000-0000-0000-000000000000'$q$, 'gw_hr_office_intakes_status_chk');
select pg_temp.try('E16 Office の状態は進められる（受領・条件整理中）',
  $q$update public.gw_hr_office_intakes set office_status = 'organizing', received_by = 'a1430004-0000-0000-0000-000000000000', received_at = now()
     where id = 'aa430001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('E17 受領の記録は変えられない',
  $q$update public.gw_hr_office_intakes set received_at = now() + interval '1 hour' where id = 'aa430001-0000-0000-0000-000000000000'$q$, '受領の記録は変更できません');
select pg_temp.try('E18 履歴を足す（引き渡し）',
  $q$insert into public.gw_hr_office_intake_events(tenant_id, intake_id, applicant_id, kind, actor_id, fields)
     values ('14314314-0000-0000-0000-000000000001', 'aa430001-0000-0000-0000-000000000000', 'c1430001-0000-0000-0000-000000000000', 'handed_off',
             'a1430003-0000-0000-0000-000000000000', '["desired_join_date","desired_pay"]')$q$, 'ok');
select pg_temp.try('E19 履歴は別の応募者のものとして足せない',
  $q$insert into public.gw_hr_office_intake_events(tenant_id, intake_id, applicant_id, kind)
     values ('14314314-0000-0000-0000-000000000001', 'aa430001-0000-0000-0000-000000000000', 'c1430003-0000-0000-0000-000000000000', 'note')$q$, '会社・応募者が違います');
select pg_temp.try('E20 履歴は書き換え・削除できない',
  $q$delete from public.gw_hr_office_intake_events where intake_id = 'aa430001-0000-0000-0000-000000000000'$q$, '書き換え・削除できません');
-- 育成枠・オファーの版がある人（旧フロー）・終了した人は引き渡せない
insert into public.gw_hr_hearings(id, tenant_id, applicant_id, offer_type, job_title, duties, desired_join_date, work_location, remote_policy,
                                  weekly_days, weekly_hours, contract_period, unresolved, recorded_by, confirmed_by, confirmed_at)
  values ('f1430004-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'c1430004-0000-0000-0000-000000000000',
          'training', '育成', '研修', current_date + 30, '東京', 'なし', 5, 40, '3か月', '[]',
          'a1430003-0000-0000-0000-000000000000', 'a1430004-0000-0000-0000-000000000000', now());
insert into public.gw_hr_hearing_pay(hearing_id, tenant_id, applicant_id, desired_wage_type, desired_amount)
  values ('f1430004-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000001', 'c1430004-0000-0000-0000-000000000000', 'monthly', 200000);
select pg_temp.try('E21 育成枠は Office へ引き渡さない',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, handed_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430004-0000-0000-0000-000000000000', 'd1430004-0000-0000-0000-000000000000',
             'f1430004-0000-0000-0000-000000000000', 'a1430003-0000-0000-0000-000000000000')$q$, '育成枠');
select pg_temp.try('E22 オファーの版がある応募者（旧フロー）は引き渡せない',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, handed_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430002-0000-0000-0000-000000000000', 'd1430004-0000-0000-0000-000000000000',
             'f1430004-0000-0000-0000-000000000000', 'a1430003-0000-0000-0000-000000000000')$q$, '旧フロー');
reset role;
update public.gw_hr_applicants set status = 'declined' where id = 'c1430004-0000-0000-0000-000000000000';
set role service_role;
update public.gw_hr_hearings set offer_type = 'part_time' where id = 'f1430004-0000-0000-0000-000000000000';
select pg_temp.try('E23 辞退・見送りなど終了した応募者は引き渡せない',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, handed_by)
     values ('14314314-0000-0000-0000-000000000001', 'c1430004-0000-0000-0000-000000000000', 'd1430004-0000-0000-0000-000000000000',
             'f1430004-0000-0000-0000-000000000000', 'a1430003-0000-0000-0000-000000000000')$q$, '終了・辞退');
reset role;
select pg_temp.expect('E24 引き渡しても既存のオファー・承諾・正式契約・社員登録は変わらない（c1 にオファーの版は無く、employee_id も空）',
  (select count(*)::int from public.gw_hr_offers where applicant_id = 'c1430001-0000-0000-0000-000000000000')
  + (select count(*)::int from public.gw_hr_applicants where id = 'c1430001-0000-0000-0000-000000000000' and (employee_id is not null or status in ('accepted', 'done'))), 0);
select pg_temp.try_as('E25 引き渡し済みの人の状態は、画面から直接変えられない（社長でも）', 'a1430001-0000-0000-0000-000000000000',
  $q$update public.gw_hr_applicants set status = 'offer_review_pending' where id = 'c1430001-0000-0000-0000-000000000000'$q$, 'Office へ引き渡し済み');
select pg_temp.try_as('E26 引き渡し済みの人でも、メモなど状態以外はこれまでどおり直せる', 'a1430003-0000-0000-0000-000000000000',
  $q$update public.gw_hr_applicants set note = 'メモ' where id = 'c1430001-0000-0000-0000-000000000000'$q$, 'ok');

-- ---- 見える範囲（RLS） -----------------------------------------------------------
select pg_temp.expect('F1 採用担当は引き渡し・社長判断・ヒアリングを読める',
  (pg_temp.count_as('a1430003-0000-0000-0000-000000000000', 'public.gw_hr_office_intakes') = 1
   and pg_temp.count_as('a1430003-0000-0000-0000-000000000000', 'public.gw_hr_ceo_decisions') = 2
   and pg_temp.count_as('a1430003-0000-0000-0000-000000000000', 'public.gw_hr_hearings') = 3)::int, 1);
select pg_temp.expect('F2 採用担当は給与（ヒアリングの給与）を読めない',
  pg_temp.count_as('a1430003-0000-0000-0000-000000000000', 'public.gw_hr_hearing_pay'), 0);
select pg_temp.expect('F3 人事（給与を見られる人）は給与も読める',
  pg_temp.count_as('a1430004-0000-0000-0000-000000000000', 'public.gw_hr_hearing_pay'), 2);
select pg_temp.expect('F4 一般メンバーは何も読めない',
  pg_temp.count_as('a1430005-0000-0000-0000-000000000000', 'public.gw_hr_office_intakes')
  + pg_temp.count_as('a1430005-0000-0000-0000-000000000000', 'public.gw_hr_ceo_decisions')
  + pg_temp.count_as('a1430005-0000-0000-0000-000000000000', 'public.gw_hr_office_intake_events'), 0);
select pg_temp.expect('F5 他社の社長はこの会社のものを読めない',
  pg_temp.count_as('a1430006-0000-0000-0000-000000000000', 'public.gw_hr_office_intakes')
  + pg_temp.count_as('a1430006-0000-0000-0000-000000000000', 'public.gw_hr_hearing_pay'), 0);
select pg_temp.try_as('F6 人事でも画面から直接は引き渡しを書けない', 'a1430004-0000-0000-0000-000000000000',
  $q$update public.gw_hr_office_intakes set office_status = 'contracting' where id = 'aa430001-0000-0000-0000-000000000000'$q$, 'permission denied');
select pg_temp.try_as('F7 画面から直接は給与を書けない', 'a1430004-0000-0000-0000-000000000000',
  $q$update public.gw_hr_hearing_pay set desired_amount = 1 where hearing_id = 'f1430002-0000-0000-0000-000000000000'$q$, 'permission denied');

-- ---- 応募者の削除 --------------------------------------------------------------
select pg_temp.try_as('G1 引き渡し・社長判断がある応募者は削除できない', 'a1430003-0000-0000-0000-000000000000',
  $q$delete from public.gw_hr_applicants where id = 'c1430001-0000-0000-0000-000000000000'$q$, '契約の履歴');
select pg_temp.try_as('G2 オファーの版・引き渡し（handoff_at）がある旧フローの応募者も削除できない', 'a1430004-0000-0000-0000-000000000000',
  $q$delete from public.gw_hr_applicants where id = 'c1430002-0000-0000-0000-000000000000'$q$, 'オファー・条件の版');
select pg_temp.try('G3 service role で消そうとしても止まる',
  $q$set local role service_role; delete from public.gw_hr_applicants where id = 'c1430002-0000-0000-0000-000000000000'$q$, '契約の履歴');
reset role;
select pg_temp.expect('G4 止まったときはオファーも応募者も残る',
  (select count(*)::int from public.gw_hr_offers where id = 'b1430002-0000-0000-0000-000000000000')
  + (select count(*)::int from public.gw_hr_applicants where id in ('c1430001-0000-0000-0000-000000000000', 'c1430002-0000-0000-0000-000000000000')), 3);
select pg_temp.try_as('G5 履歴の無い応募者（登録ミス）はこれまでどおり削除できる', 'a1430003-0000-0000-0000-000000000000',
  $q$delete from public.gw_hr_applicants where id = 'c1430003-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('G6 消えた', (select count(*)::int from public.gw_hr_applicants where id = 'c1430003-0000-0000-0000-000000000000'), 0);

-- ---- 差し戻し（誤操作。行は消さない）→ 新しい引き渡し --------------------------------
set role service_role;
select pg_temp.try('H1 差し戻しには理由が要る',
  $q$update public.gw_hr_office_intakes set returned_at = now(), returned_by = 'a1430001-0000-0000-0000-000000000000' where id = 'aa430001-0000-0000-0000-000000000000'$q$, 'gw_hr_office_intakes_return_chk');
select pg_temp.try('H2 差し戻す（理由つき）',
  $q$update public.gw_hr_office_intakes set returned_at = now(), returned_by = 'a1430001-0000-0000-0000-000000000000', return_reason = '担当の誤操作'
     where id = 'aa430001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('H3 差し戻した引き渡しは変えられない',
  $q$update public.gw_hr_office_intakes set office_status = 'contracting' where id = 'aa430001-0000-0000-0000-000000000000'$q$, '差し戻した引き渡しは変更できません');
select pg_temp.try('H4 差し戻したあとは新しい引き渡しを足せる（前の行は残る）',
  $q$insert into public.gw_hr_office_intakes(tenant_id, applicant_id, ceo_decision_id, hearing_id, unresolved_items, exception_reason, exception_approved_by, exception_approved_at, handed_by)
     select tenant_id, applicant_id, 'd1430001-0000-0000-0000-000000000000', id, unresolved, exception_reason, exception_approved_by, exception_approved_at, 'a1430004-0000-0000-0000-000000000000'
       from public.gw_hr_hearings where id = 'f1430002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('H5 履歴は2件（差し戻した1件＋有効な1件）',
  (select count(*)::int from public.gw_hr_office_intakes where applicant_id = 'c1430001-0000-0000-0000-000000000000'), 2);
reset role;
select pg_temp.expect('H6 確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);

-- ---- 戻す・もう一度流す --------------------------------------------------------
select pg_temp.try('R1 有効な引き渡しがあると、戻す SQL は止まる', :'crb', '有効な早期引き渡し');
select pg_temp.expect('R2 止まったときは何も変えていない', pg_temp.has_tbl('gw_hr_office_intakes') + pg_temp.has_tbl('gw_hr_ceo_decisions')
  + (select count(*)::int from pg_trigger where tgname = 'gw_hr_applicants_guard'), 3);
set role service_role;
update public.gw_hr_office_intakes set returned_at = now(), returned_by = 'a1430001-0000-0000-0000-000000000000', return_reason = '戻す SQL の確認'
 where returned_at is null;
reset role;
select pg_temp.try('R3 差し戻したあとなら戻せる', :'crb', 'ok');
select pg_temp.expect('R4 表・trigger・関数が消える',
  pg_temp.has_tbl('gw_hr_ceo_decisions') + pg_temp.has_tbl('gw_hr_hearings') + pg_temp.has_tbl('gw_hr_hearing_pay')
  + pg_temp.has_tbl('gw_hr_office_intakes') + pg_temp.has_tbl('gw_hr_office_intake_events')
  + (select count(*)::int from pg_trigger where tgname like 'gw_hr_%' and tgname in ('gw_hr_applicants_guard', 'gw_hr_office_intakes_guard'))
  + (select count(*)::int from pg_proc where proname in ('gw_hr_is_hire_decider', 'gw_hr_applicants_guard', 'gw_hr_applicant_contract_history')), 0);
select pg_temp.expect('R5 既存の応募者・オファー（handoff_at）はそのまま',
  (select count(*)::int from public.gw_hr_offers where id = 'b1430002-0000-0000-0000-000000000000' and handoff_at is not null)
  + (select count(*)::int from public.gw_hr_applicants where id = 'c1430001-0000-0000-0000-000000000000'), 2);
select pg_temp.expect('R6 db/133・139 の確認 SQL は ❌ が無いまま', pg_temp.check_fails(:'cchk133') + pg_temp.check_fails(:'cchk139'), 0);
select pg_temp.try('R7 もう一度流せる', :'c143', 'ok');
select pg_temp.expect('R8 流し直したあとも確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
-- 会社ごと消す（tenants からの cascade）は、履歴の無い会社なら止めない
insert into public.tenants(id, name) values ('14314314-0000-0000-0000-000000000009', '消す会社');
insert into public.gw_hr_applicants(id, tenant_id, name, job_title, source) values
  ('c1430009-0000-0000-0000-000000000000', '14314314-0000-0000-0000-000000000009', '消す会社の応募者', 'テスト', 'テスト');
insert into public.gw_hr_offers(tenant_id, applicant_id, version, token_hash, expires_at, offer_type) values
  ('14314314-0000-0000-0000-000000000009', 'c1430009-0000-0000-0000-000000000000', 1, 'k9', now() + interval '3 days', 'part_time');
select pg_temp.try('R9 会社ごと消すとき（cascade）は応募者の安全装置で止まらない',
  $q$delete from public.tenants where id = '14314314-0000-0000-0000-000000000009'$q$, 'ok');
