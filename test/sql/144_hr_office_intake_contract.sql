-- db/144_hr_office_intake_contract.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（db/143）が無い DB では、144 は何も変えずにエラーで止まる。確認 SQL は流す前でもエラーにならない
--   ・2回流しても同じ（べき等）。既存の行は1行も変えない
--   ・引き渡しと版（offer_id）は同じ会社・同じ応募者だけ結べる（service role でも）
--   ・完了は社員登録のあとだけ・辞退／不成立は社員登録の前だけ・差し戻しは版を作る前だけ（service role でも）
--   ・画面から直接（authenticated）は、引き渡し済みの人の版を足せない・変えられない。旧フローの人はこれまでどおり書ける
--   ・サーバ（service role。Office の API・本人の承諾）は、引き渡し済みの人の版を作れる・進められる
--   ・db/143 の確認 SQL・db/133・139 の確認 SQL は ❌ が無いまま（既存の trigger・制約は変えていない）
--   ・戻す SQL で trigger・関数が消え、データは残る。もう一度流せる
--
\set ON_ERROR_STOP 0
\set c129 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/129_hr_offer_type.sql"`
\set c132 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/132_hr_offer_documents.sql"`
\set c133 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/133_hr_offer_handoff.sql"`
\set c137 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/137_hr_finish.sql"`
\set c139 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/139_hr_contract_procedure.sql"`
\set c143 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/143_hr_office_intake.sql"`
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
\set c144 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/144_hr_office_intake_contract.sql"`
\set crb144 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_144_hr_office_intake_contract.sql"`
\set cchk143 `sed 's/;\s*$//' "$SCEN_ROOT/db/check_143_hr_office_intake.sql"`
\set cchk144 `sed 's/;\s*$//' "$SCEN_ROOT/db/check_144_hr_office_intake_contract.sql"`

alter default privileges in schema public grant all on tables to authenticated, service_role;

-- ---- 前提が無い DB では止まる -------------------------------------------------
select pg_temp.try('A1 db/129・132・133・137・139 を流す', :'c129' || ';' || :'c132' || ';' || :'c133' || ';' || :'c137' || ';' || :'c139', 'ok');
select pg_temp.try('A2 db/143 の前に流すと止まる', :'c144', 'db/143_hr_office_intake.sql');
select pg_temp.expect('A3 止まったときは何も足していない', (select count(*)::int from pg_proc where proname in ('gw_hr_office_intakes_link', 'gw_hr_offers_intake_guard')), 0);
select pg_temp.expect('A4 流す前の確認 SQL はエラーにならず ❌ が並ぶ', (pg_temp.check_fails(:'cchk144') >= 3)::int, 1);
select pg_temp.try('A5 db/143 を流す', :'c143', 'ok');

-- 会社・人（実在の人ではない）：…01 経営者／…03 採用担当／…04 人事
insert into public.tenants(id, name) values
  ('14414414-0000-0000-0000-000000000001', 'テスト会社'), ('14414414-0000-0000-0000-000000000002', '別の会社');
insert into auth.users(id, email) values
  ('a1440001-0000-0000-0000-000000000000', 'owner@example.test'),
  ('a1440003-0000-0000-0000-000000000000', 'recruiter@example.test'),
  ('a1440004-0000-0000-0000-000000000000', 'hr@example.test');
insert into public.gw_employees(id, tenant_id, user_id, display_name, email, status) values
  ('e1440001-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', 'a1440001-0000-0000-0000-000000000000', '社長', 'owner@example.test', 'active'),
  ('e1440003-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', 'a1440003-0000-0000-0000-000000000000', '採用', 'recruiter@example.test', 'active'),
  ('e1440004-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', 'a1440004-0000-0000-0000-000000000000', '人事', 'hr@example.test', 'active'),
  ('e1440009-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', null, '新しく入社した人', 'new@example.test', 'active');
insert into public.gw_role_grants(tenant_id, employee_id, role) values
  ('14414414-0000-0000-0000-000000000001', 'e1440001-0000-0000-0000-000000000000', 'owner'),
  ('14414414-0000-0000-0000-000000000001', 'e1440003-0000-0000-0000-000000000000', 'recruiter'),
  ('14414414-0000-0000-0000-000000000001', 'e1440004-0000-0000-0000-000000000000', 'hr');

-- 応募者：n1・n2・n3 新フロー（社長合格 → ヒアリング → 引き渡し）／o1 旧フロー（オファーの版を HR で作る）
insert into public.gw_hr_applicants(id, tenant_id, name, email, job_title, source, stage, status) values
  ('c1440001-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', '新 一', 'n1@example.test', 'テスト', 'テスト', 'ceo_interview', 'ceo_decision_pending'),
  ('c1440002-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', '新 二', 'n2@example.test', 'テスト', 'テスト', 'ceo_interview', 'ceo_decision_pending'),
  ('c1440003-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', '新 三', 'n3@example.test', 'テスト', 'テスト', 'ceo_interview', 'ceo_decision_pending'),
  ('c1440004-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', '旧 四', 'o1@example.test', 'テスト', 'テスト', 'offer', 'offer_draft_pending');
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type) values
  ('b1440004-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', 'c1440004-0000-0000-0000-000000000000', 1, 'k4', now() + interval '3 days', 'part_time');

set role service_role;
-- 3人を社長合格 → ヒアリング（確認済み・不足なし）→ 引き渡す
do $$
declare i int; aid uuid; did uuid; hid uuid;
begin
  for i in 1..3 loop
    aid := ('c144000' || i || '-0000-0000-0000-000000000000')::uuid;
    did := ('d144000' || i || '-0000-0000-0000-000000000000')::uuid;
    hid := ('f144000' || i || '-0000-0000-0000-000000000000')::uuid;
    insert into public.gw_hr_ceo_decisions(id, tenant_id, applicant_id, decision, decided_by)
      values (did, '14414414-0000-0000-0000-000000000001', aid, 'pass', 'a1440001-0000-0000-0000-000000000000');
    insert into public.gw_hr_hearings(id, tenant_id, applicant_id, offer_type, job_title, duties, desired_join_date, work_location, remote_policy,
                                      weekly_days, weekly_hours, contract_period, unresolved, recorded_by, confirmed_by, confirmed_at)
      values (hid, '14414414-0000-0000-0000-000000000001', aid, 'part_time', '事務', '経理補助', current_date + 30, '東京', '出社',
              3, 18, '期間の定めなし', '[]', 'a1440003-0000-0000-0000-000000000000', 'a1440004-0000-0000-0000-000000000000', now());
    insert into public.gw_hr_hearing_pay(hearing_id, tenant_id, applicant_id, desired_wage_type, desired_amount, updated_by)
      values (hid, '14414414-0000-0000-0000-000000000001', aid, '時給', 1500, 'a1440004-0000-0000-0000-000000000000');
    insert into public.gw_hr_office_intakes(id, tenant_id, applicant_id, ceo_decision_id, hearing_id, unresolved_items, handed_by)
      values (('aa44000' || i || '-0000-0000-0000-000000000000')::uuid, '14414414-0000-0000-0000-000000000001', aid, did, hid, '[]',
              'a1440004-0000-0000-0000-000000000000');
  end loop;
end $$;
reset role;

select pg_temp.try('A6 db/144 を流す', :'c144', 'ok');
select pg_temp.try('A7 もう一度流しても同じ（べき等）', :'c144', 'ok');
select pg_temp.expect('A8 確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk144'), 0);
select pg_temp.expect('A9 db/143・133・139 の確認 SQL も ❌ が無い（それらは変えていない）',
  pg_temp.check_fails(:'cchk143') + pg_temp.check_fails(:'cchk133') + pg_temp.check_fails(:'cchk139'), 0);
select pg_temp.expect('A10 既存の行は変えない（引き渡し3件は未着手・版の結びつけなし。旧フローの版はそのまま）',
  (select count(*)::int from public.gw_hr_office_intakes where office_status = 'not_started' and offer_id is null)
  + (select count(*)::int from public.gw_hr_offers where id = 'b1440004-0000-0000-0000-000000000000' and revoked_at is null), 4);

-- ---- 画面から直接（authenticated）：引き渡し済みの人の版は書けない ---------------------------
select pg_temp.try_as('B1 採用担当は画面から直接、引き渡し済みの人の版を足せない', 'a1440003-0000-0000-0000-000000000000',
  $q$insert into public.gw_hr_offers(tenant_id, applicant_id, version, token_hash, expires_at, offer_type)
     values ('14414414-0000-0000-0000-000000000001', 'c1440001-0000-0000-0000-000000000000', 1, 'kx', now() + interval '3 days', 'part_time')$q$,
  'Office の手続きで進めます');
select pg_temp.try_as('B2 旧フローの人の版は、これまでどおり画面から直接直せる（RLS どおり）', 'a1440003-0000-0000-0000-000000000000',
  $q$update public.gw_hr_offers set job_title = '経理' where id = 'b1440004-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('B3 旧フローの版は直った', (select count(*)::int from public.gw_hr_offers where id = 'b1440004-0000-0000-0000-000000000000' and job_title = '経理'), 1);

-- ---- サーバ（service role。Office の API）は版を作れる・結べる ---------------------------------
set role service_role;
select pg_temp.try('C1 Office（service role）は引き渡し済みの人の版を作れる',
  $q$insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type, doc_route)
     values ('b1440001-0000-0000-0000-000000000000', '14414414-0000-0000-0000-000000000001', 'c1440001-0000-0000-0000-000000000000', 1, 'k1',
             now() + interval '3 days', 'part_time', 'official')$q$, 'ok');
select pg_temp.try('C2 引き渡しに別の応募者の版は結べない',
  $q$update public.gw_hr_office_intakes set offer_id = 'b1440004-0000-0000-0000-000000000000' where id = 'aa440001-0000-0000-0000-000000000000'$q$, '同じ会社・同じ応募者の版だけ');
select pg_temp.try('C3 同じ応募者の版は結べる（受領・条件整理中と一緒に）',
  $q$update public.gw_hr_office_intakes set offer_id = 'b1440001-0000-0000-0000-000000000000', office_status = 'organizing',
            received_at = now(), received_by = 'a1440004-0000-0000-0000-000000000000' where id = 'aa440001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('C4 結んだ版は変えられない（db/143 のまま）',
  $q$update public.gw_hr_office_intakes set offer_id = null where id = 'aa440001-0000-0000-0000-000000000000'$q$, '一度決めたら変更できません');
reset role;
select pg_temp.try_as('C5 版を作ったあとも、採用担当は画面から直接その版を直せない', 'a1440003-0000-0000-0000-000000000000',
  $q$update public.gw_hr_offers set job_title = '別の職種' where id = 'b1440001-0000-0000-0000-000000000000'$q$, 'Office の手続きで進めます');

-- ---- 完了・辞退・差し戻し ---------------------------------------------------------------
set role service_role;
select pg_temp.try('D1 版を作ったあとは差し戻せない',
  $q$update public.gw_hr_office_intakes set returned_at = now(), returned_by = 'a1440001-0000-0000-0000-000000000000', return_reason = '誤り'
     where id = 'aa440001-0000-0000-0000-000000000000'$q$, '版を作ったあとは差し戻せません');
select pg_temp.try('D2 社員登録の前は完了にできない',
  $q$update public.gw_hr_office_intakes set office_status = 'completed' where id = 'aa440002-0000-0000-0000-000000000000'$q$, '社員登録のあとだけ');
select pg_temp.try('D3 版の無い引き渡しは差し戻せる（理由つき・行は残る）',
  $q$update public.gw_hr_office_intakes set returned_at = now(), returned_by = 'a1440001-0000-0000-0000-000000000000', return_reason = '相手を取り違えた'
     where id = 'aa440002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('D4 差し戻した行は残る', (select count(*)::int from public.gw_hr_office_intakes where id = 'aa440002-0000-0000-0000-000000000000' and returned_at is not null), 1);
reset role;
update public.gw_hr_applicants set employee_id = 'e1440009-0000-0000-0000-000000000000' where id = 'c1440003-0000-0000-0000-000000000000';
set role service_role;
select pg_temp.try('D5 社員登録のあとは辞退・不成立にできない',
  $q$update public.gw_hr_office_intakes set office_status = 'withdrawn', closed_at = now(), closed_by = 'a1440004-0000-0000-0000-000000000000', closed_reason = '辞退'
     where id = 'aa440003-0000-0000-0000-000000000000'$q$, '辞退・不成立にできません');
select pg_temp.try('D6 社員登録のあとは完了にできる',
  $q$update public.gw_hr_office_intakes set office_status = 'completed' where id = 'aa440003-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('D7 社員登録の前なら辞退・不成立にできる（理由つき）',
  $q$update public.gw_hr_office_intakes set office_status = 'withdrawn', closed_at = now(), closed_by = 'a1440004-0000-0000-0000-000000000000', closed_reason = '辞退：他社に決定'
     where id = 'aa440001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('D8 辞退・不成立のあとは状態を変えられない（db/143 のまま）',
  $q$update public.gw_hr_office_intakes set office_status = 'organizing' where id = 'aa440001-0000-0000-0000-000000000000'$q$, '状態を変えられません');
reset role;
select pg_temp.expect('D9 確認 SQL に ❌ が無い（結んだ版は同じ応募者・完了は社員登録済み）', pg_temp.check_fails(:'cchk144'), 0);

-- ---- 戻す・もう一度流す --------------------------------------------------------
select pg_temp.try('R1 戻す SQL を流す', :'crb144', 'ok');
select pg_temp.expect('R2 trigger・関数が消え、データは残る',
  (select count(*)::int from pg_trigger where tgname in ('gw_hr_office_intakes_link', 'gw_hr_offers_intake_guard'))
  + (select count(*)::int from pg_proc where proname in ('gw_hr_office_intakes_link', 'gw_hr_offers_intake_guard')), 0);
select pg_temp.expect('R3 引き渡し・版はそのまま', (select count(*)::int from public.gw_hr_office_intakes) + (select count(*)::int from public.gw_hr_offers), 5);
select pg_temp.expect('R4 db/143 の確認 SQL は ❌ が無いまま', pg_temp.check_fails(:'cchk143'), 0);
select pg_temp.try('R5 もう一度戻しても止まらない', :'crb144', 'ok');
select pg_temp.try('R6 もう一度流せる', :'c144', 'ok');
select pg_temp.expect('R7 流し直したあとも確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk144'), 0);
-- db/143 を戻すとき（db/144 を先に戻し忘れても）、db/144 の trigger・関数も外れる（版の書き込みが壊れない）
\set crb143 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_143_hr_office_intake.sql"`
alter table public.gw_hr_office_intakes disable trigger user;   -- テストのためだけ：残っている引き渡しを差し戻し済みにする
update public.gw_hr_office_intakes set returned_at = now(), returned_by = 'a1440001-0000-0000-0000-000000000000', return_reason = '戻す SQL の確認'
 where returned_at is null;
alter table public.gw_hr_office_intakes enable trigger user;
select pg_temp.try('R8 db/144 が入ったままでも db/143 を戻せる', :'crb143', 'ok');
select pg_temp.expect('R9 db/144 の trigger・関数も消える',
  (select count(*)::int from pg_trigger where tgname in ('gw_hr_office_intakes_link', 'gw_hr_offers_intake_guard'))
  + (select count(*)::int from pg_proc where proname in ('gw_hr_office_intakes_link', 'gw_hr_offers_intake_guard')), 0);
select pg_temp.try_as('R10 戻したあとも、旧フローの版は画面から直接直せる（壊れた trigger が残らない）', 'a1440003-0000-0000-0000-000000000000',
  $q$update public.gw_hr_offers set job_title = '総務' where id = 'b1440004-0000-0000-0000-000000000000'$q$, 'ok');
