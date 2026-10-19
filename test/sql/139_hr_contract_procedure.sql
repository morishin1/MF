-- db/139_hr_contract_procedure.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（db/132・133・137 の列）が無い DB では、139 は何も変えずにエラーで止まる。確認 SQL は流す前でもエラーにならない
--   ・2回流しても同じ（べき等）。既存のオファーは変えない（doc_route は空のまま。古いアプリの送付は止まらない）
--   ・正式PDFの受領記録：ハッシュの形・大きさ・承認には確認者・差し戻しには理由。中身は変えられない
--     承認は条件の版ごとに1つ。確認待ち → 承認・差し戻し・差し替え、承認 → 差し替え の向きだけ。確認の記録は変えられない
--     本人へ案内した版は差し替えにできない
--   ・社労士への依頼の記録は書き換えられない（足すだけ）
--   ・正式PDFで案内する版：正式PDFを固定しないと送付済みにできない・固定した正式PDFは本人に見せる通知書と同じ
--     LegalSign に登録した版・締結した版は、案内した版と同じハッシュでなければ入らない
--     締結は証跡が要る・本人の同意の前でも締結を記録できる（これまでの版は従来どおり同意のあとだけ）
--     流れ・案内した正式PDF・締結の証跡は書き換えられない（service_role でも）
--   ・見える範囲：採用HRの人は読める・一般メンバー・他社は読めない・ログインした人は書けない
--   ・戻す SQL：同意の前に締結を記録した版があれば止まる（何も変えない）。無ければ表・列が消え、db/132 の形に戻る。もう一度流せる
--
\set ON_ERROR_STOP 0
\set c129 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/129_hr_offer_type.sql"`
\set c132 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/132_hr_offer_documents.sql"`
\set c133 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/133_hr_offer_handoff.sql"`
\set c137 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/137_hr_finish.sql"`
\set c139 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/139_hr_contract_procedure.sql"`
\set crb `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_139_hr_contract_procedure.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_139_hr_contract_procedure.sql"`
\set cchk132 `sed 's/;\s*$//' "$SCEN_ROOT/db/check_132_hr_offer_documents.sql"`
\set cchk133 `sed 's/;\s*$//' "$SCEN_ROOT/db/check_133_hr_offer_handoff.sql"`

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
create or replace function pg_temp.has_col(c text) returns int language sql as $$
  select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = c $$;
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

-- Supabase は新しい表に、ログインした人（authenticated）への権限を自動で付ける。その代わり（139 が外すことを確かめる）
alter default privileges in schema public grant all on tables to authenticated, service_role;

-- ---- 前提が無い DB では止まる -------------------------------------------------
select pg_temp.try('A1 db/129 を流す', :'c129', 'ok');
select pg_temp.try('A2 db/132 の前に流すと止まる', :'c139', 'db/132_hr_offer_documents.sql');
select pg_temp.expect('A3 止まったときは列も表も足していない',
  pg_temp.has_col('doc_route') + (to_regclass('public.gw_hr_offer_official_docs') is not null)::int, 0);
select pg_temp.expect('A4 流す前の確認 SQL はエラーにならず ❌ が並ぶ', (pg_temp.check_fails(:'cchk') >= 8)::int, 1);
select pg_temp.try('A5 db/132 を流す', :'c132', 'ok');
select pg_temp.try('A6 db/133 の前に流すと止まる', :'c139', 'db/133_hr_offer_handoff.sql');
select pg_temp.try('A7 db/133 を流す', :'c133', 'ok');
select pg_temp.try('A8 db/137 の前に流すと止まる', :'c139', 'db/137_hr_finish.sql');
select pg_temp.try('A9 db/137 を流す', :'c137', 'ok');

-- 流す前からあるオファー（実在の応募者ではない）：承諾済みで正式契約済みの正社員、下書きのパート
insert into public.tenants(id, name) values
  ('13913913-0000-0000-0000-000000000001', 'テスト会社'), ('13913913-0000-0000-0000-000000000002', '別の会社');
insert into auth.users(id, email) values
  ('a1390001-0000-0000-0000-000000000000', 'hr@example.test'),
  ('a1390002-0000-0000-0000-000000000000', 'member@example.test'),
  ('a1390003-0000-0000-0000-000000000000', 'other-hr@example.test'),
  ('a1390004-0000-0000-0000-000000000000', 'reviewer@example.test');
insert into public.gw_employees(id, tenant_id, user_id, display_name, email, status) values
  ('a1390001-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'a1390001-0000-0000-0000-000000000000', '人事', 'hr@example.test', 'active'),
  ('a1390002-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'a1390002-0000-0000-0000-000000000000', '一般', 'member@example.test', 'active'),
  ('a1390003-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000002', 'a1390003-0000-0000-0000-000000000000', '他社人事', 'other-hr@example.test', 'active');
insert into public.gw_role_grants(tenant_id, employee_id, role) values
  ('13913913-0000-0000-0000-000000000001', 'a1390001-0000-0000-0000-000000000000', 'hr'),
  ('13913913-0000-0000-0000-000000000002', 'a1390003-0000-0000-0000-000000000000', 'hr');
insert into public.gw_hr_applicants(id, tenant_id, name, email, job_title, source) values
  ('c1390001-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'テスト 候補者', 'candidate@example.test', 'テスト', 'テスト'),
  ('c1390002-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000002', '別社 候補者', 'other@example.test', 'テスト', 'テスト');
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type, sent_at, accepted_at,
                                notice_title, notice_pdf_path, notice_pdf_sha256) values
  ('b1390001-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 101, 'p1',
   now() + interval '3 days', 'executive_employee', now() - interval '3 days', now() - interval '2 days',
   '労働条件通知書', 't/offers/a/b1/notice-v101.pdf', repeat('b', 64));
update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/old', formal_signed_at = now(), formal_signed_by = 'a1390001-0000-0000-0000-000000000000'
 where id = 'b1390001-0000-0000-0000-000000000000';
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type) values
  ('b1390002-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 102, 'p2',
   now() + interval '3 days', 'part_time');

select pg_temp.try('A10 db/139 を流す', :'c139', 'ok');
select pg_temp.try('A11 もう一度流しても同じ（べき等）', :'c139', 'ok');
select pg_temp.expect('A12 確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
select pg_temp.expect('A13 db/132・133 の確認 SQL も ❌ が無い（それらの trigger・function は変えていない）',
  pg_temp.check_fails(:'cchk132') + pg_temp.check_fails(:'cchk133'), 0);
select pg_temp.expect('A14 既存のオファーは変えない（doc_route は空のまま）',
  (select count(*)::int from public.gw_hr_offers where doc_route is not null), 0);
select pg_temp.try('A15 古いアプリ（doc_route を書かない）の送付は止まらない',
  $q$update public.gw_hr_offers set sent_at = now(), notice_title = '労働条件通知書', notice_pdf_path = 't/offers/a/b2/notice-v102.pdf', notice_pdf_sha256 = repeat('c', 64)
     where id = 'b1390002-0000-0000-0000-000000000000'$q$, 'ok');

-- ---- 正式PDFの受領記録 ------------------------------------------------------
-- e1：これから正式PDFで案内する正社員（まだ送っていない）
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type, doc_route) values
  ('e1390001-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 1, 'h1',
   now() + interval '3 days', 'executive_employee', 'official'),
  ('e1390002-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 2, 'h2',
   now() + interval '3 days', 'contractor', 'official');

select pg_temp.try('B1 正式PDFを受け取る（版1・確認待ち）',
  $q$insert into public.gw_hr_offer_official_docs(id, tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, file_name, received_on, author_name, uploaded_by)
     values ('d1390001-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000',
             1, 'labor_notice', '労働条件通知書', 't/offers/a/e1/official-r1.pdf', repeat('1', 64), 12345, '通知書.pdf', current_date, '〇〇社労士事務所', 'a1390001-0000-0000-0000-000000000000')$q$, 'ok');
select pg_temp.try('B2 ハッシュの形が違うと入らない',
  $q$insert into public.gw_hr_offer_official_docs(tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, received_on, uploaded_by)
     values ('13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000',
             2, 'labor_notice', '労働条件通知書', 'x.pdf', 'ABC', 10, current_date, 'a1390001-0000-0000-0000-000000000000')$q$, 'gw_hr_offer_official_docs_file_chk');
select pg_temp.try('B3 15MB を超えるファイルは入らない',
  $q$insert into public.gw_hr_offer_official_docs(tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, received_on, uploaded_by)
     values ('13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000',
             2, 'labor_notice', '労働条件通知書', 'x.pdf', repeat('2', 64), 15728641, current_date, 'a1390001-0000-0000-0000-000000000000')$q$, 'gw_hr_offer_official_docs_file_chk');
select pg_temp.try('B4 書類の種類は決まった値だけ',
  $q$insert into public.gw_hr_offer_official_docs(tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, received_on, uploaded_by)
     values ('13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000',
             2, 'resume', '履歴書', 'x.pdf', repeat('2', 64), 10, current_date, 'a1390001-0000-0000-0000-000000000000')$q$, 'gw_hr_offer_official_docs_kind_chk');
select pg_temp.try('B5 承認には確認した人と日時が要る',
  $q$update public.gw_hr_offer_official_docs set status = 'approved' where id = 'd1390001-0000-0000-0000-000000000000'$q$, 'gw_hr_offer_official_docs_review_chk');
select pg_temp.try('B6 差し戻しには理由が要る',
  $q$update public.gw_hr_offer_official_docs set status = 'returned', reviewed_by = 'a1390004-0000-0000-0000-000000000000', reviewed_at = now() where id = 'd1390001-0000-0000-0000-000000000000'$q$, 'gw_hr_offer_official_docs_return_chk');
select pg_temp.try('B7 受け取った中身（ハッシュ）は変えられない',
  $q$update public.gw_hr_offer_official_docs set file_sha256 = repeat('9', 64) where id = 'd1390001-0000-0000-0000-000000000000'$q$, 'file_sha256 は変更できません');
select pg_temp.try('B8 受領日・作成者も変えられない（service_role でも）',
  $q$set local role service_role; update public.gw_hr_offer_official_docs set author_name = '別の事務所' where id = 'd1390001-0000-0000-0000-000000000000'$q$, 'author_name は変更できません');
reset role;
select pg_temp.try('B9 差し戻す（理由つき）',
  $q$update public.gw_hr_offer_official_docs set status = 'returned', reviewed_by = 'a1390004-0000-0000-0000-000000000000', reviewed_at = now(), review_note = '試用期間の記載が条件と違う'
     where id = 'd1390001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('B10 差し戻した版は承認にできない（新しい版を受け取る）',
  $q$update public.gw_hr_offer_official_docs set status = 'approved' where id = 'd1390001-0000-0000-0000-000000000000'$q$, 'returned から approved へ変えられません');
select pg_temp.try('B11 差し戻しの理由は書き換えられない',
  $q$update public.gw_hr_offer_official_docs set review_note = '別の理由' where id = 'd1390001-0000-0000-0000-000000000000'$q$, 'review_note は確認のあとに変更できません');
insert into public.gw_hr_offer_official_docs(id, tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, received_on, uploaded_by) values
  ('d1390002-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000',
   2, 'labor_notice', '労働条件通知書', 't/offers/a/e1/official-r2.pdf', repeat('a', 64), 23456, current_date, 'a1390001-0000-0000-0000-000000000000'),
  ('d1390003-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000',
   3, 'labor_notice', '労働条件通知書', 't/offers/a/e1/official-r3.pdf', repeat('d', 64), 23456, current_date, 'a1390001-0000-0000-0000-000000000000');
select pg_temp.try('B12 同じ版番号は2つ入らない',
  $q$insert into public.gw_hr_offer_official_docs(tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, received_on, uploaded_by)
     values ('13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000',
             2, 'labor_notice', '労働条件通知書', 'y.pdf', repeat('3', 64), 10, current_date, 'a1390001-0000-0000-0000-000000000000')$q$, 'gw_hr_offer_official_docs_rev_uq');
select pg_temp.try('B13 版2を承認する',
  $q$update public.gw_hr_offer_official_docs set status = 'approved', reviewed_by = 'a1390004-0000-0000-0000-000000000000', reviewed_at = now(), checks = '{"name":true,"salary":true}'
     where id = 'd1390002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('B14 同じ条件の版に、承認した正式PDFは1つだけ',
  $q$update public.gw_hr_offer_official_docs set status = 'approved', reviewed_by = 'a1390004-0000-0000-0000-000000000000', reviewed_at = now()
     where id = 'd1390003-0000-0000-0000-000000000000'$q$, 'uq_gw_hr_offer_official_docs_approved');
select pg_temp.try('B15 承認した版を確認待ちに戻せない',
  $q$update public.gw_hr_offer_official_docs set status = 'received', reviewed_by = null, reviewed_at = null where id = 'd1390002-0000-0000-0000-000000000000'$q$, 'approved から received へ変えられません');
select pg_temp.try('B16 確認の結果（照合の記録）は書き換えられない',
  $q$update public.gw_hr_offer_official_docs set checks = '{}' where id = 'd1390002-0000-0000-0000-000000000000'$q$, 'checks は確認のあとに変更できません');
select pg_temp.try('B17 使わなくなった確認待ちの版は差し替えにできる',
  $q$update public.gw_hr_offer_official_docs set status = 'superseded' where id = 'd1390003-0000-0000-0000-000000000000'$q$, 'ok');

-- ---- 社労士への依頼の記録 ------------------------------------------------------
select pg_temp.try('C1 依頼済みを記録する',
  $q$insert into public.gw_hr_attorney_requests(id, tenant_id, applicant_id, offer_id, kind, note, missing_labels, requested_by)
     values ('f1390001-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000',
             'initial', 'Slack #社労士 で依頼', array['休憩'], 'a1390001-0000-0000-0000-000000000000')$q$, 'ok');
select pg_temp.try('C2 依頼の記録は書き換えられない',
  $q$update public.gw_hr_attorney_requests set note = '書き換え' where id = 'f1390001-0000-0000-0000-000000000000'$q$, 'gw_hr_attorney_requests は書き換えられません');
select pg_temp.try('C3 依頼の種類は決まった値だけ',
  $q$insert into public.gw_hr_attorney_requests(tenant_id, applicant_id, offer_id, kind, requested_by)
     values ('13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000', 'slack', 'a1390001-0000-0000-0000-000000000000')$q$, 'gw_hr_attorney_requests_kind_chk');
select pg_temp.try('C4 メモは1000字まで',
  $q$insert into public.gw_hr_attorney_requests(tenant_id, applicant_id, offer_id, note, requested_by)
     values ('13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000', repeat('あ', 1001), 'a1390001-0000-0000-0000-000000000000')$q$, 'gw_hr_attorney_requests_note_chk');

-- ---- 正式PDFで案内する版 -------------------------------------------------------
select pg_temp.try('D1 正式PDFを固定しないと送付済みにできない',
  $q$update public.gw_hr_offers set sent_at = now() where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_official_sent_chk');
select pg_temp.try('D2 固定する正式PDFは、本人に見せる通知書にも入れる',
  $q$update public.gw_hr_offers set official_doc_id = 'd1390002-0000-0000-0000-000000000000' where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_official_notice_chk');
select pg_temp.try('D3 LegalSign に登録した版を先に記録する（URL と版）',
  $q$update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/doc/1', contract_route = 'legalsign',
       legalsign_doc_id = 'd1390002-0000-0000-0000-000000000000', legalsign_doc_sha256 = repeat('a', 64)
     where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('D4 LegalSign に登録した版と違う版では案内できない',
  $q$update public.gw_hr_offers set sent_at = now(), official_doc_id = 'd1390003-0000-0000-0000-000000000000',
       notice_title = '労働条件通知書', notice_pdf_path = 't/offers/a/e1/official-r3.pdf', notice_pdf_sha256 = repeat('d', 64)
     where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_legalsign_doc_chk');
select pg_temp.try('D5 承認した正式PDF（版2）を固定して案内する',
  $q$update public.gw_hr_offers set sent_at = now(), official_doc_id = 'd1390002-0000-0000-0000-000000000000',
       notice_title = '労働条件通知書', notice_pdf_path = 't/offers/a/e1/official-r2.pdf', notice_pdf_sha256 = repeat('a', 64)
     where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('D6 案内した正式PDFは差し替えにできない',
  $q$update public.gw_hr_offer_official_docs set status = 'superseded' where id = 'd1390002-0000-0000-0000-000000000000'$q$, '本人へ案内した正式PDFは差し替えにできません');
select pg_temp.try('D7 案内した正式PDFは変えられない（service_role でも）',
  $q$set local role service_role; update public.gw_hr_offers set official_doc_id = 'd1390003-0000-0000-0000-000000000000' where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'official_doc_id は確定後に変更できません');
reset role;
select pg_temp.try('D8 流れ（正式PDF）は変えられない',
  $q$update public.gw_hr_offers set doc_route = 'generated' where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'doc_route は確定後に変更できません');
select pg_temp.try('D9 本人に見せる通知書は db/132 のとおり変えられない',
  $q$update public.gw_hr_offers set notice_pdf_path = 'x.pdf' where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'notice_pdf_path は確定後に変更できません');

-- 締結（本人のHRでの同意の前）
select pg_temp.try('E1 締結は証跡が要る',
  $q$update public.gw_hr_offers set formal_signed_at = now(), formal_signed_by = 'a1390001-0000-0000-0000-000000000000' where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_formal_evidence_chk');
select pg_temp.try('E2 締結した版が案内した版と違えば入らない',
  $q$update public.gw_hr_offers set formal_signed_at = now(), formal_signed_by = 'a1390001-0000-0000-0000-000000000000',
       formal_evidence = 'LegalSign の締結完了の通知を確認', formal_doc_sha256 = repeat('d', 64)
     where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_formal_doc_chk');
select pg_temp.try('E3 正式PDFの版は、本人のHRでの同意の前でも締結を記録できる',
  $q$update public.gw_hr_offers set formal_signed_at = now(), formal_signed_by = 'a1390001-0000-0000-0000-000000000000',
       formal_evidence = 'LegalSign の締結完了の通知と締結済みPDFを確認', formal_contract_ref = 'LS-0001', formal_doc_sha256 = repeat('a', 64)
     where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('E4 これまでの版（流れが空）は、従来どおり同意のあとでなければ締結にできない',
  $q$update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/doc/2', formal_signed_at = now(), formal_signed_by = 'a1390001-0000-0000-0000-000000000000'
     where id = 'b1390002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_formal_order_chk');
select pg_temp.try('E5 締結の証跡は書き換えられない',
  $q$update public.gw_hr_offers set formal_evidence = '書き換え' where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'formal_evidence は正式契約済みのあとに変更できません');
select pg_temp.try('E6 締結したあとは契約ルートも変えられない',
  $q$update public.gw_hr_offers set contract_route = 'other' where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'contract_route は正式契約済みのあとに変更できません');
select pg_temp.try('E7 締結したが同意が無い版は Office へ引き渡せない（db/133 のまま）',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1390001-0000-0000-0000-000000000000' where id = 'e1390001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');

-- 例外ルート（紙・対面）：LegalSign の URL なしで締結を記録できる
insert into public.gw_hr_offer_official_docs(id, tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, received_on, uploaded_by,
                                             status, reviewed_by, reviewed_at) values
  ('d1390004-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390002-0000-0000-0000-000000000000',
   1, 'contractor_contract', '業務委託契約書', 't/offers/a/e2/official-r1.pdf', repeat('e', 64), 3456, current_date, 'a1390001-0000-0000-0000-000000000000',
   'approved', 'a1390004-0000-0000-0000-000000000000', now());
update public.gw_hr_offers set contract_route = 'other', sent_at = now(), official_doc_id = 'd1390004-0000-0000-0000-000000000000',
       notice_title = '業務委託契約書', notice_pdf_path = 't/offers/a/e2/official-r1.pdf', notice_pdf_sha256 = repeat('e', 64)
 where id = 'e1390002-0000-0000-0000-000000000000';
select pg_temp.try('E8 例外ルートは LegalSign の URL なしで締結を記録できる',
  $q$update public.gw_hr_offers set formal_signed_at = now(), formal_signed_by = 'a1390001-0000-0000-0000-000000000000',
       formal_evidence = '紙の契約書（双方押印）を確認・原本は総務で保管', formal_doc_sha256 = repeat('e', 64)
     where id = 'e1390002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('E9 本人が同意したら引き渡せる（締結済み・同意済み）',
  $q$update public.gw_hr_offers set accepted_at = now() where id = 'e1390002-0000-0000-0000-000000000000';
     update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1390001-0000-0000-0000-000000000000' where id = 'e1390002-0000-0000-0000-000000000000'$q$, 'ok');

-- ---- 見える範囲 ---------------------------------------------------------------
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type, doc_route) values
  ('e1390009-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000002', 'c1390002-0000-0000-0000-000000000000', 1, 'h9',
   now() + interval '3 days', 'part_time', 'official');
insert into public.gw_hr_attorney_requests(tenant_id, applicant_id, offer_id, requested_by) values
  ('13913913-0000-0000-0000-000000000002', 'c1390002-0000-0000-0000-000000000000', 'e1390009-0000-0000-0000-000000000000', 'a1390003-0000-0000-0000-000000000000');
select pg_temp.expect('F1 採用HRの人（人事）は自社の受領記録を読める',
  pg_temp.count_as('a1390001-0000-0000-0000-000000000000', 'public.gw_hr_offer_official_docs'), 4);
select pg_temp.expect('F2 採用HRの人は自社の依頼の記録だけ読める（他社の1件は見えない）',
  pg_temp.count_as('a1390001-0000-0000-0000-000000000000', 'public.gw_hr_attorney_requests'), 1);
select pg_temp.expect('F3 一般メンバーは読めない',
  pg_temp.count_as('a1390002-0000-0000-0000-000000000000', 'public.gw_hr_offer_official_docs')
  + pg_temp.count_as('a1390002-0000-0000-0000-000000000000', 'public.gw_hr_attorney_requests'), 0);
select pg_temp.expect('F4 他社の人事は自社のぶんだけ（この会社の受領記録は0件）',
  pg_temp.count_as('a1390003-0000-0000-0000-000000000000', 'public.gw_hr_offer_official_docs'), 0);
select pg_temp.try_as('F5 採用HRの人でも、画面から直接は受領記録を書けない', 'a1390001-0000-0000-0000-000000000000',
  $q$insert into public.gw_hr_offer_official_docs(tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, received_on, uploaded_by)
     values ('13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000',
             9, 'labor_notice', '労働条件通知書', 'z.pdf', repeat('4', 64), 10, current_date, 'a1390001-0000-0000-0000-000000000000')$q$, 'permission denied');
select pg_temp.try_as('F6 承認も画面から直接はできない', 'a1390001-0000-0000-0000-000000000000',
  $q$update public.gw_hr_offer_official_docs set status = 'superseded' where id = 'd1390003-0000-0000-0000-000000000000'$q$, 'permission denied');
select pg_temp.try_as('F7 依頼の記録も画面から直接は足せない', 'a1390001-0000-0000-0000-000000000000',
  $q$insert into public.gw_hr_attorney_requests(tenant_id, applicant_id, offer_id, requested_by)
     values ('13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390001-0000-0000-0000-000000000000', 'a1390001-0000-0000-0000-000000000000')$q$, 'permission denied');
select pg_temp.expect('F8 確認 SQL に ❌ が無い（食い違う版も無い）', pg_temp.check_fails(:'cchk'), 0);

-- ---- 再発行：承認した正式PDFを新しい版へ引き継ぐ（api/hr/offers issueLink → carryOfficialDoc と同じ順） ----
-- 新しい版（流れは空・まだ送っていない）を足し、承認済みの写しを入れてから、正式PDF・LegalSign の登録を固定する
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type) values
  ('e1390003-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 3, 'h3',
   now() + interval '3 days', 'executive_employee');
select pg_temp.try('H1 承認した正式PDFの写し（承認済み・引き継ぎ元つき）を新しい版に入れられる',
  $q$insert into public.gw_hr_offer_official_docs(id, tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, received_on, uploaded_by,
                                                 status, reviewed_by, reviewed_at, checks, carried_from)
     values ('d1390005-0000-0000-0000-000000000000', '13913913-0000-0000-0000-000000000001', 'c1390001-0000-0000-0000-000000000000', 'e1390003-0000-0000-0000-000000000000',
             1, 'labor_notice', '労働条件通知書', 't/offers/a/e1/official-r2.pdf', repeat('a', 64), 23456, current_date, 'a1390001-0000-0000-0000-000000000000',
             'approved', 'a1390004-0000-0000-0000-000000000000', now(), '{"name":true}', 'd1390002-0000-0000-0000-000000000000')$q$, 'ok');
select pg_temp.try('H2 新しい版に正式PDF・LegalSign の登録（同じPDF）を固定できる',
  $q$update public.gw_hr_offers set doc_route = 'official', official_doc_id = 'd1390005-0000-0000-0000-000000000000',
       notice_title = '労働条件通知書', notice_pdf_path = 't/offers/a/e1/official-r2.pdf', notice_pdf_sha256 = repeat('a', 64),
       contract_route = 'legalsign', legalsign_url = 'https://sign.example.test/doc/1',
       legalsign_doc_id = 'd1390005-0000-0000-0000-000000000000', legalsign_doc_sha256 = repeat('a', 64)
     where id = 'e1390003-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('H3 新しい版を送付済みにできる', $q$update public.gw_hr_offers set sent_at = now() where id = 'e1390003-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('H4 新しい版に同意は無い（引き継がない）',
  (select count(*)::int from public.gw_hr_offers where id = 'e1390003-0000-0000-0000-000000000000' and accepted_at is null and formal_signed_at is null), 1);
select pg_temp.expect('H5 確認 SQL に ❌ が無い（写しの版も食い違わない）', pg_temp.check_fails(:'cchk'), 0);

-- ---- 戻す・もう一度流す --------------------------------------------------------
select pg_temp.try('G1 同意の前に締結を記録した版があると、戻す SQL は止まる', :'crb', '本人の同意の前に締結を記録した版があります');
select pg_temp.expect('G2 止まったときは何も変えていない（列・表が残る）',
  pg_temp.has_col('doc_route') + (to_regclass('public.gw_hr_offer_official_docs') is not null)::int, 2);
update public.gw_hr_offers set accepted_at = now() where id = 'e1390001-0000-0000-0000-000000000000';
select pg_temp.try('G3 本人が同意したあとなら戻せる', :'crb', 'ok');
select pg_temp.expect('G4 列・表・trigger が消える',
  pg_temp.has_col('doc_route') + pg_temp.has_col('official_doc_id') + pg_temp.has_col('formal_evidence')
  + (to_regclass('public.gw_hr_offer_official_docs') is not null)::int + (to_regclass('public.gw_hr_attorney_requests') is not null)::int
  + (select count(*)::int from pg_trigger where tgname in ('gw_hr_offers_lock_contract', 'gw_hr_offer_official_docs_guard', 'gw_hr_attorney_requests_guard')), 0);
select pg_temp.expect('G5 正式契約の順番は db/132 の形に戻る',
  (select count(*)::int from pg_constraint where conname = 'gw_hr_offers_formal_order_chk' and pg_get_constraintdef(oid) not like '%doc_route%'), 1);
select pg_temp.expect('G6 本人へ案内した正式PDFは notice_* に残る（承諾済みPDF・Office の閲覧はその版のまま）',
  (select count(*)::int from public.gw_hr_offers where id = 'e1390001-0000-0000-0000-000000000000' and notice_pdf_sha256 = repeat('a', 64)), 1);
select pg_temp.expect('G7 db/132・133 の確認 SQL は ❌ が無いまま', pg_temp.check_fails(:'cchk132') + pg_temp.check_fails(:'cchk133'), 0);
select pg_temp.try('G8 もう一度流せる', :'c139', 'ok');
select pg_temp.expect('G9 流し直したあとも確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
