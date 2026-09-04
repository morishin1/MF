-- =============================================================================
-- 015_spaces_bookings.sql — スペース（設備）と、その予約申請
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 空き状況は社員全員が見えないと予約の意味が無いので、
--      予約の参照は「同じ会社の社員なら誰でも」にする。
--   3. 承認・却下は管理者と人事だけ。申請者自身の取り消しは API 側で行う。
--      （RLS は列単位の制限が書けないため、本人に UPDATE を許すと
--        自分の申請を approved に書き換えられてしまう）
--   4. 同じスペースの時間の重なりは、アプリではなく DB の制約で止める。
--      同時申請の競合はアプリ側のチェックでは防ぎきれないため。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) スペースのマスタ
-- -----------------------------------------------------------------------------
create table if not exists public.gw_spaces (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  -- 「NO.01」のような掲示用の番号。並び順と表示に使う
  code          text not null,
  name          text not null,
  capacity      int,
  note          text,

  -- 予約先の Google カレンダー。空なら GCAL_CALENDAR_ID を使う。
  -- スペースごとにカレンダーを分けたい場合だけ入れる。
  calendar_id   text,

  -- false にすると新規申請を受け付けない（一覧には残る）
  active        boolean not null default true,
  -- true なら承認待ちを挟む。false なら申請と同時に確定
  needs_approval boolean not null default true,

  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (tenant_id, code)
);

create index if not exists idx_gw_spaces_tenant
  on public.gw_spaces(tenant_id, active, sort_order);


-- -----------------------------------------------------------------------------
-- 2) 予約申請
-- -----------------------------------------------------------------------------
create table if not exists public.gw_bookings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  space_id       uuid not null references public.gw_spaces(id) on delete cascade,
  employee_id    uuid not null references public.gw_employees(id) on delete cascade,

  title          text not null,
  note           text,
  headcount      int,

  starts_at      timestamptz not null,
  ends_at        timestamptz not null,

  status         text not null default 'pending'
                 check (status in ('pending','approved','rejected','cancelled')),

  decided_by     uuid references public.gw_employees(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text,

  -- Google カレンダー側の控え。連携に失敗しても予約自体は成立させ、
  -- 何が起きたかを gcal_error に残して管理画面で気づけるようにする
  gcal_calendar_id text,
  gcal_event_id    text,
  gcal_link        text,
  gcal_error       text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint gw_bookings_time_order check (ends_at > starts_at)
);

create index if not exists idx_gw_bookings_tenant_time
  on public.gw_bookings(tenant_id, starts_at desc);
create index if not exists idx_gw_bookings_space_time
  on public.gw_bookings(space_id, starts_at);
create index if not exists idx_gw_bookings_employee
  on public.gw_bookings(employee_id, starts_at desc);
create index if not exists idx_gw_bookings_status
  on public.gw_bookings(tenant_id, status);


-- -----------------------------------------------------------------------------
-- 3) 二重予約の防止
--    申請中・承認済みの間で、同じスペースの時間が重なる行を作れなくする。
--    btree_gist が使えない環境ではスキップし、アプリ側のチェックだけで動かす。
-- -----------------------------------------------------------------------------
do $$
begin
  create extension if not exists btree_gist;

  if not exists (
    select 1 from pg_constraint where conname = 'gw_bookings_no_overlap'
  ) then
    alter table public.gw_bookings
      add constraint gw_bookings_no_overlap
      exclude using gist (
        space_id with =,
        tstzrange(starts_at, ends_at) with &&
      ) where (status in ('pending','approved'));
  end if;
exception when others then
  raise notice 'gw_bookings_no_overlap を作成できませんでした: %', sqlerrm;
end $$;


-- -----------------------------------------------------------------------------
-- 4) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_spaces   enable row level security;
alter table public.gw_bookings enable row level security;

-- スペース一覧: 同じ会社の社員なら誰でも読める
drop policy if exists gw_spaces_select on public.gw_spaces;
create policy gw_spaces_select on public.gw_spaces
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_employee_id(tenant_id) is not null
  );

-- マスタの編集は管理者・人事だけ
drop policy if exists gw_spaces_write on public.gw_spaces;
create policy gw_spaces_write on public.gw_spaces
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 予約の参照: 空き状況が分からないと予約できないので、社員全員に見せる
drop policy if exists gw_bookings_select on public.gw_bookings;
create policy gw_bookings_select on public.gw_bookings
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_employee_id(tenant_id) is not null
  );

-- 申請は本人名義でのみ作れる。誰かの名前で勝手に押さえられないようにする
drop policy if exists gw_bookings_insert on public.gw_bookings;
create policy gw_bookings_insert on public.gw_bookings
  for insert
  with check (
    employee_id = public.gw_employee_id(tenant_id)
    and status = 'pending'
  );

-- 承認・却下・変更は管理者と人事だけ。
-- 申請者自身の取り消しは /api/bookings/cancel（service_role）が行う
drop policy if exists gw_bookings_update on public.gw_bookings;
create policy gw_bookings_update on public.gw_bookings
  for update
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

drop policy if exists gw_bookings_delete on public.gw_bookings;
create policy gw_bookings_delete on public.gw_bookings
  for delete
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- -----------------------------------------------------------------------------
-- 5) 通知の種別に 'booking' を足す
--    013 の CHECK に無いままだと、予約の通知を入れた時点で失敗する。
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_notifications') is not null then
    alter table public.gw_notifications
      drop constraint if exists gw_notifications_kind_check;
    alter table public.gw_notifications
      add constraint gw_notifications_kind_check
      check (kind in ('general','task_overdue','task_assigned','notice','message','booking'));
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 6) スペースの初期データ
--    8sp.co.jp の掲示に合わせた並び。NO.04 は掲示に無いため入れていない。
--    増減は管理画面（スケジュール・設備予約）から行う。
--    既にグループウェアを使っている会社（社員名簿に行がある）にだけ入れる。
-- -----------------------------------------------------------------------------
insert into public.gw_spaces (tenant_id, code, name, sort_order)
select t.id, v.code, v.name, v.sort
from public.tenants t
cross join (values
  ('NO.01', 'カフェスペース',   1),
  ('NO.02', 'スタジオスペース', 2),
  ('NO.03', 'ワークスペース',   3),
  ('NO.05', 'BOXスペース',      5),
  ('NO.06', '個室スペース',     6),
  ('NO.07', '会議スペース',     7)
) as v(code, name, sort)
where exists (select 1 from public.gw_employees e where e.tenant_id = t.id)
on conflict (tenant_id, code) do nothing;
