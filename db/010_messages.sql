-- =============================================================================
-- 010_messages.sql — 社内メッセージ（1対1・グループ）
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 見えるのは「そのスレッドに参加している人」だけ。
--      管理者や経営者であっても、参加していないスレッドは読めない。
--      個人のやりとりなので、役職で覗けるようにはしない。
--   3. スレッドの作成と参加者の追加、既読の更新は RLS では許可しない。
--      自分の参加行を書き換えて別のスレッドに入り込めてしまうため、
--      サーバ側（api/messages/*）を唯一の書き込み口にする。
--      本文の投稿だけは安全に書けるので RLS で直接許可する。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) スレッド
-- -----------------------------------------------------------------------------
create table if not exists public.gw_threads (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,

  kind            text not null default 'dm' check (kind in ('dm','group')),
  -- グループのときの名前。1対1では相手の名前を画面側で出すので null
  title           text,

  created_by      uuid references auth.users(id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists idx_gw_threads_tenant
  on public.gw_threads(tenant_id, last_message_at desc);


-- -----------------------------------------------------------------------------
-- 2) 参加者
-- -----------------------------------------------------------------------------
create table if not exists public.gw_thread_members (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  thread_id    uuid not null references public.gw_threads(id) on delete cascade,
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,

  -- ここまで読んだ、の目印。未読件数はこれと突き合わせて数える
  last_read_at timestamptz not null default 'epoch',
  joined_at    timestamptz not null default now(),

  unique (thread_id, employee_id)
);

create index if not exists idx_gw_thread_members_employee
  on public.gw_thread_members(employee_id);


-- -----------------------------------------------------------------------------
-- 3) 本文
-- -----------------------------------------------------------------------------
create table if not exists public.gw_messages (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  thread_id  uuid not null references public.gw_threads(id) on delete cascade,
  sender_id  uuid not null references public.gw_employees(id) on delete cascade,

  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gw_messages_thread
  on public.gw_messages(thread_id, created_at desc);


-- -----------------------------------------------------------------------------
-- 4) ヘルパ: 自分がそのスレッドに参加しているか
--    RLS の中から呼ぶので SECURITY DEFINER（無限再帰を避ける）
-- -----------------------------------------------------------------------------
create or replace function public.gw_in_thread(p_thread uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_thread_members tm
      join public.gw_employees e on e.id = tm.employee_id
     where tm.thread_id = p_thread
       and e.user_id = auth.uid()
  )
$$;


-- -----------------------------------------------------------------------------
-- 5) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_threads        enable row level security;
alter table public.gw_thread_members enable row level security;
alter table public.gw_messages       enable row level security;

-- スレッド: 参加者だけが見える。作成・変更のポリシーは意図的に置かない
drop policy if exists gw_threads_select on public.gw_threads;
create policy gw_threads_select on public.gw_threads
  for select using (public.gw_in_thread(id));

-- 参加者一覧: 同じスレッドの参加者だけが見える。書き込みポリシーは置かない
drop policy if exists gw_thread_members_select on public.gw_thread_members;
create policy gw_thread_members_select on public.gw_thread_members
  for select using (public.gw_in_thread(thread_id));

-- 本文の参照: 参加者だけ
drop policy if exists gw_messages_select on public.gw_messages;
create policy gw_messages_select on public.gw_messages
  for select using (public.gw_in_thread(thread_id));

-- 本文の投稿: 参加しているスレッドに、自分名義でのみ書ける。
-- 他人になりすませないよう sender_id を自分の社員IDに固定する。
drop policy if exists gw_messages_insert on public.gw_messages;
create policy gw_messages_insert on public.gw_messages
  for insert
  with check (
    public.gw_in_thread(thread_id)
    and sender_id = public.gw_employee_id(tenant_id)
  );

-- 投稿の取り消しは自分の分だけ（編集はできない。履歴を濁らせないため）
drop policy if exists gw_messages_delete on public.gw_messages;
create policy gw_messages_delete on public.gw_messages
  for delete
  using (sender_id = public.gw_employee_id(tenant_id));
