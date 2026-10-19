-- =============================================================================
-- db/139_hr_contract_procedure.sql のやり直し（契約手続き：社労士への依頼・正式PDFの受領記録・版の照合の列を外す）
--
-- ■ 先にやること
--   1. アプリを db/139 より前の版へ戻す（契約手続きのカード・/api/hr/offers/contract が無い版）。
--      アプリが新しいまま戻すと、契約手続きのカードが「db/139 を流してください」になる（ほかの採用HRはこれまでどおり）
--   2. 本人がHRで同意する前に、LegalSign の締結を記録した版が無いか確かめる。あると、下の「正式契約の順番」を
--      db/132 の形（締結は同意した版だけ）へ戻せず、この SQL は何も変えずに止まる：
--        select id, applicant_id, version from public.gw_hr_offers where formal_signed_at is not null and accepted_at is null;
--      → 本人の同意を待ってから流す
--
-- ■ 消えるもの（データも消える。流す前に控えること）
--   社労士への依頼の記録・正式PDFの受領記録（版・承認・差し戻し）・LegalSign に登録した版・締結の証跡。
--     select * from public.gw_hr_attorney_requests;
--     select * from public.gw_hr_offer_official_docs;
--     select id, applicant_id, version, doc_route, contract_route, official_doc_id, legalsign_doc_sha256,
--            formal_evidence, formal_contract_ref, formal_doc_sha256
--       from public.gw_hr_offers where doc_route is not null or official_doc_id is not null;
--
-- ■ 残るもの
--   本人へ案内した正式PDFは notice_pdf_path・notice_pdf_sha256（db/132）に入ったまま残る
--   （本人の画面・承諾済みPDF・Office の閲覧は、戻したあともその版を使う）。Storage のPDFも消さない。
--   db/132・133・137 の列・trigger・function には触らない（正式契約の順番の制約だけ db/132 の形へ戻す）。
-- =============================================================================
begin;

do $$
begin
  if to_regclass('public.gw_hr_offers') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'formal_signed_at')
     and exists (select 1 from public.gw_hr_offers where formal_signed_at is not null and accepted_at is null) then
    raise exception 'rollback_139: 本人の同意の前に締結を記録した版があります。正式契約の順番を db/132 の形へ戻せないため、何も変えずに止めます'
      using hint = 'select id, applicant_id, version from public.gw_hr_offers where formal_signed_at is not null and accepted_at is null;';
  end if;
end $$;

drop trigger if exists gw_hr_offers_lock_contract on public.gw_hr_offers;
drop function if exists public.gw_hr_offers_lock_contract();

alter table public.gw_hr_offers
  drop constraint if exists gw_hr_offers_doc_route_chk,
  drop constraint if exists gw_hr_offers_contract_route_chk,
  drop constraint if exists gw_hr_offers_contract_text_chk,
  drop constraint if exists gw_hr_offers_official_sent_chk,
  drop constraint if exists gw_hr_offers_official_notice_chk,
  drop constraint if exists gw_hr_offers_legalsign_doc_chk,
  drop constraint if exists gw_hr_offers_formal_doc_chk,
  drop constraint if exists gw_hr_offers_formal_evidence_chk,
  drop constraint if exists gw_hr_offers_handoff_official_chk;

-- 正式契約の順番を db/132 の形へ戻す
alter table public.gw_hr_offers drop constraint if exists gw_hr_offers_formal_order_chk;
alter table public.gw_hr_offers add constraint gw_hr_offers_formal_order_chk
  check ((formal_sent_at is null or legalsign_url is not null)
         and (formal_signed_at is null or accepted_at is not null));

alter table public.gw_hr_offers
  drop column if exists doc_route,
  drop column if exists contract_route,
  drop column if exists official_doc_id,
  drop column if exists legalsign_doc_id,
  drop column if exists legalsign_doc_sha256,
  drop column if exists formal_evidence,
  drop column if exists formal_contract_ref,
  drop column if exists formal_doc_sha256;

drop table if exists public.gw_hr_offer_official_docs;
drop table if exists public.gw_hr_attorney_requests;
drop function if exists public.gw_hr_offer_official_docs_guard();
drop function if exists public.gw_hr_attorney_requests_guard();

commit;

notify pgrst, 'reload schema';
