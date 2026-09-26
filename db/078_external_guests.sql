-- =============================================================================
-- 078: 外部メンバー（ゲスト）招待
--
-- ■ gw_employees には入れない。deny-by-default を守るため
--
--   既存のRLSには「gw_employees の行さえあれば全員に見せる」ものが複数ある
--   （社員一覧・お知らせ・スペース予約・経費・社内文書・共有カレンダー等）。
--   ゲストを gw_employees に混ぜると、新しく絞ったつもりのテーブル以外は
--   全部素通りしてしまう。gw_employees とは別の名簿（gw_guests）を持ち、
--   既存のポリシーが一切ゲストを拾わないことを deny-by-default の土台にする。
--
-- ■ 「プロジェクト」は新しいマスタを作らない
--
--   gw_tasks にはプロジェクトという実体が無く、category（自由入力の文字列）
--   だけがある。ここに新しいプロジェクトのマスタを足すと、
--   タスク機能全体の作り直しになる。ゲストへの「指定プロジェクト」許可は、
--   gw_tasks.category の値そのものを許可対象にする（新しい表は増やさない）
--
-- ■ 招待URLは、端末ペアリング（db/057・061）と同じ形
--
--   平文のトークンは発行のときに1回だけ返し、DBには sha256 のハッシュだけを
--   持つ。有効期限・使用済みの判定もそちらと同じ考え方。
--   違うのは、再発行や取消を「行の削除」ではなく revoked_at で残すところ
--   （管理画面の「無効」という状態と、監査ログの両方に要るため）
--
-- ■ 書き込みは許可しない（今回のMVP）
--
--   「閲覧できる範囲を指定」なので、許可した対象への読み取りだけを開ける。
--   投稿・編集のRLSポリシーは足さない（無ければ既定で拒否される）
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 005_groupware_core.sql（is_tenant_staff / gw_is_hr / gw_activity_log）、
--       009_tasks.sql / 010_messages.sql / 020_library.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 外部メンバー本体
-- -----------------------------------------------------------------------------
create table if not exists public.gw_guests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  display_name  text not null,
  company_name  text,
  email         text not null,

  -- 登録が終わるまでは null。ログインアカウント（auth.users）
  user_id       uuid references auth.users(id) on delete set null,

  -- 管理者が明示的に無効化した（登録済みでもログインできなくする）
  disabled_at   timestamptz,
  disabled_by   uuid references auth.users(id) on delete set null,

  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists idx_gw_guests_user
  on public.gw_guests(user_id) where user_id is not null;
create index if not exists idx_gw_guests_tenant
  on public.gw_guests(tenant_id, created_at desc);

comment on table public.gw_guests is
  '社外の招待メンバー。gw_employees とは別の名簿（deny-by-defaultの土台）。'
  '登録が終わるまで user_id は null';

-- -----------------------------------------------------------------------------
-- 2) 招待（1件ずつ履歴で持つ。再発行のたびに新しい行ができる）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_guest_invites (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  guest_id     uuid not null references public.gw_guests(id) on delete cascade,

  token_hash   text not null unique,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  revoked_at   timestamptz,

  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_gw_guest_invites_guest
  on public.gw_guest_invites(guest_id, created_at desc);

comment on column public.gw_guest_invites.token_hash is
  '平文は発行のときに1度だけ画面に出す。DBにはsha256しか持たない';

-- -----------------------------------------------------------------------------
-- 3) 許可（プロジェクト／チャット／資料／タスクの4種類）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_guest_grants (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  guest_id       uuid not null references public.gw_guests(id) on delete cascade,

  -- project : gw_tasks.category の値そのもの
  -- thread  : gw_threads.id
  -- document: gw_library.id
  -- task    : gw_tasks.id
  resource_type  text not null check (resource_type in ('project', 'thread', 'document', 'task')),
  resource_key   text not null,
  -- 一覧・ドロワーに出す表示名。元が消えても許可の履歴が読めるよう、都度スナップショットする
  resource_label text,

  granted_by     uuid references auth.users(id) on delete set null,
  granted_at     timestamptz not null default now(),

  unique (guest_id, resource_type, resource_key)
);

create index if not exists idx_gw_guest_grants_guest
  on public.gw_guest_grants(guest_id);

-- -----------------------------------------------------------------------------
-- 4) ヘルパ関数
-- -----------------------------------------------------------------------------

-- 自分（ログイン中）が、そのテナントのどの gw_guests 行か。無効化されていれば null
create or replace function public.gw_guest_id(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.gw_guests
   where tenant_id = p_tenant and user_id = auth.uid()
     and disabled_at is null
   limit 1
$$;

-- 自分が、その種類・その対象への許可を持っているか
create or replace function public.gw_guest_granted(p_tenant uuid, p_type text, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.gw_guest_grants g
     where g.tenant_id = p_tenant
       and g.guest_id = public.gw_guest_id(p_tenant)
       and g.resource_type = p_type
       and g.resource_key = p_key
  )
$$;

-- -----------------------------------------------------------------------------
-- 5) RLS：gw_guests / gw_guest_invites / gw_guest_grants
--
--    管理・作成・変更は社内スタッフだけ。ゲスト本人は、自分の行と自分の許可
--    だけ読める（バッジ・マイページ用）。招待（トークンのハッシュを含む）は
--    ゲスト本人にも見せない
-- -----------------------------------------------------------------------------
alter table public.gw_guests        enable row level security;
alter table public.gw_guest_invites enable row level security;
alter table public.gw_guest_grants  enable row level security;

drop policy if exists gw_guests_staff on public.gw_guests;
create policy gw_guests_staff on public.gw_guests
  for all
  using (public.is_tenant_staff(tenant_id))
  with check (public.is_tenant_staff(tenant_id));

drop policy if exists gw_guests_self on public.gw_guests;
create policy gw_guests_self on public.gw_guests
  for select
  using (user_id = auth.uid());

drop policy if exists gw_guest_invites_staff on public.gw_guest_invites;
create policy gw_guest_invites_staff on public.gw_guest_invites
  for all
  using (public.is_tenant_staff(tenant_id))
  with check (public.is_tenant_staff(tenant_id));

drop policy if exists gw_guest_grants_staff on public.gw_guest_grants;
create policy gw_guest_grants_staff on public.gw_guest_grants
  for all
  using (public.is_tenant_staff(tenant_id))
  with check (public.is_tenant_staff(tenant_id));

drop policy if exists gw_guest_grants_self on public.gw_guest_grants;
create policy gw_guest_grants_self on public.gw_guest_grants
  for select
  using (guest_id = public.gw_guest_id(tenant_id));

-- -----------------------------------------------------------------------------
-- 6) 既存テーブルへ、ゲスト用の閲覧ポリシーを追加する（既存ポリシーは触らない）
--
--    どれも「追加」であって、既存の社員向けポリシーは一切変えない。
--    ゲストは gw_employees の行を持たないので、既存のポリシーには
--    最初から1つも当たらない（これが deny-by-default の実体）。
--    ここで足すのは、許可された対象だけを通す小さな穴
-- -----------------------------------------------------------------------------

-- タスク：指定タスク・指定プロジェクト（category）
drop policy if exists gw_tasks_guest_select on public.gw_tasks;
create policy gw_tasks_guest_select on public.gw_tasks
  for select
  using (
    public.gw_guest_granted(tenant_id, 'task', id::text)
    or (category is not null and public.gw_guest_granted(tenant_id, 'project', category))
  );

-- チャット：指定チャット／グループ
drop policy if exists gw_threads_guest_select on public.gw_threads;
create policy gw_threads_guest_select on public.gw_threads
  for select
  using (public.gw_guest_granted(tenant_id, 'thread', id::text));

drop policy if exists gw_messages_guest_select on public.gw_messages;
create policy gw_messages_guest_select on public.gw_messages
  for select
  using (public.gw_guest_granted(tenant_id, 'thread', thread_id::text));

-- 資料：指定資料
drop policy if exists gw_library_guest_select on public.gw_library;
create policy gw_library_guest_select on public.gw_library
  for select
  using (public.gw_guest_granted(tenant_id, 'document', id::text));

notify pgrst, 'reload schema';

-- 確認:
--   select display_name, company_name, email, user_id is not null as registered
--     from public.gw_guests order by created_at desc;
--   select resource_type, resource_key, resource_label from public.gw_guest_grants
--    where guest_id = '（確認したいゲストのid）';
