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

notify pgrst, 'reload schema';
commit;
