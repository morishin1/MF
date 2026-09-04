-- =============================================================================
-- 009_tasks.sql — やること（タスク・予定）
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 見えてよいのは「社内の人」だけ。顧問先ロールのユーザーに漏れないよう、
--      基礎条件に user_tenant_ids() は使わず gw_employee_id() を使う。
--   3. 担当者が自分のタスクの状態を変えるのは RLS では許可しない。
--      列単位の制限が書けないため、担当者に UPDATE を許すと担当者や期限まで
--      書き換えられる。サーバ側（api/tasks/index.js の PATCH）を唯一の口にする。
-- =============================================================================

create table if not exists public.gw_tasks (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,

  title        text not null,
  body         text,

  -- 担当者。未割り当て（部署のタスクなど）もありうるので null 可
  assignee_id  uuid references public.gw_employees(id) on delete set null,

  -- 期限を過ぎたときに気づいてほしい人（責任者）
  escalate_to  uuid references public.gw_employees(id) on delete set null,
  escalated_at timestamptz,

  due_on       date,
  priority     text not null default 'normal'
               check (priority in ('low','normal','high')),
  status       text not null default 'todo'
               check (status in ('todo','doing','done','cancelled')),

  -- 「入社手続き」「月次経理」など。自由入力の分類
  category     text,

  completed_at timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_gw_tasks_tenant
  on public.gw_tasks(tenant_id, status, due_on);
create index if not exists idx_gw_tasks_assignee
  on public.gw_tasks(assignee_id, status);


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.gw_tasks enable row level security;

-- 参照: 管理者・人事は全件。それ以外の社員は自分が関係するものだけ
--       （担当・エスカレーション先・自分が作ったもの）
drop policy if exists gw_tasks_select on public.gw_tasks;
create policy gw_tasks_select on public.gw_tasks
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or assignee_id  = public.gw_employee_id(tenant_id)
    or escalate_to  = public.gw_employee_id(tenant_id)
    or created_by   = auth.uid()
  );

-- 作成・編集・削除: 管理者と人事のみ。
-- 担当者による状態変更は api/tasks/index.js（service_role）で扱う。
drop policy if exists gw_tasks_write on public.gw_tasks;
create policy gw_tasks_write on public.gw_tasks
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- -----------------------------------------------------------------------------
-- 担当者選択のために、社員名簿を社内の人に見せる
--   005 の gw_employees_select は is_tenant_staff 限定で、007 で本人の行だけ
--   追加した。タスクの担当者名を出すには、社員同士が名前を引ける必要がある。
--   公開するのは名簿に載っている人だけ（＝顧問先ロールのユーザーには見えない）。
-- -----------------------------------------------------------------------------
drop policy if exists gw_employees_peer_select on public.gw_employees;
create policy gw_employees_peer_select on public.gw_employees
  for select
  using (public.gw_employee_id(tenant_id) is not null);
