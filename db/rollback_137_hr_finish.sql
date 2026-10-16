-- db/137 rollback
begin;

do $$
begin
  if exists(select 1 from public.gw_hr_applicants where status='position_closed') then
    raise exception 'position_closed の応募者があるため rollback できません。先に別の status へ変更してください';
  end if;
end $$;

alter table public.gw_hr_applicants drop constraint if exists gw_hr_applicants_status_check;
alter table public.gw_hr_applicants add constraint gw_hr_applicants_status_check
  check (status in (
    'todo','scheduling','interview_scheduled','eval_pending',
    'ceo_recommend_pending','ceo_interview_pending','ceo_decision_pending','next_scheduling_pending',
    'offer_draft_pending','offer_review_pending','offer_send_pending',
    'offer_sent','offer_viewed','offer_resend_pending','offer_response_pending',
    'accepted','declined','done','passed'
  ));

alter table public.gw_hr_offers drop constraint if exists gw_hr_offers_offer_pdf_sha_chk;
alter table public.gw_hr_offers
  drop column if exists offer_title,
  drop column if exists offer_pdf_path,
  drop column if exists offer_pdf_sha256;

-- db/132 のロック関数へ戻す（trigger は同じ関数名を呼ぶため作り直し不要）。
create or replace function public.gw_hr_offers_lock_documents()
returns trigger
language plpgsql
set search_path = public
as $
declare
  c text;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
begin
  foreach c in array array[
    'notice_title', 'notice_pdf_path', 'notice_pdf_sha256',
    'accept_name', 'accept_email', 'accept_ip', 'accept_ua', 'accept_text',
    'accepted_pdf_path', 'accepted_pdf_sha256', 'accepted_at',
    'formal_sent_at', 'formal_sent_by', 'formal_signed_at', 'formal_signed_by'
  ] loop
    if o ->> c is not null and (n ->> c) is distinct from (o ->> c) then
      raise exception 'gw_hr_offers.% は確定後に変更できません（db/132）', c
        using errcode = '55000', hint = '条件通知書・承諾記録・正式契約済みの記録は書き換えられません';
    end if;
  end loop;
  if old.formal_sent_at is not null and new.legalsign_url is distinct from old.legalsign_url then
    raise exception 'gw_hr_offers.legalsign_url は正式契約の案内後に変更できません（db/132）'
      using errcode = '55000', hint = '本人へ案内した URL は変えられません';
  end if;
  return new;
end $;

notify pgrst, 'reload schema';
commit;
