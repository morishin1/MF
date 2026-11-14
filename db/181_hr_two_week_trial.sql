-- Add an explicit two-week trial option without rewriting existing applicants.
begin;
alter table public.gw_hr_applicants drop constraint gw_hr_applicants_offer_type_chk;
alter table public.gw_hr_applicants add constraint gw_hr_applicants_offer_type_chk
 check (offer_type is null or offer_type in ('executive_employee','trial_2weeks','training','contractor','part_time','spot'));
alter table public.gw_hr_offers drop constraint gw_hr_offers_offer_type_chk;
alter table public.gw_hr_offers add constraint gw_hr_offers_offer_type_chk
 check (offer_type is null or offer_type in ('executive_employee','trial_2weeks','training','contractor','part_time','spot'));
create or replace function public.hr_pdf_eligible(a jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(a->>'lead_category'='recruitment' and a->>'offer_type' in ('executive_employee','part_time','trial_2weeks') and (a->>'offer_type'<>'trial_2weeks' or (a->>'join_date' is not null and a->>'employment_type' in ('正社員','契約社員','パート','アルバイト'))) and coalesce(a->>'employment_type','') !~* '業務委託|委託|副業|フリーランス|スポット|freelance|contractor' and a->>'stage'='offer' and a->>'decision'='hired' and a->>'employee_id' is null and a->>'advance_claimed_at' is null and coalesce(a->>'status','') not in ('accepted','done','declined','passed','position_closed'),false)
$$;
commit;
