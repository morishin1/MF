-- =============================================================================
-- 008_onboarding.sql — 入社・退職手続き
--
-- 前提: db/005_groupware_core.sql と db/007_notices.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 手続きの中身は人事情報そのものなので、既定は「人事と管理者だけ」。
--      本人は自分の手続きだけ、社労士は共有マークの付いた項目だけ見える。
--   3. 本人による「提出しました」の更新は RLS では許可しない。
--      列単位の制限が RLS では書けないため、直接 UPDATE を全面的に塞ぎ、
--      サーバ側の API（api/onboarding/submit.js）だけを唯一の書き込み口にする。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 手続き本体
-- -----------------------------------------------------------------------------
create table if not exists public.gw_procedures (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,

  kind         text not null default 'onboarding'
               check (kind in ('onboarding','offboarding')),
  status       text not null default 'in_progress'
               check (status in ('not_started','in_progress','done','cancelled')),

  -- 入社日／退職日。期限の色分けに使う
  target_on    date,
  note         text,

  -- 個人フォルダ（Google Drive）。未設定の環境では null のまま
  drive_folder_id text,
  drive_link      text,

  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 同じ人に同じ種別の手続きを二重に作らない
  unique (employee_id, kind)
);

create index if not exists idx_gw_procedures_tenant
  on public.gw_procedures(tenant_id, status, target_on);


-- -----------------------------------------------------------------------------
-- 2) 手続きの項目（提出書類・作業）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_procedure_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  procedure_id  uuid not null references public.gw_procedures(id) on delete cascade,

  title         text not null,
  category      text not null default 'document'
                check (category in ('document','task','account','equipment')),

  -- 誰の担当か。本人が出すものだけをメンバー画面に出す
  owner         text not null default 'employee'
                check (owner in ('employee','hr','labor_advisor')),

  required      boolean not null default true,

  -- 社労士に開示してよい項目か。既定は開示しない
  share_with_advisor boolean not null default false,

  status        text not null default 'todo'
                check (status in ('todo','submitted','done','na')),

  due_on        date,
  note          text,
  sort_order    integer not null default 0,

  -- 本人がアップロードした書類と紐づける（documents は会計側と共用）
  document_id   uuid references public.documents(id) on delete set null,

  completed_at  timestamptz,
  completed_by  uuid references auth.users(id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_gw_procedure_items_proc
  on public.gw_procedure_items(procedure_id, sort_order);


-- -----------------------------------------------------------------------------
-- 3) ヘルパ: 社労士かどうか
-- -----------------------------------------------------------------------------
create or replace function public.gw_is_advisor(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'labor_advisor')
$$;

-- 指定した手続きが自分のものか（項目のポリシーから呼ぶ）
create or replace function public.gw_procedure_is_mine(p_procedure uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_procedures p
      join public.gw_employees e on e.id = p.employee_id
     where p.id = p_procedure
       and e.user_id = auth.uid()
  )
$$;


-- -----------------------------------------------------------------------------
-- 4) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_procedures      enable row level security;
alter table public.gw_procedure_items enable row level security;

-- 手続きの参照: 管理者・人事は全件、本人は自分の分、社労士は一覧のみ
drop policy if exists gw_procedures_select on public.gw_procedures;
create policy gw_procedures_select on public.gw_procedures
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or public.gw_is_advisor(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

-- 手続きの作成・編集・削除: 管理者と人事のみ
drop policy if exists gw_procedures_write on public.gw_procedures;
create policy gw_procedures_write on public.gw_procedures
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 項目の参照:
--   管理者・人事 … 全件
--   本人         … 自分の手続きの項目
--   社労士       … share_with_advisor が立っている項目だけ
drop policy if exists gw_procedure_items_select on public.gw_procedure_items;
create policy gw_procedure_items_select on public.gw_procedure_items
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or public.gw_procedure_is_mine(procedure_id)
    or (public.gw_is_advisor(tenant_id) and share_with_advisor)
  );

-- 社労士が「誰の手続きか」を見られるようにする（追加のみ）。
-- 手続きが1件も無い社員は対象外なので、名簿全体が見えるわけではない。
drop policy if exists gw_employees_advisor_select on public.gw_employees;
create policy gw_employees_advisor_select on public.gw_employees
  for select
  using (
    public.gw_is_advisor(tenant_id)
    and exists (
      select 1 from public.gw_procedures p where p.employee_id = gw_employees.id
    )
  );

-- 項目の作成・編集・削除: 管理者と人事のみ。
-- 本人の「提出しました」も含めてここでは許可しない（列単位の制限が書けないため）。
-- 本人の更新は api/onboarding/submit.js（service_role）を唯一の口にする。
drop policy if exists gw_procedure_items_write on public.gw_procedure_items;
create policy gw_procedure_items_write on public.gw_procedure_items
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));
