-- =============================================================================
-- 053: 端末管理（EIGHT PC Agent）
--
-- 設計の全文は docs/device-management.md。ここには「なぜこの形か」だけ書く。
--
-- ■ 本人が承認するまで収集しない
--   gw_devices.notified_at が null のあいだ、サーバは collect:false を返し、
--   エージェントは何も送らない。就業規則への明記と本人への周知が
--   間に合っていない状態で入れても、データは溜まらない。
--   これは建前ではなく、仕組みでそうしてある。
--
-- ■ 監視ではなく端末管理
--   キー入力・パスワード・メール本文・チャット本文・画面・
--   ウィンドウのタイトル・URLの全文は、どこにも入れない。
--   URLは端末の中でホスト名→カテゴリに落としてから送るので、
--   この表にはカテゴリしか届かない。
--
-- ■ 管理者が見たことも残す
--   gw_device_views。片側だけが透明な仕組みにしない。
--   本人は「自分の記録を、いつ誰が見たか」を読める。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 端末台帳
-- -----------------------------------------------------------------------------
create table if not exists public.gw_devices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- 端末が初回インストール時に作り、レジストリに残すID。
  -- ホスト名は変わるが、これは変わらない
  device_uid  text not null,

  -- 貸与品台帳のPCと紐づける。台帳と端末管理が別物になると、
  -- 「誰に貸したPCか」が2か所で食い違う
  asset_id    uuid references public.gw_assets(id) on delete set null,
  employee_id uuid references public.gw_employees(id) on delete set null,

  hostname      text not null,
  os_version    text,
  serial        text,
  agent_version text,

  -- 端末シークレットの sha256。平文は保存しない
  secret_hash   text not null,
  secret_set_at timestamptz not null default now(),

  status text not null default 'active'
         check (status in ('active', 'suspended', 'retired')),

  -- 本人が告知を読んだ時刻。null のあいだは収集しない
  notified_at timestamptz,

  last_seen_at timestamptz,

  note        text,
  enrolled_by uuid references auth.users(id) on delete set null,
  enrolled_at timestamptz not null default now(),
  retired_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint gw_devices_uid unique (device_uid)
);

create index if not exists idx_gw_devices_tenant
  on public.gw_devices(tenant_id, status);
create index if not exists idx_gw_devices_employee
  on public.gw_devices(employee_id);

comment on table public.gw_devices is
  '会社が貸与したPC。業務利用状況の可視化と情報漏えい防止のための台帳';
comment on column public.gw_devices.notified_at is
  '本人が告知を読んだ時刻。null のあいだエージェントは何も送らない。'
  '就業規則への明記と周知が済むまで、データが溜まらないようにするための仕組み';
comment on column public.gw_devices.secret_hash is
  '端末シークレットの sha256。平文は持たない（漏れても端末になりすませない）';

-- -----------------------------------------------------------------------------
-- 2) 登録トークン（1回だけ使える）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_enrollments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  token_hash  text not null,
  employee_id uuid references public.gw_employees(id) on delete set null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid references public.gw_devices(id) on delete set null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint gw_device_enrollments_token unique (token_hash)
);

create index if not exists idx_gw_device_enrollments_open
  on public.gw_device_enrollments(tenant_id, expires_at)
  where used_at is null;

comment on column public.gw_device_enrollments.token_hash is
  '登録トークンの sha256。平文は発行のときに1度だけ画面に出す';

-- -----------------------------------------------------------------------------
-- 3) イベント（点の記録・追記のみ）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_events (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,

  work_date date not null,
  at        timestamptz not null,

  kind text not null check (kind in (
    'boot','shutdown','logon','logoff','lock','unlock','sleep','wake',
    'usb_attach','usb_detach','app_install','app_uninstall',
    'agent_start','agent_update','agent_error')),

  -- 種類ごとの中身。USBならベンダ/製品ID、ソフトなら名前とバージョン。
  -- 個人が特定できるもの（ファイル名・URL・ウィンドウのタイトル）は入れない
  detail jsonb not null default '{}'::jsonb,

  -- 端末側の連番。同じものを2回受けても1行にする
  seq bigint not null,

  created_at timestamptz not null default now(),
  constraint gw_device_events_once unique (device_id, seq)
);

create index if not exists idx_gw_device_events_tenant
  on public.gw_device_events(tenant_id, work_date desc);
create index if not exists idx_gw_device_events_device
  on public.gw_device_events(device_id, work_date desc, at desc);

-- -----------------------------------------------------------------------------
-- 4) 日別の集計
--
--    生の秒単位は端末の中で捨てる。ここに来るのは日別の合計だけ。
--    「いつ何をしていたか」を分単位で持たないのは、それが監視になるから
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_usage (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  device_id   uuid not null references public.gw_devices(id) on delete cascade,
  employee_id uuid references public.gw_employees(id) on delete set null,
  work_date   date not null,

  active_min  integer not null default 0,
  idle_min    integer not null default 0,
  locked_min  integer not null default 0,
  night_min   integer not null default 0,
  holiday_min integer not null default 0,

  first_at    timestamptz,
  last_at     timestamptz,
  updated_at  timestamptz not null default now(),

  constraint gw_device_usage_day unique (device_id, work_date)
);

create index if not exists idx_gw_device_usage_tenant
  on public.gw_device_usage(tenant_id, work_date desc);

create table if not exists public.gw_device_app_usage (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,
  work_date date not null,
  exe_name  text not null,
  product   text,
  minutes   integer not null default 0,

  constraint gw_device_app_day unique (device_id, work_date, exe_name)
);

create index if not exists idx_gw_device_app_tenant
  on public.gw_device_app_usage(tenant_id, work_date desc);

-- サイトはカテゴリだけ。ホスト名もURLも保存しない
create table if not exists public.gw_device_web_usage (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,
  work_date date not null,
  category  text not null check (category in
            ('work','research','sns','video','shopping','other')),
  minutes   integer not null default 0,

  constraint gw_device_web_day unique (device_id, work_date, category)
);

comment on table public.gw_device_web_usage is
  'サイトの利用時間。カテゴリ単位でしか持たない。'
  'URLもホスト名も、端末の中で落としてから送るのでここには届かない';

-- -----------------------------------------------------------------------------
-- 5) アラート
--
--    イベントは消せない記録。アラートは人が対応するもの。
--    状態を持たせる必要があるので、分ける
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_alerts (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,
  event_id  uuid references public.gw_device_events(id) on delete set null,

  severity text not null check (severity in ('info','warn','critical')),
  rule     text not null,
  title    text not null,
  detail   jsonb not null default '{}'::jsonb,

  status       text not null default 'open'
               check (status in ('open','ack','resolved','ignored')),
  decided_by   uuid references auth.users(id) on delete set null,
  decided_at   timestamptz,
  decided_note text,

  occurred_at timestamptz not null,
  created_at  timestamptz not null default now(),

  -- 同じ端末の同じ理由で、同じ日に何度も作らない。
  -- 「深夜に働いた」が1晩で10件出ると、どれも読まれなくなる
  dedupe_key text,
  constraint gw_device_alerts_dedupe unique (device_id, dedupe_key)
);

create index if not exists idx_gw_device_alerts_open
  on public.gw_device_alerts(tenant_id, status, occurred_at desc);

-- -----------------------------------------------------------------------------
-- 6) ポリシー（会社ごとに1行）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_policies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,

  blocked_software jsonb not null default '[]'::jsonb,
  site_categories  jsonb not null default '{}'::jsonb,

  night_from time not null default '22:00',
  night_to   time not null default '05:00',
  idle_after_min integer not null default 5,

  usb_alert   boolean not null default true,
  night_alert boolean not null default true,

  send_interval_sec integer not null default 300,
  keep_events_days  integer not null default 90,
  keep_daily_months integer not null default 13,

  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),

  constraint gw_device_policies_arrays check (
    jsonb_typeof(blocked_software) = 'array'
    and jsonb_typeof(site_categories) = 'object')
);

-- -----------------------------------------------------------------------------
-- 7) 管理者の閲覧履歴
--
--    これが無いと、この機能は片側だけが透明な仕組みになる。
--    本人は「自分の記録を、いつ誰が見たか」を読める
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_views (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  viewer_id   uuid not null references auth.users(id) on delete cascade,
  viewer_name text,
  device_id   uuid references public.gw_devices(id) on delete set null,
  employee_id uuid references public.gw_employees(id) on delete set null,
  scope       text not null,
  work_date   date,
  at          timestamptz not null default now()
);

create index if not exists idx_gw_device_views_tenant
  on public.gw_device_views(tenant_id, at desc);
create index if not exists idx_gw_device_views_employee
  on public.gw_device_views(employee_id, at desc);

comment on table public.gw_device_views is
  '管理者が誰の端末の記録を見たか。本人も読める。'
  '見る側の記録が残らない仕組みは、監視になる';

-- -----------------------------------------------------------------------------
-- 8) RLS
--
--    読むだけ許す。書き込みは api/devices/*（service_role）だけ。
--    本人は自分の端末ぶん、人事・経営者は全件
-- -----------------------------------------------------------------------------
alter table public.gw_devices          enable row level security;
alter table public.gw_device_events    enable row level security;
alter table public.gw_device_usage     enable row level security;
alter table public.gw_device_app_usage enable row level security;
alter table public.gw_device_web_usage enable row level security;
alter table public.gw_device_alerts    enable row level security;
alter table public.gw_device_views     enable row level security;
alter table public.gw_device_policies  enable row level security;
alter table public.gw_device_enrollments enable row level security;

drop policy if exists gw_devices_read on public.gw_devices;
create policy gw_devices_read on public.gw_devices
  for select to authenticated
  using (public.gw_is_hr(tenant_id)
         or employee_id = public.gw_employee_id(tenant_id));

-- 端末に紐づく記録は、その端末を読める人が読める
drop policy if exists gw_device_events_read on public.gw_device_events;
create policy gw_device_events_read on public.gw_device_events
  for select to authenticated
  using (exists (select 1 from public.gw_devices d
                  where d.id = device_id
                    and (public.gw_is_hr(d.tenant_id)
                         or d.employee_id = public.gw_employee_id(d.tenant_id))));

drop policy if exists gw_device_usage_read on public.gw_device_usage;
create policy gw_device_usage_read on public.gw_device_usage
  for select to authenticated
  using (exists (select 1 from public.gw_devices d
                  where d.id = device_id
                    and (public.gw_is_hr(d.tenant_id)
                         or d.employee_id = public.gw_employee_id(d.tenant_id))));

drop policy if exists gw_device_app_read on public.gw_device_app_usage;
create policy gw_device_app_read on public.gw_device_app_usage
  for select to authenticated
  using (exists (select 1 from public.gw_devices d
                  where d.id = device_id
                    and (public.gw_is_hr(d.tenant_id)
                         or d.employee_id = public.gw_employee_id(d.tenant_id))));

drop policy if exists gw_device_web_read on public.gw_device_web_usage;
create policy gw_device_web_read on public.gw_device_web_usage
  for select to authenticated
  using (exists (select 1 from public.gw_devices d
                  where d.id = device_id
                    and (public.gw_is_hr(d.tenant_id)
                         or d.employee_id = public.gw_employee_id(d.tenant_id))));

drop policy if exists gw_device_alerts_read on public.gw_device_alerts;
create policy gw_device_alerts_read on public.gw_device_alerts
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

-- 閲覧履歴は、本人と人事が読める。
-- 「誰が自分を見たか」を本人が知れることに意味がある
drop policy if exists gw_device_views_read on public.gw_device_views;
create policy gw_device_views_read on public.gw_device_views
  for select to authenticated
  using (public.gw_is_hr(tenant_id)
         or employee_id = public.gw_employee_id(tenant_id));

drop policy if exists gw_device_policies_read on public.gw_device_policies;
create policy gw_device_policies_read on public.gw_device_policies
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

-- 登録トークンは人事だけ。平文は入っていないが、存在自体を配らない
drop policy if exists gw_device_enrollments_read on public.gw_device_enrollments;
create policy gw_device_enrollments_read on public.gw_device_enrollments
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

notify pgrst, 'reload schema';

-- ちゃんと入ったか、その場で出す
select
  case when to_regclass('public.gw_devices') is null then '✗ 作れていません'
       else '✓ gw_devices を作りました' end as 端末台帳,
  case when to_regclass('public.gw_device_usage') is null then '✗ 作れていません'
       else '✓ 日別の集計を作りました' end as 集計,
  case when to_regclass('public.gw_device_views') is null then '✗ 作れていません'
       else '✓ 閲覧履歴を作りました' end as 閲覧履歴,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'gw_device%') as ポリシー数;

-- 確認:
--   -- 本人が承認していない端末（収集していない）
--   select hostname, enrolled_at from public.gw_devices where notified_at is null;
--
--   -- 誰が誰の記録を見たか
--   select v.at, v.viewer_name, e.display_name, v.scope
--     from public.gw_device_views v
--     left join public.gw_employees e on e.id = v.employee_id
--    order by v.at desc limit 50;
