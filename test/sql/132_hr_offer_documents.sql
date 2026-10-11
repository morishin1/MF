-- db/132_hr_offer_documents.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（db/129 の offer_type）が無い DB では、132 は何も変えずにエラーで止まる
--   ・確認 SQL は、流す前でもエラーにならず ❌ が並ぶ。流したあとは ❌ が無い
--   ・SHA-256 の形・LegalSign URL（https:// だけ。javascript: data: http: 空白入りは入れられない）・順番の制約
--   ・一度入った条件通知書・承諾記録・正式契約済みの記録は、変更も削除（null）もできない（service role でも）
--   ・LegalSign URL は、正式契約を案内する前だけ直せる
--   ・ほかの列（sent_at・viewed_at・revoked_at など）は、これまでどおり直せる
--   ・戻す SQL で列・trigger が消え、もう一度流しても同じ（べき等）
--
\set ON_ERROR_STOP 0
\set c129 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/129_hr_offer_type.sql"`
\set c132 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/132_hr_offer_documents.sql"`
\set crb `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_132_hr_offer_documents.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_132_hr_offer_documents.sql"`

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

-- ---- 前提が無い DB では止まる -------------------------------------------------
select pg_temp.try('A1 db/129 の前に流すと止まる', :'c132', 'db/129_hr_offer_type.sql');
select pg_temp.expect('A2 止まったときは列を足していない', pg_temp.has_col('notice_pdf_path'), 0);
select pg_temp.expect('A3 流す前の確認 SQL はエラーにならず ❌ が並ぶ', (pg_temp.check_fails(:'cchk') >= 9)::int, 1);

select pg_temp.try('A4 db/129 を流す', :'c129', 'ok');
select pg_temp.try('A5 db/132 を流す', :'c132', 'ok');
select pg_temp.try('A6 もう一度流しても同じ（べき等）', :'c132', 'ok');
select pg_temp.expect('A7 確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);

-- ---- 試すための行（実在の応募者ではない） ---------------------------------------
insert into public.tenants(id, name) values ('13213213-0000-0000-0000-000000000001', 'テスト会社');
insert into auth.users(id, email) values ('a1320001-0000-0000-0000-000000000000', 'hr@example.test');
insert into public.gw_hr_applicants(id, tenant_id, name, email, job_title, source) values
  ('c1320001-0000-0000-0000-000000000000', '13213213-0000-0000-0000-000000000001', 'テスト 候補者', 'candidate@example.test', 'テスト', 'テスト');
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type) values
  ('d1320001-0000-0000-0000-000000000000', '13213213-0000-0000-0000-000000000001', 'c1320001-0000-0000-0000-000000000000', 1, 'h1', now() + interval '3 days', 'training'),
  ('d1320002-0000-0000-0000-000000000000', '13213213-0000-0000-0000-000000000001', 'c1320001-0000-0000-0000-000000000000', 2, 'h2', now() + interval '3 days', 'training'),
  ('d1320003-0000-0000-0000-000000000000', '13213213-0000-0000-0000-000000000001', 'c1320001-0000-0000-0000-000000000000', 3, 'h3', now() + interval '3 days', 'contractor');

-- ---- 条件通知書PDF ------------------------------------------------------------
select pg_temp.try('B1 SHA-256 の形が違うと入れられない',
  $q$update public.gw_hr_offers set notice_pdf_sha256 = 'ABC' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_notice_sha_chk');
select pg_temp.try('B2 条件通知書を入れる（1回目）',
  $q$update public.gw_hr_offers set notice_title = '育成参加条件通知書', notice_pdf_path = 'offers/t/a/d1/notice-v1.pdf',
     notice_pdf_sha256 = repeat('a', 64), sent_at = now() where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('B3 条件通知書のハッシュは書き換えられない',
  $q$update public.gw_hr_offers set notice_pdf_sha256 = repeat('b', 64) where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'notice_pdf_sha256 は確定後に変更できません');
select pg_temp.try('B4 条件通知書のパスは消せない（null に戻せない）',
  $q$update public.gw_hr_offers set notice_pdf_path = null where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'notice_pdf_path は確定後に変更できません');
select pg_temp.try('B5 書類名も書き換えられない',
  $q$update public.gw_hr_offers set notice_title = '別の書類' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'notice_title は確定後に変更できません');
select pg_temp.try('B6 同じ値をもう一度入れるのは構わない（API の書き直しで止めない）',
  $q$update public.gw_hr_offers set notice_pdf_sha256 = repeat('a', 64) where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('B7 ほかの列（viewed_at・sent_at）はこれまでどおり直せる',
  $q$update public.gw_hr_offers set viewed_at = now(), sent_at = now() where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'ok');

-- ---- 本人の電子承諾記録 --------------------------------------------------------
select pg_temp.try('C1 承諾していない版に承諾記録は入れられない',
  $q$update public.gw_hr_offers set accept_ip = '203.0.113.1' where id = 'd1320002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_accept_record_chk');
select pg_temp.try('C2 条件通知書の無い版に承諾済みPDFは入れられない',
  $q$update public.gw_hr_offers set accepted_at = now(), accepted_pdf_path = 'x.pdf', accepted_pdf_sha256 = repeat('c', 64)
     where id = 'd1320002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_accepted_pdf_chk');
select pg_temp.try('C3 承諾（承諾日時・氏名・メール・IP・利用環境・文言・承諾済みPDF）を1回で入れる',
  $q$update public.gw_hr_offers set accepted_at = now(), accept_name = 'テスト 候補者', accept_email = 'candidate@example.test',
     accept_ip = '203.0.113.1', accept_ua = 'Mozilla/5.0 (test)', accept_text = '上記の条件通知書の内容を確認し、この条件に同意します',
     accepted_pdf_path = 'offers/t/a/d1/accepted-v1.pdf', accepted_pdf_sha256 = repeat('d', 64)
     where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('C4 承諾日時は書き換えられない',
  $q$update public.gw_hr_offers set accepted_at = now() - interval '1 day' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'accepted_at は確定後に変更できません');
select pg_temp.try('C5 IP アドレスは書き換えられない',
  $q$update public.gw_hr_offers set accept_ip = '198.51.100.9' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'accept_ip は確定後に変更できません');
select pg_temp.try('C6 同意の文言は消せない',
  $q$update public.gw_hr_offers set accept_text = null where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'accept_text は確定後に変更できません');
select pg_temp.try('C7 承諾済みPDFのハッシュは書き換えられない',
  $q$update public.gw_hr_offers set accepted_pdf_sha256 = repeat('e', 64) where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'accepted_pdf_sha256 は確定後に変更できません');
select pg_temp.try('C8 氏名・メール・利用環境も書き換えられない',
  $q$update public.gw_hr_offers set accept_name = '別人', accept_email = 'x@example.test', accept_ua = 'x' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'は確定後に変更できません');

-- ---- LegalSign の URL ---------------------------------------------------------
select pg_temp.try('D1 javascript: は入れられない',
  $q$update public.gw_hr_offers set legalsign_url = 'javascript:alert(1)' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_legalsign_url_chk');
select pg_temp.try('D2 data: は入れられない',
  $q$update public.gw_hr_offers set legalsign_url = 'data:text/html,<script>' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_legalsign_url_chk');
select pg_temp.try('D3 http: は入れられない',
  $q$update public.gw_hr_offers set legalsign_url = 'http://sign.example.test/x' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_legalsign_url_chk');
select pg_temp.try('D4 空白・改行を含む URL は入れられない',
  $q$update public.gw_hr_offers set legalsign_url = E'https://sign.example.test/a\nb' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_legalsign_url_chk');
select pg_temp.try('D5 URL の無い版では、正式契約を案内できない',
  $q$update public.gw_hr_offers set formal_sent_at = now() where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_formal_order_chk');
select pg_temp.try('D6 https:// の URL を登録する',
  $q$update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/doc/1' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('D7 案内する前なら URL を直せる',
  $q$update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/doc/2' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('D8 本人へ正式契約を案内する',
  $q$update public.gw_hr_offers set formal_sent_at = now(), formal_sent_by = 'a1320001-0000-0000-0000-000000000000' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('D9 案内したあとは URL を直せない',
  $q$update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/doc/3' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'legalsign_url は正式契約の案内後に変更できません');
select pg_temp.try('D10 案内したあとは URL を消せない',
  $q$update public.gw_hr_offers set legalsign_url = null where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'legalsign_url は正式契約の案内後に変更できません');
select pg_temp.try('D11 案内した日時は書き換えられない',
  $q$update public.gw_hr_offers set formal_sent_at = now() + interval '1 hour' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'formal_sent_at は確定後に変更できません');

-- ---- 正式契約済み -------------------------------------------------------------
select pg_temp.try('E1 承諾していない版は正式契約済みにできない',
  $q$update public.gw_hr_offers set formal_signed_at = now() where id = 'd1320003-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_formal_order_chk');
select pg_temp.try('E2 正式契約済みにする（誰が・いつ）',
  $q$update public.gw_hr_offers set formal_signed_at = now(), formal_signed_by = 'a1320001-0000-0000-0000-000000000000' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('E3 正式契約済みの日時は書き換えられない',
  $q$update public.gw_hr_offers set formal_signed_at = now() + interval '1 day' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'formal_signed_at は確定後に変更できません');
select pg_temp.try('E4 正式契約済みは取り消せない（null に戻せない）',
  $q$update public.gw_hr_offers set formal_signed_at = null, formal_signed_by = null where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'は確定後に変更できません');
select pg_temp.try('E5 誰が正式契約済みにしたかは書き換えられない',
  $q$update public.gw_hr_offers set formal_signed_by = null where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'formal_signed_by は確定後に変更できません');
select pg_temp.try('E6 service_role でも書き換えられない',
  $q$set local role service_role; update public.gw_hr_offers set accept_ip = '192.0.2.1' where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'accept_ip は確定後に変更できません');
reset role;
select pg_temp.expect('E7 何度試しても、記録は最初の値のまま',
  (select count(*)::int from public.gw_hr_offers where id = 'd1320001-0000-0000-0000-000000000000'
     and notice_pdf_sha256 = repeat('a', 64) and accept_ip = '203.0.113.1' and accepted_pdf_sha256 = repeat('d', 64)
     and legalsign_url = 'https://sign.example.test/doc/2' and formal_signed_at is not null), 1);
select pg_temp.try('E8 記録が入った版でも、無効化（revoked_at）はこれまでどおりできる',
  $q$update public.gw_hr_offers set revoked_at = now() where id = 'd1320001-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('E9 確認 SQL に ❌ が無い（形・順番のおかしい行 0件）', pg_temp.check_fails(:'cchk'), 0);

-- ---- 戻す・もう一度流す --------------------------------------------------------
select pg_temp.try('F1 戻す SQL を流す', :'crb', 'ok');
select pg_temp.expect('F2 列が消える', pg_temp.has_col('notice_pdf_path') + pg_temp.has_col('legalsign_url') + pg_temp.has_col('formal_signed_at'), 0);
select pg_temp.expect('F3 trigger が消える', (select count(*)::int from pg_trigger where tgname = 'gw_hr_offers_lock_documents'), 0);
select pg_temp.expect('F4 戻した状態では確認 SQL に ❌ が出る', (pg_temp.check_fails(:'cchk') > 0)::int, 1);
select pg_temp.expect('F5 ほかの列（accepted_at）と行は残る', (select count(*)::int from public.gw_hr_offers where accepted_at is not null), 1);
select pg_temp.try('F6 もう一度流す', :'c132', 'ok');
select pg_temp.expect('F7 もう一度流したあとも確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
