-- db/133_hr_offer_handoff.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（db/132 の列）が無い DB では、133 は何も変えずにエラーで止まる
--   ・確認 SQL は、流す前でもエラーにならず ❌ が並ぶ。流したあとは ❌ が無い
--   ・正式契約の要否（formal_contract_required）
--       既存の行は区分の既定で埋まる（育成枠だけ false。区分の無い古い合格通知は空のまま）
--       アプリが渡さなければ区分の既定・渡せばその値（区分だけで固定しない）。区分のあるオファーは空にできない
--       本人へ送る前は変えられる。送ったあと（sent_at・条件通知書PDF・承諾）は変えられない（service role でも）
--   ・Office へ引き渡せる版
--       本人が承諾した版だけ（未承諾・辞退・無効化は不可）。日時と人はそろって入る
--       正式契約が必要な版は、正式契約済みになるまで引き渡せない（LegalSign の URL を入れる前でも）
--       正式契約が不要な版は、承諾のまま引き渡せる
--       育成枠・区分の無い合格通知は引き渡せない
--       引き渡した版は無効化・辞退にできない
--   ・一度入った引き渡しの記録は、変更も削除（null）もできない（service role でも）
--   ・db/132 の trigger・function は変えない（書き換え防止はそのまま効く）
--   ・引き渡した人（auth.users）は、記録があるかぎり削除できない
--   ・戻す SQL で列・trigger が消え（db/132 の列・trigger は残る）、もう一度流しても同じ（べき等）
--
\set ON_ERROR_STOP 0
\set c129 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/129_hr_offer_type.sql"`
\set c132 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/132_hr_offer_documents.sql"`
\set c133 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/133_hr_offer_handoff.sql"`
\set crb `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/rollback_133_hr_offer_handoff.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_133_hr_offer_handoff.sql"`
\set cchk132 `sed 's/;\s*$//' "$SCEN_ROOT/db/check_132_hr_offer_documents.sql"`

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
-- 列ができる前に作るので、中身は実行時に組み立てる（language sql だと作る時点で列を探して止まる）
create or replace function pg_temp.req(i uuid) returns int language plpgsql as $$
declare n int;
begin
  execute 'select case formal_contract_required when true then 1 when false then 0 else -1 end from public.gw_hr_offers where id = $1'
    into n using i;
  return n;
end $$;

-- ---- 前提が無い DB では止まる -------------------------------------------------
select pg_temp.try('A1 db/129 を流す', :'c129', 'ok');
select pg_temp.try('A2 db/132 の前に流すと止まる', :'c133', 'db/132_hr_offer_documents.sql');
select pg_temp.expect('A3 止まったときは列を足していない', pg_temp.has_col('handoff_at') + pg_temp.has_col('formal_contract_required'), 0);
select pg_temp.expect('A4 流す前の確認 SQL はエラーにならず ❌ が並ぶ', (pg_temp.check_fails(:'cchk') >= 10)::int, 1);
select pg_temp.try('A5 db/132 を流す', :'c132', 'ok');

-- 流す前からあるオファー（実在の応募者ではない）：送付済みの正社員・育成枠、下書きのパート、区分の無い古い合格通知
insert into public.tenants(id, name) values ('13313313-0000-0000-0000-000000000001', 'テスト会社');
insert into auth.users(id, email) values
  ('a1330001-0000-0000-0000-000000000000', 'hr@example.test'),
  ('a1330002-0000-0000-0000-000000000000', 'hr2@example.test');
insert into public.gw_hr_applicants(id, tenant_id, name, email, job_title, source) values
  ('c1330001-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'テスト 候補者', 'candidate@example.test', 'テスト', 'テスト');
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type, sent_at) values
  ('b1330001-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 101, 'p1', now() + interval '3 days', 'executive_employee', now()),
  ('b1330002-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 102, 'p2', now() + interval '3 days', 'training', now()),
  ('b1330003-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 103, 'p3', now() + interval '3 days', 'part_time', null),
  ('b1330004-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 104, 'p4', now() + interval '3 days', null, now());

select pg_temp.expect('A6 db/132 だけのときも、確認 SQL はエラーにならず ❌ が並ぶ', (pg_temp.check_fails(:'cchk') >= 10)::int, 1);
select pg_temp.try('A7 db/133 を流す', :'c133', 'ok');
select pg_temp.try('A8 もう一度流しても同じ（べき等）', :'c133', 'ok');
select pg_temp.expect('A9 確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
select pg_temp.expect('A10 db/132 の確認 SQL も ❌ が無い（db/132 の trigger・function は変えていない）', pg_temp.check_fails(:'cchk132'), 0);

-- ---- 正式契約の要否：既存の行の埋め方・既定・オファーごとの値 ----------------------
select pg_temp.expect('B1 既存の正社員（送付済み）は「必要」で埋まる', pg_temp.req('b1330001-0000-0000-0000-000000000000'), 1);
select pg_temp.expect('B2 既存の育成枠は「不要」で埋まる', pg_temp.req('b1330002-0000-0000-0000-000000000000'), 0);
select pg_temp.expect('B3 既存のパート（下書き）は「必要」で埋まる', pg_temp.req('b1330003-0000-0000-0000-000000000000'), 1);
select pg_temp.expect('B4 区分の無い古い合格通知は空のまま', pg_temp.req('b1330004-0000-0000-0000-000000000000'), -1);

-- e1：正社員（既定）／e2：業務委託（オファーで「不要」に確定）／e3：パート（未承諾）／e4：スポット（辞退）／e5：スポット（無効化）
-- e6：育成枠（既定）／e7：区分の無い合格通知／e8：育成枠（オファーで「必要」に確定）
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type, formal_contract_required) values
  ('e1330001-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 1, 'h1', now() + interval '3 days', 'executive_employee', null),
  ('e1330002-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 2, 'h2', now() + interval '3 days', 'contractor', false),
  ('e1330003-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 3, 'h3', now() + interval '3 days', 'part_time', null),
  ('e1330004-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 4, 'h4', now() + interval '3 days', 'spot', null),
  ('e1330005-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 5, 'h5', now() + interval '3 days', 'spot', null),
  ('e1330006-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 6, 'h6', now() + interval '3 days', 'training', null),
  ('e1330007-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 7, 'h7', now() + interval '3 days', null, null),
  ('e1330008-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 8, 'h8', now() + interval '3 days', 'training', true);
select pg_temp.expect('B5 渡さなければ区分の既定（正社員・パート・スポットは必要）',
  pg_temp.req('e1330001-0000-0000-0000-000000000000') + pg_temp.req('e1330003-0000-0000-0000-000000000000') + pg_temp.req('e1330004-0000-0000-0000-000000000000'), 3);
select pg_temp.expect('B6 育成枠の既定は不要', pg_temp.req('e1330006-0000-0000-0000-000000000000'), 0);
select pg_temp.expect('B7 オファーで決めた値はそのまま（業務委託を不要に・育成枠を必要に）',
  (pg_temp.req('e1330002-0000-0000-0000-000000000000') = 0 and pg_temp.req('e1330008-0000-0000-0000-000000000000') = 1)::int, 1);
select pg_temp.expect('B8 区分の無い合格通知は空のまま', pg_temp.req('e1330007-0000-0000-0000-000000000000'), -1);
select pg_temp.try('B9 区分のあるオファーの要否は空にできない',
  $q$update public.gw_hr_offers set formal_contract_required = null where id = 'e1330003-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_formal_required_chk');
select pg_temp.try('B10 送る前なら要否を変えられる（パートを不要に → 必要に戻す）',
  $q$update public.gw_hr_offers set formal_contract_required = false where id = 'e1330003-0000-0000-0000-000000000000';
     update public.gw_hr_offers set formal_contract_required = true where id = 'e1330003-0000-0000-0000-000000000000'$q$, 'ok');

-- ---- 送ったあとは要否を変えられない ----------------------------------------------
update public.gw_hr_offers set sent_at = now() - interval '2 days'
 where id in ('e1330001-0000-0000-0000-000000000000', 'e1330002-0000-0000-0000-000000000000', 'e1330003-0000-0000-0000-000000000000',
              'e1330004-0000-0000-0000-000000000000', 'e1330005-0000-0000-0000-000000000000', 'e1330006-0000-0000-0000-000000000000',
              'e1330007-0000-0000-0000-000000000000');
select pg_temp.try('C1 送ったあとは「必要」を「不要」にできない（正式契約を飛ばせない）',
  $q$update public.gw_hr_offers set formal_contract_required = false where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'formal_contract_required はオファー送付後に変更できません');
select pg_temp.try('C2 送ったあとは「不要」を「必要」にもできない',
  $q$update public.gw_hr_offers set formal_contract_required = true where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'formal_contract_required はオファー送付後に変更できません');
select pg_temp.try('C3 service_role でも変えられない',
  $q$set local role service_role; update public.gw_hr_offers set formal_contract_required = false where id = 'b1330001-0000-0000-0000-000000000000'$q$, 'formal_contract_required はオファー送付後に変更できません');
reset role;
select pg_temp.try('C4 送付済みの区分の無い合格通知に、あとから要否を入れることもできない',
  $q$update public.gw_hr_offers set formal_contract_required = false where id = 'b1330004-0000-0000-0000-000000000000'$q$, 'formal_contract_required はオファー送付後に変更できません');
update public.gw_hr_offers set sent_at = null where id = 'e1330006-0000-0000-0000-000000000000';
update public.gw_hr_offers set notice_title = '育成参加条件通知書', notice_pdf_path = 'offers/t/a/e6/notice-v6.pdf', notice_pdf_sha256 = repeat('a', 64)
 where id = 'e1330006-0000-0000-0000-000000000000';
select pg_temp.try('C5 条件通知書PDFを作った版も変えられない（送付をやり直している途中でも）',
  $q$update public.gw_hr_offers set formal_contract_required = true where id = 'e1330006-0000-0000-0000-000000000000'$q$, 'formal_contract_required はオファー送付後に変更できません');
update public.gw_hr_offers set sent_at = now() - interval '2 days' where id = 'e1330006-0000-0000-0000-000000000000';
update public.gw_hr_offers set accepted_at = now() - interval '1 day'
 where id in ('e1330001-0000-0000-0000-000000000000', 'e1330002-0000-0000-0000-000000000000', 'e1330005-0000-0000-0000-000000000000',
              'e1330006-0000-0000-0000-000000000000', 'e1330007-0000-0000-0000-000000000000');
update public.gw_hr_offers set declined_at = now() - interval '1 day' where id = 'e1330004-0000-0000-0000-000000000000';
update public.gw_hr_offers set revoked_at = now() where id = 'e1330005-0000-0000-0000-000000000000';

-- ---- 引き渡せる版 -------------------------------------------------------------
select pg_temp.try('D1 本人が承諾していない版は引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330003-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');
select pg_temp.try('D2 辞退した版は引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330004-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');
select pg_temp.try('D3 無効化した版は引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330005-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');
select pg_temp.try('D4 日時だけ（人が無い）は入れられない',
  $q$update public.gw_hr_offers set handoff_at = now() where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_pair_chk');
select pg_temp.try('D5 人だけ（日時が無い）は入れられない',
  $q$update public.gw_hr_offers set handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_pair_chk');
select pg_temp.try('D6 育成枠は引き渡せない（LMS・育成開始へ進む）',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330006-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_type_chk');
select pg_temp.try('D7 区分の無い合格通知は引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330007-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_');

-- ---- 正式契約が必要な版：LegalSign の URL を入れる前でも、正式契約済みまでは引き渡せない ----
select pg_temp.try('E1 正式契約が必要な版は、URL を登録する前でも引き渡せない（正式契約を飛ばせない）',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_formal_chk');
update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/doc/1' where id = 'e1330001-0000-0000-0000-000000000000';
update public.gw_hr_offers set formal_sent_at = now(), formal_sent_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000';
select pg_temp.try('E2 正式契約を案内しただけ（正式契約待ち）でも引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_formal_chk');
update public.gw_hr_offers set formal_signed_at = now(), formal_signed_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000';
select pg_temp.try('E3 正式契約済みになったら引き渡せる',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'ok');

-- ---- 正式契約が不要な版：条件承諾のまま、HR の確認で引き渡せる -----------------------
select pg_temp.try('F1 正式契約が不要な版（業務委託で「不要」に確定）は、承諾のまま引き渡せる',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330002-0000-0000-0000-000000000000' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('F2 引き渡した版は無効化できない',
  $q$update public.gw_hr_offers set revoked_at = now() where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');
select pg_temp.try('F3 引き渡した版は辞退にできない',
  $q$update public.gw_hr_offers set declined_at = now() where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');
select pg_temp.try('F4 引き渡したあとも、正式契約の要否は変えられない',
  $q$update public.gw_hr_offers set formal_contract_required = true where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'formal_contract_required はオファー送付後に変更できません');

-- ---- 書き換えさせない ---------------------------------------------------------
select pg_temp.try('G1 引き渡した日時は書き換えられない',
  $q$update public.gw_hr_offers set handoff_at = now() + interval '1 day' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'handoff_at は確定後に変更できません');
select pg_temp.try('G2 引き渡した人は書き換えられない',
  $q$update public.gw_hr_offers set handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'handoff_by は確定後に変更できません');
select pg_temp.try('G3 引き渡しは取り消せない（null に戻せない）',
  $q$update public.gw_hr_offers set handoff_at = null, handoff_by = null where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'は確定後に変更できません');
select pg_temp.try('G4 service_role でも書き換えられない',
  $q$set local role service_role; update public.gw_hr_offers set handoff_at = null, handoff_by = null where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'は確定後に変更できません');
reset role;
select pg_temp.try('G5 同じ値をもう一度入れるのは構わない（API の書き直しで止めない）',
  $q$update public.gw_hr_offers set handoff_by = 'a1330002-0000-0000-0000-000000000000', formal_contract_required = false where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('G6 ほかの列（viewed_at）はこれまでどおり直せる',
  $q$update public.gw_hr_offers set viewed_at = now() where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('G7 db/132 の書き換え防止もそのまま効く（正式契約済みは取り消せない）',
  $q$update public.gw_hr_offers set formal_signed_at = null, formal_signed_by = null where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'formal_signed_at は確定後に変更できません');
select pg_temp.try('G8 引き渡した人（auth.users）は、記録があるかぎり削除できない',
  $q$delete from auth.users where id = 'a1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_by_fkey');
select pg_temp.expect('G9 何度試しても、引き渡しの記録と要否は最初の値のまま',
  (select count(*)::int from public.gw_hr_offers
    where (id = 'e1330001-0000-0000-0000-000000000000' and handoff_by = 'a1330001-0000-0000-0000-000000000000' and formal_contract_required and formal_signed_at is not null)
       or (id = 'e1330002-0000-0000-0000-000000000000' and handoff_by = 'a1330002-0000-0000-0000-000000000000'
           and formal_contract_required = false and revoked_at is null and declined_at is null)), 2);
select pg_temp.expect('G10 確認 SQL に ❌ が無い（条件に合わない行 0件）', pg_temp.check_fails(:'cchk'), 0);
select pg_temp.expect('G11 確認 SQL の件数：引き渡し済み 正式契約済みのあと 1件・正式契約なし 1件',
  (select count(*)::int from (:cchk) x where x."#" = 12 and x."詳細" like '%引き渡し済み：正式契約済みのあと 1件・正式契約なし 1件%'), 1);

-- ---- 戻す・もう一度流す --------------------------------------------------------
select pg_temp.try('H1 戻す SQL を流す', :'crb', 'ok');
select pg_temp.expect('H2 列が消える', pg_temp.has_col('handoff_at') + pg_temp.has_col('handoff_by') + pg_temp.has_col('formal_contract_required'), 0);
select pg_temp.expect('H3 db/133 の trigger・function が消える',
  (select count(*)::int from pg_trigger where tgname in ('gw_hr_offers_lock_handoff', 'gw_hr_offers_formal_default'))
  + (select count(*)::int from pg_proc where proname in ('gw_hr_offers_lock_handoff', 'gw_hr_offers_formal_default')), 0);
select pg_temp.expect('H4 db/132 の列・trigger は残る',
  pg_temp.has_col('formal_signed_at') + (select count(*)::int from pg_trigger where tgname = 'gw_hr_offers_lock_documents'), 2);
select pg_temp.expect('H5 戻した状態では確認 SQL に ❌ が出る', (pg_temp.check_fails(:'cchk') > 0)::int, 1);
select pg_temp.expect('H6 db/132 の確認 SQL は ❌ が無いまま', pg_temp.check_fails(:'cchk132'), 0);
select pg_temp.expect('H7 行は残る（承諾・正式契約済みの記録も）',
  (select count(*)::int from public.gw_hr_offers where accepted_at is not null and tenant_id = '13313313-0000-0000-0000-000000000001'), 5);
select pg_temp.try('H8 もう一度流す（既存の行は条件を満たしている）', :'c133', 'ok');
select pg_temp.expect('H9 もう一度流したあとも確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
select pg_temp.expect('H10 もう一度流すと、要否は区分の既定で埋め直される（戻すと、オファーごとに決めた値は消える）',
  pg_temp.req('e1330002-0000-0000-0000-000000000000'), 1);
