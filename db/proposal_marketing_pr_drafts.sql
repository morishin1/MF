-- Proposal: apply only after code review and explicit operator approval.
-- Internal Marketing PR draft / registered original. NOT a published PR TIMES post.
begin;
create table if not exists public.gw_marketing_pr_drafts (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 created_by uuid not null references auth.users(id),
 updated_by uuid not null references auth.users(id),
 status text not null default 'draft' check(status in ('draft','registered')),
 payload jsonb not null default '{}'::jsonb
   check(jsonb_typeof(payload)='object' and octet_length(payload::text) <= 120000),
 version integer not null default 1 check(version >= 1),
 registered_at timestamptz,
 registered_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check ((status='draft' and registered_at is null and registered_by is null)
     or (status='registered' and registered_at is not null and registered_by is not null))
);
create index if not exists gw_mpr_tenant_updated_idx
 on public.gw_marketing_pr_drafts (tenant_id, updated_at desc);
create index if not exists gw_mpr_author_idx
 on public.gw_marketing_pr_drafts (tenant_id, created_by, created_at desc);
alter table public.gw_marketing_pr_drafts enable row level security;
revoke all on public.gw_marketing_pr_drafts from public, anon, authenticated;
-- Browser cannot directly select or mutate; server verifies tenant and marketing permission.
-- No SECURITY DEFINER or general authenticated grant.
comment on table public.gw_marketing_pr_drafts is
 'Internal Marketing PR originals: draft -> registered. Does not post to PR TIMES or any SNS.';
commit;
