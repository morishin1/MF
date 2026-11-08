-- Per-document template links; matching the member lifecycle's document key.
-- Existing Library, office merge templates, and e-sign templates remain single sources of truth.
create table if not exists public.gw_member_doc_template_links (
  tenant_id uuid not null,
  doc_key text not null check (doc_key ~ '^[a-z0-9_]{2,80}$'),
  source_kind text not null check (source_kind in ('library','general','sign')),
  source_id uuid not null,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, doc_key)
);
alter table public.gw_member_doc_template_links enable row level security;
revoke all on public.gw_member_doc_template_links from public, anon, authenticated;
grant all on public.gw_member_doc_template_links to service_role;
comment on table public.gw_member_doc_template_links is
 'Office/KEIEI employee-lifecycle document key to the existing library/general/e-sign template. API-only write; no employee or personal data.';
