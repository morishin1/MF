-- 164: 企業詳細の営業履歴を使ったAI次回対応レビュー
-- 社内Salesのみ。AIの判断は下書きであり、営業のステータス・送信・提案を自動変更しない。
begin;
create table if not exists public.gw_sales_company_ai_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_id uuid not null,
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  source_count integer not null check (source_count between 0 and 180),
  source_partial boolean not null default false,
  model text not null check (char_length(model) <= 100),
  result jsonb not null,
  evidence jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check(status in ('draft','adopted')),
  created_by uuid not null references auth.users(id) on delete cascade,
  adopted_by uuid references auth.users(id) on delete set null,
  adopted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(tenant_id,company_id,source_hash)
);
create index if not exists idx_gw_sales_company_ai_review_latest
  on public.gw_sales_company_ai_reviews(tenant_id,company_id,created_at desc);
alter table public.gw_sales_company_ai_reviews enable row level security;
revoke all on public.gw_sales_company_ai_reviews from public,anon,authenticated;
grant select,insert,update,delete on public.gw_sales_company_ai_reviews to service_role;
comment on table public.gw_sales_company_ai_reviews is
 'AI review of tenant-scoped linked ENGER/Sales history. Draft until an operator explicitly adopts the next action.';
commit;
notify pgrst, 'reload schema';
