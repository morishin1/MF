-- 163: 企業向け商談ポータル（Sales と分離した外部ログイン）
-- データの公開は Sales 担当が明示的に選択した提案だけ。
-- 外部ユーザーは service_role を使うサーバ API を通して認可し、Data API から直接参照できない。
begin;

create table if not exists public.gw_company_portal_access (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null references public.gw_sales_companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  active boolean not null default true,
  needs_password_change boolean not null default false,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, company_id, user_id)
);

create index if not exists idx_gw_company_portal_access_user
  on public.gw_company_portal_access(user_id, active);

create table if not exists public.gw_company_portal_shares (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null references public.gw_sales_companies(id) on delete cascade,
  proposal_id uuid not null references public.gw_sales_proposals(id) on delete cascade,
  public_title text not null check (char_length(public_title) between 1 and 160),
  public_summary text not null default '' check (char_length(public_summary) <= 2000),
  document_url text check (document_url is null or
    (char_length(document_url) <= 1500 and document_url ~* '^https://')),
  active boolean not null default true,
  published_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, company_id, proposal_id)
);

create index if not exists idx_gw_company_portal_shares_company
  on public.gw_company_portal_shares(tenant_id, company_id, active);

create table if not exists public.gw_company_portal_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null references public.gw_sales_companies(id) on delete cascade,
  proposal_id uuid not null references public.gw_sales_proposals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('interested','details','meeting')),
  message text not null default '' check (char_length(message) <= 800),
  sales_synced_at timestamptz,
  client_request_id uuid unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_gw_company_portal_responses_company
  on public.gw_company_portal_responses(tenant_id, company_id, created_at desc);
create index if not exists idx_gw_company_portal_responses_proposal
  on public.gw_company_portal_responses(proposal_id, created_at desc);

alter table public.gw_company_portal_access enable row level security;
alter table public.gw_company_portal_shares enable row level security;
alter table public.gw_company_portal_responses enable row level security;

-- 外部用の表は公開 API から直接触れない。必ず認証＋所属会社の照合を行うサーバAPI経由。
revoke all on public.gw_company_portal_access from public, anon, authenticated;
revoke all on public.gw_company_portal_shares from public, anon, authenticated;
revoke all on public.gw_company_portal_responses from public, anon, authenticated;
grant select, insert, update, delete on public.gw_company_portal_access to service_role;
grant select, insert, update, delete on public.gw_company_portal_shares to service_role;
grant select, insert, update, delete on public.gw_company_portal_responses to service_role;
commit;
notify pgrst, 'reload schema';
