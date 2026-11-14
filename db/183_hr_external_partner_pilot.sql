-- 183 HR: ENGER / AIまち共通パートナー実証（採用候補者・BP会社とは別）
-- 本番適用前に権限・契約・費用をレビューする。既存データは変更しない。
-- 全表はサーバーAPI(service_role)専用。anon/authenticatedへのData API権限を明示的に剥奪する。
create table if not exists public.gw_hr_external_partners (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 120),
  email text not null check (char_length(email) between 3 and 254),
  programs text[] not null default array['enger']::text[]
    check (cardinality(programs) between 1 and 2 and programs <@ array['enger','aimachi']::text[]),
  work_style text not null default 'side_job'
    check (work_style in ('side_job','remote','professional')),
  skills_note text not null default '' check (char_length(skills_note)<=1000),
  status text not null default 'screening'
    check (status in ('screening','approved','active','suspended','ended')),
  nda_reference text check (char_length(coalesce(nda_reference,''))<=300),
  contract_reference text check (char_length(coalesce(contract_reference,''))<=300),
  nda_confirmed_at timestamptz,
  contract_confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_hr_partner_active_contract_guard check (
    status <> 'active' or
    (nullif(trim(coalesce(nda_reference,'')),'') is not null
      and nullif(trim(coalesce(contract_reference,'')),'') is not null
      and nda_confirmed_at is not null and contract_confirmed_at is not null)
  ),
  unique (id,tenant_id)
);
create unique index if not exists gw_hr_external_partners_email_tenant
  on public.gw_hr_external_partners(tenant_id,lower(email));
create index if not exists idx_gw_hr_partners_status
  on public.gw_hr_external_partners(tenant_id,status,created_at desc);

create table if not exists public.gw_hr_partner_work (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  partner_id uuid not null,
  program text not null check (program in ('enger','aimachi')),
  work_type text not null check (work_type in
    ('research','appointment','matching','sales','content','local_support','other')),
  title text not null check (char_length(trim(title)) between 1 and 160),
  source_reference text check (char_length(coalesce(source_reference,''))<=160),
  status text not null default 'planned'
    check (status in ('planned','assigned','submitted','accepted','cancelled')),
  planned_revenue_yen bigint not null default 0 check (planned_revenue_yen between 0 and 1000000000),
  planned_direct_cost_yen bigint not null default 0 check (planned_direct_cost_yen between 0 and 1000000000),
  planned_partner_fee_yen bigint not null default 0 check (planned_partner_fee_yen between 0 and 1000000000),
  actual_revenue_yen bigint check (actual_revenue_yen between 0 and 1000000000),
  actual_direct_cost_yen bigint check (actual_direct_cost_yen between 0 and 1000000000),
  confirmed_partner_fee_yen bigint check (confirmed_partner_fee_yen between 0 and 1000000000),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  completed_on date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_hr_work_partner_tenant_fk
    foreign key (partner_id,tenant_id)
    references public.gw_hr_external_partners(id,tenant_id) on delete restrict,
  constraint gw_hr_work_accept_guard check (
    status <> 'accepted' or
    (accepted_at is not null and accepted_by is not null and
     actual_revenue_yen is not null and actual_direct_cost_yen is not null and
     confirmed_partner_fee_yen is not null)
  )
);
create index if not exists idx_gw_hr_partner_work_tenant_program
  on public.gw_hr_partner_work(tenant_id,program,status,created_at desc);
create index if not exists idx_gw_hr_partner_work_partner
  on public.gw_hr_partner_work(tenant_id,partner_id,created_at desc);

create table if not exists public.gw_hr_partner_pilot_budget (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  investment_ceiling_yen bigint not null default 300000 check (investment_ceiling_yen between 0 and 100000000),
  monthly_fixed_ceiling_yen bigint not null default 50000 check (monthly_fixed_ceiling_yen between 0 and 100000000),
  spent_initial_yen bigint not null default 0 check (spent_initial_yen between 0 and 100000000),
  spent_monthly_fixed_yen bigint not null default 0 check (spent_monthly_fixed_yen between 0 and 100000000),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
-- 予算は「発注限度額」ではなく可視化・判断基準。承認された報酬は別途Officeで確定する。
comment on table public.gw_hr_partner_pilot_budget is
  'パートナー制度実証の追加投資・固定費を記録。ここから自動発注・自動支払しない。';

create table if not exists public.gw_hr_partner_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  entity_type text not null check (entity_type in ('partner','work','budget')),
  entity_id uuid,
  action text not null check (char_length(action)<=80),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_gw_hr_partner_audit
  on public.gw_hr_partner_audit_events(tenant_id,created_at desc);

alter table public.gw_hr_external_partners enable row level security;
alter table public.gw_hr_partner_work enable row level security;
alter table public.gw_hr_partner_pilot_budget enable row level security;
alter table public.gw_hr_partner_audit_events enable row level security;

-- DBのデフォルトGrantに依存せず、ブラウザから直接読書きできないようにする。
revoke all on public.gw_hr_external_partners from public,anon,authenticated;
revoke all on public.gw_hr_partner_work from public,anon,authenticated;
revoke all on public.gw_hr_partner_pilot_budget from public,anon,authenticated;
revoke all on public.gw_hr_partner_audit_events from public,anon,authenticated;
grant select,insert,update,delete on public.gw_hr_external_partners to service_role;
grant select,insert,update,delete on public.gw_hr_partner_work to service_role;
grant select,insert,update,delete on public.gw_hr_partner_pilot_budget to service_role;
grant select,insert on public.gw_hr_partner_audit_events to service_role;
-- ポリシーを作らない: 非service_roleはRLSでも拒否される。API側はtenant_id+人事管理権限+MFAで検査。
comment on table public.gw_hr_external_partners is
  '個人のENGER/AIまちパートナー。BP会社・社員・採用応募者と混同しない。外部ログイン未提供。';
comment on table public.gw_hr_partner_work is
  'パートナー業務の内部実証記録。企業名・住民情報・スキルシート原本は保存せず、案件参照のみ。';
notify pgrst, 'reload schema';
