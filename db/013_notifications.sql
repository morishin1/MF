-- =============================================================================
-- 013_notifications.sql — 社内通知
--
-- 前提: 005_groupware_core.sql と 009_tasks.sql が適用済み。
--
-- 用途
--   いまは「タスクの期限超過」だけだが、あとから新着メッセージや
--   提出物の督促にも使えるよう、汎用の1テーブルにしている。
--
-- 方針
--   自分あての通知しか見えない。管理者や経営者でも他人の通知は読めない。
--   （誰に何が届いたかは、その人の仕事の中身そのものなので広げない）
--   書き込みポリシーは置かない。サーバ側（cron / API）からのみ作る。
-- =============================================================================

create table if not exists public.gw_notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  -- 宛先。社員名簿の行に紐づける
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  kind        text not null default 'general'
              check (kind in ('general','task_overdue','task_assigned','notice','message')),

  title       text not null,
  body        text,
  -- 押したときの遷移先（同一サイト内の相対パス）
  link        text,

  -- 同じ用件で何度も通知しないための鍵。例: 'task_overdue:<task_id>'
  dedupe_key  text,

  read_at     timestamptz,
  created_at  timestamptz not null default now(),

  unique (employee_id, dedupe_key)
);

create index if not exists idx_gw_notifications_inbox
  on public.gw_notifications(employee_id, read_at, created_at desc);


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.gw_notifications enable row level security;

-- 参照: 自分あてのものだけ
drop policy if exists gw_notifications_select on public.gw_notifications;
create policy gw_notifications_select on public.gw_notifications
  for select
  using (employee_id = public.gw_employee_id(tenant_id));

-- 既読を付けるのは自分の分だけ。作成・削除のポリシーは置かない
drop policy if exists gw_notifications_update on public.gw_notifications;
create policy gw_notifications_update on public.gw_notifications
  for update
  using (employee_id = public.gw_employee_id(tenant_id))
  with check (employee_id = public.gw_employee_id(tenant_id));
