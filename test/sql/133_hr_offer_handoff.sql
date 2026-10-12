-- db/133_hr_offer_handoff.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（db/132 の列）が無い DB では、133 は何も変えずにエラーで止まる
--   ・確認 SQL は、流す前でもエラーにならず ❌ が並ぶ。流したあとは ❌ が無い
--   ・引き渡せるのは本人が承諾した版だけ（未承諾・辞退・無効化した版は不可）。日時と人はそろって入る
--   ・LegalSign を使う版（URL 登録・案内あり）は、正式契約済みになるまで引き渡せない。使わない版は承諾のまま引き渡せる
--   ・引き渡したあとに LegalSign を始められない。引き渡した版は無効化・辞退にできない
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

-- ---- 前提が無い DB では止まる -------------------------------------------------
select pg_temp.try('A1 db/129 を流す', :'c129', 'ok');
select pg_temp.try('A2 db/132 の前に流すと止まる', :'c133', 'db/132_hr_offer_documents.sql');
select pg_temp.expect('A3 止まったときは列を足していない', pg_temp.has_col('handoff_at') + pg_temp.has_col('handoff_by'), 0);
select pg_temp.expect('A4 流す前の確認 SQL はエラーにならず ❌ が並ぶ', (pg_temp.check_fails(:'cchk') >= 8)::int, 1);
select pg_temp.try('A5 db/132 を流す', :'c132', 'ok');
select pg_temp.expect('A6 db/132 だけのときも、確認 SQL はエラーにならず ❌ が並ぶ（8 の db/132 は ✅）',
  (pg_temp.check_fails(:'cchk') >= 7)::int, 1);
select pg_temp.try('A7 db/133 を流す', :'c133', 'ok');
select pg_temp.try('A8 もう一度流しても同じ（べき等）', :'c133', 'ok');
select pg_temp.expect('A9 確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
select pg_temp.expect('A10 db/132 の確認 SQL も ❌ が無い（db/132 の trigger・function は変えていない）', pg_temp.check_fails(:'cchk132'), 0);

-- ---- 試すための行（実在の応募者ではない） ---------------------------------------
insert into public.tenants(id, name) values ('13313313-0000-0000-0000-000000000001', 'テスト会社');
insert into auth.users(id, email) values
  ('a1330001-0000-0000-0000-000000000000', 'hr@example.test'),
  ('a1330002-0000-0000-0000-000000000000', 'hr2@example.test');
insert into public.gw_hr_applicants(id, tenant_id, name, email, job_title, source) values
  ('c1330001-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'テスト 候補者', 'candidate@example.test', 'テスト', 'テスト');
-- e1：正社員（LegalSign を使う）／e2：業務委託（LegalSign を使わない）／e3：未承諾／e4：辞退／e5：無効化
insert into public.gw_hr_offers(id, tenant_id, applicant_id, version, token_hash, expires_at, offer_type) values
  ('e1330001-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 1, 'h1', now() + interval '3 days', 'executive_employee'),
  ('e1330002-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 2, 'h2', now() + interval '3 days', 'contractor'),
  ('e1330003-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 3, 'h3', now() + interval '3 days', 'part_time'),
  ('e1330004-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 4, 'h4', now() + interval '3 days', 'spot'),
  ('e1330005-0000-0000-0000-000000000000', '13313313-0000-0000-0000-000000000001', 'c1330001-0000-0000-0000-000000000000', 5, 'h5', now() + interval '3 days', 'spot');
update public.gw_hr_offers set sent_at = now() - interval '2 days', accepted_at = now() - interval '1 day'
 where id in ('e1330001-0000-0000-0000-000000000000', 'e1330002-0000-0000-0000-000000000000', 'e1330005-0000-0000-0000-000000000000');
update public.gw_hr_offers set sent_at = now() - interval '2 days', declined_at = now() - interval '1 day' where id = 'e1330004-0000-0000-0000-000000000000';
update public.gw_hr_offers set revoked_at = now() where id = 'e1330005-0000-0000-0000-000000000000';

-- ---- 引き渡せる版 -------------------------------------------------------------
select pg_temp.try('B1 本人が承諾していない版は引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330003-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');
select pg_temp.try('B2 辞退した版は引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330004-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');
select pg_temp.try('B3 無効化した版は引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330005-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');
select pg_temp.try('B4 日時だけ（人が無い）は入れられない',
  $q$update public.gw_hr_offers set handoff_at = now() where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_pair_chk');
select pg_temp.try('B5 人だけ（日時が無い）は入れられない',
  $q$update public.gw_hr_offers set handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_pair_chk');

-- ---- LegalSign を使う版：正式契約済みのあとだけ -------------------------------------
update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/doc/1' where id = 'e1330001-0000-0000-0000-000000000000';
select pg_temp.try('C1 LegalSign の URL を登録した版は、正式契約済みになるまで引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_formal_chk');
update public.gw_hr_offers set formal_sent_at = now(), formal_sent_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000';
select pg_temp.try('C2 正式契約を案内しただけ（正式契約待ち）でも引き渡せない',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_formal_chk');
update public.gw_hr_offers set formal_signed_at = now(), formal_signed_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000';
select pg_temp.try('C3 正式契約済みになったら引き渡せる',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'ok');

-- ---- LegalSign を使わない版：条件承諾のまま、HR の確認で引き渡せる --------------------
select pg_temp.try('D1 LegalSign を使わない版（URL も案内も無い）は、承諾のまま引き渡せる',
  $q$update public.gw_hr_offers set handoff_at = now(), handoff_by = 'a1330002-0000-0000-0000-000000000000' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('D2 引き渡したあとに LegalSign を始められない（URL を入れられない）',
  $q$update public.gw_hr_offers set legalsign_url = 'https://sign.example.test/doc/2' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_formal_chk');
select pg_temp.try('D3 引き渡した版は無効化できない',
  $q$update public.gw_hr_offers set revoked_at = now() where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');
select pg_temp.try('D4 引き渡した版は辞退にできない',
  $q$update public.gw_hr_offers set declined_at = now() where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_accepted_chk');

-- ---- 書き換えさせない ---------------------------------------------------------
select pg_temp.try('E1 引き渡した日時は書き換えられない',
  $q$update public.gw_hr_offers set handoff_at = now() + interval '1 day' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'handoff_at は確定後に変更できません');
select pg_temp.try('E2 引き渡した人は書き換えられない',
  $q$update public.gw_hr_offers set handoff_by = 'a1330001-0000-0000-0000-000000000000' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'handoff_by は確定後に変更できません');
select pg_temp.try('E3 引き渡しは取り消せない（null に戻せない）',
  $q$update public.gw_hr_offers set handoff_at = null, handoff_by = null where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'は確定後に変更できません');
select pg_temp.try('E4 service_role でも書き換えられない',
  $q$set local role service_role; update public.gw_hr_offers set handoff_at = null, handoff_by = null where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'は確定後に変更できません');
reset role;
select pg_temp.try('E5 同じ値をもう一度入れるのは構わない（API の書き直しで止めない）',
  $q$update public.gw_hr_offers set handoff_by = 'a1330002-0000-0000-0000-000000000000' where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('E6 ほかの列（viewed_at）はこれまでどおり直せる',
  $q$update public.gw_hr_offers set viewed_at = now() where id = 'e1330002-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.try('E7 db/132 の書き換え防止もそのまま効く（正式契約済みは取り消せない）',
  $q$update public.gw_hr_offers set formal_signed_at = null, formal_signed_by = null where id = 'e1330001-0000-0000-0000-000000000000'$q$, 'formal_signed_at は確定後に変更できません');
select pg_temp.try('E8 引き渡した人（auth.users）は、記録があるかぎり削除できない',
  $q$delete from auth.users where id = 'a1330002-0000-0000-0000-000000000000'$q$, 'gw_hr_offers_handoff_by_fkey');
select pg_temp.expect('E9 何度試しても、引き渡しの記録は最初の値のまま',
  (select count(*)::int from public.gw_hr_offers
    where (id = 'e1330001-0000-0000-0000-000000000000' and handoff_by = 'a1330001-0000-0000-0000-000000000000' and formal_signed_at is not null)
       or (id = 'e1330002-0000-0000-0000-000000000000' and handoff_by = 'a1330002-0000-0000-0000-000000000000'
           and legalsign_url is null and revoked_at is null and declined_at is null)), 2);
select pg_temp.expect('E10 確認 SQL に ❌ が無い（条件に合わない行 0件）', pg_temp.check_fails(:'cchk'), 0);
select pg_temp.expect('E11 確認 SQL の件数：引き渡し済み 2件（正式契約済みのあと 1件・LegalSign を使わずに 1件）',
  (select count(*)::int from (:cchk) x where x."#" = 9 and x."詳細" like '引き渡し済み 2件（正式契約済みのあと 1件 / LegalSign を使わずに 1件）%'), 1);

-- ---- 戻す・もう一度流す --------------------------------------------------------
select pg_temp.try('F1 戻す SQL を流す', :'crb', 'ok');
select pg_temp.expect('F2 列が消える', pg_temp.has_col('handoff_at') + pg_temp.has_col('handoff_by'), 0);
select pg_temp.expect('F3 db/133 の trigger・function が消える',
  (select count(*)::int from pg_trigger where tgname = 'gw_hr_offers_lock_handoff')
  + (select count(*)::int from pg_proc where proname = 'gw_hr_offers_lock_handoff'), 0);
select pg_temp.expect('F4 db/132 の列・trigger は残る',
  pg_temp.has_col('formal_signed_at') + (select count(*)::int from pg_trigger where tgname = 'gw_hr_offers_lock_documents'), 2);
select pg_temp.expect('F5 戻した状態では確認 SQL に ❌ が出る', (pg_temp.check_fails(:'cchk') > 0)::int, 1);
select pg_temp.expect('F6 db/132 の確認 SQL は ❌ が無いまま', pg_temp.check_fails(:'cchk132'), 0);
select pg_temp.expect('F7 行は残る（承諾・正式契約済みの記録も）',
  (select count(*)::int from public.gw_hr_offers where accepted_at is not null and tenant_id = '13313313-0000-0000-0000-000000000001'), 3);
select pg_temp.try('F8 もう一度流す（既存の行は条件を満たしている）', :'c133', 'ok');
select pg_temp.expect('F9 もう一度流したあとも確認 SQL に ❌ が無い', pg_temp.check_fails(:'cchk'), 0);
