-- =============================================================================
-- 125: Office 定例業務マスター・Office 業務予定（年間業務カレンダー）
--
-- ■ 何をするか（足すだけ。既存の表は変えない。個人の予定 gw_calendar_events には混ぜない）
--   1) gw_office_recurring_tasks … 定例業務マスター（業務名・カテゴリ・担当・繰り返し・期限ルール・有効／停止）
--        繰り返し：none（1回だけ）／weekly／monthly／yearly。ルールは recurrence_rule（jsonb。lib/office-recurring.js が読む）
--        Excel 年間予定表からの取り込みは source='excel'・source_key（同じ行を2回取り込まない）
--   2) gw_office_calendar_events … Office の業務予定（マスターから自動で作る回と、単発の予定）
--        状態：pending（未完了）／done（完了。完了日時・完了した人を残す）／skipped（今回は行わない）
--        同じマスターの同じ日の予定は1件だけ（uq_gw_office_events_recurring）。消した回も skipped で残るので作り直さない
--
-- ■ 権限
--   2つの表とも RLS を有効にし、ポリシーは置かない（ログインした人が直接は読めない・書けない）。
--   読み書きは API（api/office-tasks/recurring.js・api/office-tasks/calendar.js）だけで、Office の権限
--   （人事・労務＝officeHr／経理・事務＝officeFinance／月末月初＝officeApp。lib/gw.js）とカテゴリで確かめてから service role で行う。
--
-- ■ 適用の順番
--   この SQL → アプリのデプロイ。デプロイが先でも、定例業務の画面・Office ホームのカレンダーだけ「SQL を流してください」と出て、ほかは止まらない。
--
-- 実行方法: Supabase の SQL Editor に、このファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: schema.sql（tenants）・005（gw_employees）
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_employees') is null then
    raise exception 'gw_employees がありません。先に db/005_groupware_core.sql を流してください';
  end if;
end $$;

create table if not exists public.gw_office_recurring_tasks (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  title                text not null check (char_length(title) between 1 and 200),
  description          text check (description is null or char_length(description) <= 4000),
  category             text not null check (category in ('all', 'sales_admin', 'hr', 'labor', 'ecnw', 'finance', 'other')),
  assignee_employee_id uuid references public.gw_employees(id) on delete set null,
  department           text check (department is null or char_length(department) <= 100),
  priority             text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  note                 text check (note is null or char_length(note) <= 2000),
  url                  text check (url is null or char_length(url) <= 1000),
  recurrence_type      text not null check (recurrence_type in ('none', 'weekly', 'monthly', 'yearly')),
  recurrence_rule      jsonb not null default '{}'::jsonb,
  start_on             date not null default current_date,
  end_on               date,
  due_rule             jsonb not null default '{"type":"same"}'::jsonb,
  is_active            boolean not null default true,
  source               text not null default 'manual' check (source in ('manual', 'excel')),
  source_key           text check (source_key is null or char_length(source_key) <= 200),
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint gw_office_recurring_tasks_period check (end_on is null or end_on >= start_on)
);

-- Excel の同じ行を2回取り込まない
create unique index if not exists uq_gw_office_recurring_source
  on public.gw_office_recurring_tasks(tenant_id, source_key) where source_key is not null;
create index if not exists idx_gw_office_recurring_tenant on public.gw_office_recurring_tasks(tenant_id, is_active, category);

comment on table public.gw_office_recurring_tasks is
  'Office 定例業務マスター。ここから gw_office_calendar_events を自動で作る（api/cron/office-recurring.js）。個人の予定（gw_calendar_events）とは別。db/125';

create table if not exists public.gw_office_calendar_events (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  recurring_task_id    uuid references public.gw_office_recurring_tasks(id) on delete set null,
  title                text not null check (char_length(title) between 1 and 200),
  description          text check (description is null or char_length(description) <= 4000),
  category             text not null check (category in ('all', 'sales_admin', 'hr', 'labor', 'ecnw', 'finance', 'other')),
  event_date           date not null,
  due_on               date,
  assignee_employee_id uuid references public.gw_employees(id) on delete set null,
  department           text check (department is null or char_length(department) <= 100),
  priority             text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  note                 text check (note is null or char_length(note) <= 2000),
  url                  text check (url is null or char_length(url) <= 1000),
  status               text not null default 'pending' check (status in ('pending', 'done', 'skipped')),
  source               text not null default 'recurring' check (source in ('recurring', 'manual', 'excel')),
  source_id            text check (source_id is null or char_length(source_id) <= 200),
  completed_at         timestamptz,
  completed_by         uuid references auth.users(id) on delete set null,
  completed_by_name    text,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint gw_office_calendar_events_due check (due_on is null or due_on >= event_date),
  -- 完了なら完了日時がある。未完了・今回なしなら無い
  constraint gw_office_calendar_events_done check ((status = 'done') = (completed_at is not null))
);

-- 同じ定例業務から、同じ日の予定は1件だけ（二重生成の防止）
create unique index if not exists uq_gw_office_events_recurring
  on public.gw_office_calendar_events(recurring_task_id, event_date) where recurring_task_id is not null;
-- Excel の同じ単発の行を2回取り込まない
create unique index if not exists uq_gw_office_events_source
  on public.gw_office_calendar_events(tenant_id, source_id) where source_id is not null;
create index if not exists idx_gw_office_events_date on public.gw_office_calendar_events(tenant_id, event_date);
create index if not exists idx_gw_office_events_open on public.gw_office_calendar_events(tenant_id, status, due_on);

comment on table public.gw_office_calendar_events is
  'Office の業務予定（定例業務マスターから作った回と、単発の予定）。完了日時・完了した人を残す。個人の予定（gw_calendar_events）とは別。db/125';

alter table public.gw_office_recurring_tasks enable row level security;
alter table public.gw_office_calendar_events enable row level security;
-- ポリシーは置かない（API が Office の権限とカテゴリを確かめてから service role で読み書きする）

notify pgrst, 'reload schema';

commit;

-- 確認1（適用後）: 2つの表があり、RLS が有効で、ポリシーが0件（2行。rls = true・policies = 0）
--
--   select c.relname, c.relrowsecurity as rls,
--          (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relname in ('gw_office_recurring_tasks', 'gw_office_calendar_events')
--    order by c.relname;
--
-- 確認2（適用後）: 一意の索引（3行）
--
--   select indexname from pg_indexes where schemaname = 'public'
--      and indexname in ('uq_gw_office_recurring_source', 'uq_gw_office_events_recurring', 'uq_gw_office_events_source')
--    order by indexname;
--
-- 戻す（データごと消える。本番で流す前に必ず確認）:
--   drop table if exists public.gw_office_calendar_events, public.gw_office_recurring_tasks;
