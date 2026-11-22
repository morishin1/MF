-- Preserve earlier Office activity while recording new Sales activity under its own role.
alter table public.gw_enger_daily_reviews
  add column sales_confirmed_by uuid,
  add column sales_confirmed_at timestamptz,
  add constraint gw_enger_daily_sales_confirmation_pair
    check ((sales_confirmed_by is null) = (sales_confirmed_at is null)),
  add constraint gw_enger_daily_distinct_sales_and_enger
    check (sales_confirmed_by is null or enger_confirmed_by is null or sales_confirmed_by <> enger_confirmed_by);

alter table public.gw_enger_office_checks
  add column checked_side text not null default 'office' check (checked_side in ('office', 'sales'));

create or replace view public.gw_enger_office_review_queue with (security_invoker = true) as
select s.tenant_id, s.id, p.id as source_id, s.title, s.company_name, s.sent_at, s.status,
       c.outcome, c.reason, c.fact, c.checked_on, c.revision,
       s.job_title, s.talent_initials, p.job_action_type, p.cand_action_type, c.checked_side
from public.gw_sales_proposals s
join enger.proposals p on p.id::text = s.source_proposal_id and p.deleted_at is null
left join public.gw_enger_office_checks c on c.tenant_id = s.tenant_id and c.proposal_id = s.id
where s.source_system = 'enger' and s.archived_at is null and s.sent_at is not null;
revoke all on public.gw_enger_office_review_queue from public, anon, authenticated;
grant select on public.gw_enger_office_review_queue to service_role;
