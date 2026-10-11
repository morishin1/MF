-- db/132_hr_offer_documents.sql のやり直し（条件通知書PDF・電子承諾記録・LegalSign 正式契約の列を外す）。
--
-- ■ 注意：列ごと消える（データも消える）
--   送った条件通知書PDFのパスとハッシュ、本人の承諾記録（氏名・メール・IP・利用環境・同意の文言）、
--   LegalSign の URL・正式契約済みの記録が、すべて消える。PDF の実体（Storage の hr バケット）は消さない。
--   本番で流す前に、残したい行を控えること：
--     select id, applicant_id, version, notice_title, notice_pdf_path, notice_pdf_sha256, accepted_at,
--            accept_name, accept_email, accept_ip, accept_ua, accept_text, accepted_pdf_path, accepted_pdf_sha256,
--            formal_sent_at, formal_signed_at, formal_signed_by
--       from public.gw_hr_offers
--      where notice_pdf_path is not null or accepted_pdf_path is not null or formal_signed_at is not null;
--
-- 戻したあとも、オファーの送信・本人の承諾（accepted_at）はこれまでどおり動く（アプリは列が無いことを見て止まらない）。
begin;

drop trigger if exists gw_hr_offers_lock_documents on public.gw_hr_offers;
drop function if exists public.gw_hr_offers_lock_documents();

alter table public.gw_hr_offers
  drop constraint if exists gw_hr_offers_notice_sha_chk,
  drop constraint if exists gw_hr_offers_accepted_sha_chk,
  drop constraint if exists gw_hr_offers_accepted_pdf_chk,
  drop constraint if exists gw_hr_offers_accept_record_chk,
  drop constraint if exists gw_hr_offers_legalsign_url_chk,
  drop constraint if exists gw_hr_offers_formal_order_chk;

alter table public.gw_hr_offers
  drop column if exists notice_title,
  drop column if exists notice_pdf_path,
  drop column if exists notice_pdf_sha256,
  drop column if exists accept_name,
  drop column if exists accept_email,
  drop column if exists accept_ip,
  drop column if exists accept_ua,
  drop column if exists accept_text,
  drop column if exists accepted_pdf_path,
  drop column if exists accepted_pdf_sha256,
  drop column if exists legalsign_url,
  drop column if exists formal_sent_at,
  drop column if exists formal_sent_by,
  drop column if exists formal_signed_at,
  drop column if exists formal_signed_by;

commit;

notify pgrst, 'reload schema';
