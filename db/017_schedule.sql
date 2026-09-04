-- =============================================================================
-- 017_schedule.sql — 自分だけの社内カレンダー
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 位置づけ
--   Google カレンダーは「設備・スペースの予約」という会社の共有カレンダーとして
--   すでに使っている（015）。こちらは個人の予定で、性格がまったく違う。
--
--   個人の予定は本人以外に見せない。管理者にも経営者にも見せない。
--   スケジュールの中身は「誰といつ会っているか」が分かってしまうもので、
--   社内の連絡や手続きより機微が高い。見える必要のある人がいないなら、
--   最初から誰にも見えないようにしておく。
--
--   これは意図的な判断であって、あとから「部署内で共有」を足すときは
--   visibility の列を増やしてポリシーを広げる。逆（狭める）は既に見られた
--   あとでは取り返しがつかないので、狭いほうから始める。
-- =============================================================================

create table if not exists public.gw_calendar_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  -- 予定の持ち主。この人以外は読めない
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,

  title        text not null,
  body         text,
  location     text,

  category     text not null default 'work'
               check (category in ('work','meeting','visit','private','other')),

  -- 終日の予定。時刻を見せずに1日の帯として出す
  all_day      boolean not null default false,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 終日は開始＝終了になりうるので > ではなく >=
  constraint gw_calendar_events_time_order check (ends_at >= starts_at)
);

create index if not exists idx_gw_calendar_events_owner
  on public.gw_calendar_events(employee_id, starts_at);


-- -----------------------------------------------------------------------------
-- RLS: 本人だけ。is_tenant_staff も gw_is_hr も、あえて入れない
-- -----------------------------------------------------------------------------
alter table public.gw_calendar_events enable row level security;

drop policy if exists gw_calendar_events_own on public.gw_calendar_events;
create policy gw_calendar_events_own on public.gw_calendar_events
  for all
  using (employee_id = public.gw_employee_id(tenant_id))
  with check (employee_id = public.gw_employee_id(tenant_id));
