-- 経営者がローカルAIの分析を確認して本人に共有するための週次フィードバック。
-- draft と published は別行。下書きを再編集しても公開済みの内容は変わらない。
-- API のみ service_role でアクセスし、anon/authenticated に直接公開しない。
create table if not exists public.gw_weekly_prep_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  employee_id uuid not null references public.gw_employees(id),
  period_start date not null,
  period_end date not null,
  status text not null check (status in ('draft','published')),
  conclusion text not null default '',
  reason text not null default '',
  evidence text not null default '',
  recommendation text not null default '',
  good_points text not null default '',
  improvement_points text not null default '',
  next_actions text not null default '',
  created_by uuid,
  updated_by uuid,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_weekly_prep_period_check check (period_end >= period_start and period_end <= period_start + 34),
  constraint gw_weekly_prep_one_status unique (tenant_id, employee_id, period_start, period_end, status)
);
create index if not exists gw_weekly_prep_published_by_employee
  on public.gw_weekly_prep_feedback (tenant_id, employee_id, published_at desc)
  where status = 'published';
alter table public.gw_weekly_prep_feedback enable row level security;
revoke all on public.gw_weekly_prep_feedback from public, anon, authenticated;
grant select, insert, update, delete on public.gw_weekly_prep_feedback to service_role;
comment on table public.gw_weekly_prep_feedback is
  'Local PREP feedback. Only owner may draft/publish via guarded server API; employee can read published own via server API.';
