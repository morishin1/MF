-- =============================================================================
-- 146: Office 社労士・税理士タスク
--
-- 社内ロール（labor_advisor / tax_advisor）を持つ専門家が、担当タスクだけを処理する。
-- タスク・添付・コメント・履歴は RLS を有効にし、通常ユーザー向けポリシーを作らない。
-- 認証・担当・業務種別・HR の共有項目を API で再確認してから service role で扱う。
-- 個人番号の列・値は追加しない。本人提出書類は既存の hr バケットから共有済み書類だけ参照する。
--
-- 適用: Supabase SQL Editor でこのファイル全体を実行（再実行可）。
-- =============================================================================

begin;

alter table public.gw_role_grants drop constraint if exists gw_role_grants_role_check;
alter table public.gw_role_grants add constraint gw_role_grants_role_check
  check (role in ('owner', 'hr', 'manager', 'labor_advisor', 'tax_advisor', 'it', 'finance', 'recruiter', 'sales'));

comment on column public.gw_role_grants.role is
  'tax_advisor=税理士。Office の税理士タスクだけ。給与・人事・社労士業務にはアクセスしない';

alter table public.gw_procedure_items
  add column if not exists advisor_review_note text;
comment on column public.gw_procedure_items.advisor_review_note is
  '社労士の再提出依頼。本人・人事に表示し、再提出後に消す。個人番号は記録しない';

insert into storage.buckets (id, name, public)
values ('professional-tasks', 'professional-tasks', false)
on conflict (id) do nothing;

create table if not exists public.gw_professional_task_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  system_key text,
  title text not null check (char_length(title) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  due_day integer not null default 10 check (due_day between 1 and 31),
  assignee_employee_id uuid references public.gw_employees(id) on delete set null,
  checklist jsonb not null default '[]'::jsonb,
  is_active boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_gw_professional_template_system_key
  on public.gw_professional_task_templates(tenant_id, system_key) where system_key is not null;
create index if not exists idx_gw_professional_templates_tenant
  on public.gw_professional_task_templates(tenant_id, is_active, due_day);

create table if not exists public.gw_professional_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('labor', 'tax')),
  title text not null check (char_length(title) between 1 and 200),
  description text check (description is null or char_length(description) <= 4000),
  due_on date,
  priority text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'submitted', 'returned', 'done', 'skipped')),
  assignee_employee_id uuid references public.gw_employees(id) on delete set null,
  procedure_id uuid references public.gw_procedures(id) on delete set null,
  procedure_item_id uuid references public.gw_procedure_items(id) on delete set null,
  template_id uuid references public.gw_professional_task_templates(id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'procedure', 'recurring')),
  source_key text,
  created_by uuid references auth.users(id) on delete set null,
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_professional_tasks_source_shape check (
    (source = 'procedure' and kind = 'labor' and procedure_id is not null and procedure_item_id is not null)
    or (source <> 'procedure' and procedure_id is null and procedure_item_id is null)
  )
);
create unique index if not exists uq_gw_professional_tasks_source
  on public.gw_professional_tasks(tenant_id, source_key) where source_key is not null;
create unique index if not exists uq_gw_professional_tasks_procedure_item
  on public.gw_professional_tasks(procedure_item_id) where procedure_item_id is not null;
create index if not exists idx_gw_professional_tasks_list
  on public.gw_professional_tasks(tenant_id, kind, status, due_on);
create index if not exists idx_gw_professional_tasks_assignee
  on public.gw_professional_tasks(assignee_employee_id, status, due_on);

create table if not exists public.gw_professional_task_checklist (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.gw_professional_tasks(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  position integer not null default 0,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_gw_professional_checklist_task
  on public.gw_professional_task_checklist(task_id, position);

create table if not exists public.gw_professional_task_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.gw_professional_tasks(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  author_name text,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists idx_gw_professional_comments_task
  on public.gw_professional_task_comments(task_id, created_at);

create table if not exists public.gw_professional_task_events (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.gw_professional_tasks(id) on delete cascade,
  kind text not null check (kind in ('created', 'assigned', 'due', 'status', 'returned', 'approved', 'checklist', 'comment', 'file', 'edited')),
  actor_id uuid references auth.users(id) on delete set null,
  actor_name text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_gw_professional_events_task
  on public.gw_professional_task_events(task_id, created_at);

create table if not exists public.gw_professional_task_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.gw_professional_tasks(id) on delete cascade,
  filename text not null check (char_length(filename) between 1 and 255),
  mime_type text not null,
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  storage_path text not null unique,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_gw_professional_files_task
  on public.gw_professional_task_files(task_id, created_at);

-- service role API のみが読み書きできる。Storage も公開ポリシーを作らず、短期署名URLだけ返す。
alter table public.gw_professional_task_templates enable row level security;
alter table public.gw_professional_tasks enable row level security;
alter table public.gw_professional_task_checklist enable row level security;
alter table public.gw_professional_task_comments enable row level security;
alter table public.gw_professional_task_events enable row level security;
alter table public.gw_professional_task_files enable row level security;

revoke all on public.gw_professional_task_templates, public.gw_professional_tasks,
  public.gw_professional_task_checklist, public.gw_professional_task_comments,
  public.gw_professional_task_events, public.gw_professional_task_files from anon, authenticated;
grant all on public.gw_professional_task_templates, public.gw_professional_tasks,
  public.gw_professional_task_checklist, public.gw_professional_task_comments,
  public.gw_professional_task_events, public.gw_professional_task_files to service_role;
revoke all on sequence public.gw_professional_task_events_id_seq from anon, authenticated;
grant usage, select on sequence public.gw_professional_task_events_id_seq to service_role;

comment on table public.gw_professional_tasks is
  'Office の社労士・税理士タスク。通常ユーザーの RLS ポリシーは無く、担当者を検証する API だけが扱う';

notify pgrst, 'reload schema';
commit;
