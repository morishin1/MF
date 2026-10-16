-- =============================================================================
-- 137: 採用HR 完成仕上げ
--   1) オファー通知PDF（内定通知書・採用通知書・業務委託オファー等）を条件通知書PDFと分離して保存
--   2) 応募者の終了理由に「募集終了」を追加
--
-- 前提: db/081, db/086, db/129, db/132
-- 実行: このファイル全体を Supabase SQL Editor で Run（べき等）
-- 確認: db/check_137_hr_finish.sql
-- =============================================================================
begin;

do $$
begin
  if to_regclass('public.gw_hr_offers') is null then
    raise exception 'gw_hr_offers がありません';
  end if;
  if to_regclass('public.gw_hr_applicants') is null then
    raise exception 'gw_hr_applicants がありません';
  end if;
end $$;

alter table public.gw_hr_offers
  add column if not exists offer_title      text,
  add column if not exists offer_pdf_path   text,
  add column if not exists offer_pdf_sha256 text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_offer_pdf_sha_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_offer_pdf_sha_chk
      check (offer_pdf_sha256 is null or offer_pdf_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- 送った書類は後から変えない。db/132 のロック対象にオファー通知PDFも加える。
create or replace function public.gw_hr_offers_lock_documents()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c text;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
begin
  foreach c in array array[
    'offer_title', 'offer_pdf_path', 'offer_pdf_sha256',
    'notice_title', 'notice_pdf_path', 'notice_pdf_sha256',
    'accept_name', 'accept_email', 'accept_ip', 'accept_ua', 'accept_text',
    'accepted_pdf_path', 'accepted_pdf_sha256', 'accepted_at',
    'formal_sent_at', 'formal_sent_by', 'formal_signed_at', 'formal_signed_by'
  ] loop
    if o ->> c is not null and (n ->> c) is distinct from (o ->> c) then
      raise exception 'gw_hr_offers.% は確定後に変更できません（db/137）', c
        using errcode = '55000', hint = '本人へ確定した通知書・承諾記録・正式契約済みの記録は書き換えられません';
    end if;
  end loop;
  if old.formal_sent_at is not null and new.legalsign_url is distinct from old.legalsign_url then
    raise exception 'gw_hr_offers.legalsign_url は正式契約の案内後に変更できません（db/132）'
      using errcode = '55000', hint = '本人へ案内した URL は変えられません';
  end if;
  return new;
end $$;

comment on column public.gw_hr_offers.offer_title is
  'オファー通知PDFの書類名（内定通知書・採用通知書・育成参加決定通知書等）。送付版を固定（db/137）';
comment on column public.gw_hr_offers.offer_pdf_path is
  'オファー通知PDFの private Storage パス。条件通知書とは別ファイル（db/137）';
comment on column public.gw_hr_offers.offer_pdf_sha256 is
  'オファー通知PDFの SHA-256（db/137）';

-- 「募集終了」を、辞退・見送りとは別の終了理由として持つ。
alter table public.gw_hr_applicants drop constraint if exists gw_hr_applicants_status_check;
alter table public.gw_hr_applicants add constraint gw_hr_applicants_status_check
  check (status in (
    'todo','scheduling','interview_scheduled','eval_pending',
    'ceo_recommend_pending','ceo_interview_pending','ceo_decision_pending','next_scheduling_pending',
    'offer_draft_pending','offer_review_pending','offer_send_pending',
    'offer_sent','offer_viewed','offer_resend_pending','offer_response_pending',
    'accepted','declined','done','passed','position_closed'
  ));

comment on column public.gw_hr_applicants.status is
  '対応ステータス。position_closed は募集そのものを終了したため選考終了にした状態（db/137）';

notify pgrst, 'reload schema';
commit;
