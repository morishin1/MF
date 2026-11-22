-- ENGER / Office: proposal screening and one shared record per JST working date.
create table if not exists public.gw_enger_office_checks (
  tenant_id uuid not null references public.tenants(id),
  proposal_id uuid not null references public.gw_sales_proposals(id),
  outcome text not null check (outcome in ('checked','discuss')),
  reason text check (reason in ('response','fit','terms','timing','availability','handoff','other')),
  fact text not null default '' check (char_length(fact) <= 500),
  checked_by uuid not null,
  checked_on date not null,
  checked_at timestamptz not null default now(),
  revision integer not null default 1 check (revision > 0),
  primary key (tenant_id, proposal_id),
  check (outcome <> 'discuss' or (reason is not null and char_length(trim(fact)) > 0))
);

create table if not exists public.gw_enger_daily_reviews (
  tenant_id uuid not null references public.tenants(id),
  review_day date not null,
  note text not null check (char_length(trim(note)) between 1 and 1500),
  next_step text not null default '' check (char_length(next_step) <= 1000),
  agenda jsonb not null default '[]'::jsonb check (jsonb_typeof(agenda) = 'array'),
  office_confirmed_by uuid,
  office_confirmed_at timestamptz,
  enger_confirmed_by uuid,
  enger_confirmed_at timestamptz,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  revision integer not null default 1 check (revision > 0),
  primary key (tenant_id, review_day),
  check ((office_confirmed_at is null) = (office_confirmed_by is null)),
  check ((enger_confirmed_at is null) = (enger_confirmed_by is null)),
  check (office_confirmed_by is null or enger_confirmed_by is null or office_confirmed_by <> enger_confirmed_by)
);

alter table public.gw_enger_office_checks enable row level security;
alter table public.gw_enger_daily_reviews enable row level security;
revoke all on public.gw_enger_office_checks, public.gw_enger_daily_reviews from public, anon, authenticated;
grant select, insert, update on public.gw_enger_office_checks, public.gw_enger_daily_reviews to service_role;

create or replace view public.gw_enger_office_review_queue with (security_invoker = true) as
select s.tenant_id, s.id, p.id as source_id, s.title, s.company_name, s.sent_at, s.status,
       c.outcome, c.reason, c.fact, c.checked_on, c.revision,
       s.job_title, s.talent_initials, p.job_action_type, p.cand_action_type
from public.gw_sales_proposals s
join enger.proposals p on p.id::text = s.source_proposal_id and p.deleted_at is null
left join public.gw_enger_office_checks c on c.tenant_id = s.tenant_id and c.proposal_id = s.id
where s.source_system = 'enger' and s.archived_at is null and s.sent_at is not null;
revoke all on public.gw_enger_office_review_queue from public, anon, authenticated;
grant select on public.gw_enger_office_review_queue to service_role;
