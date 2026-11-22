-- Confirmation is attached to the existing proposal, with a version of the ENGER information read.
create table public.gw_enger_proposal_coordination (
  tenant_id uuid not null references public.tenants(id),
  proposal_id uuid not null references public.gw_sales_proposals(id),
  source_revision text not null check (source_revision ~ '^[0-9a-f]{64}$'),
  decision text not null check (char_length(btrim(decision)) between 1 and 1500),
  next_step text not null check (char_length(btrim(next_step)) between 1 and 1000),
  sales_confirmed_by uuid not null,
  sales_confirmed_at timestamptz not null default now(),
  enger_confirmed_by uuid,
  enger_confirmed_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  primary key (tenant_id, proposal_id),
  check ((enger_confirmed_by is null) = (enger_confirmed_at is null)),
  check (enger_confirmed_by is null or enger_confirmed_by <> sales_confirmed_by)
);

alter table public.gw_enger_proposal_coordination enable row level security;
revoke all on public.gw_enger_proposal_coordination from public, anon, authenticated;
grant select, insert, update on public.gw_enger_proposal_coordination to service_role;
