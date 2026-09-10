-- =============================================================================
-- 054: 端末管理（常駐エージェント）
--
-- 053 の続き。**先に 053 を流してから、これを流す。**
-- 設計の全文は docs/device-management.md。ここには「なぜこの形か」だけ書く。
--
-- ■ 台帳は1つ。載り方が2つある
--   053 の gw_devices に source を足して、
--     'browser' … ブラウザの localStorage が持つID。社内システムに入ると自動で載る
--     'agent'   … PCに入れた常駐ソフト。レジストリに残すIDで載る
--   同じPCで両方が載る。これは重複ではない。
--   「そのPCで何が動いているか」と「そのPCから誰が社内システムに入ったか」は別のこと。
--   linked_device_id でブラウザ側からエージェント側を指す。
--
-- ■ 社員のアカウントをPCに置かない
--   置くと、PCが盗まれた人が社員として全部できてしまう。
--   端末専用の資格情報（secret_hash）にして、できることは「自分のぶんを送る」だけ。
--   平文は保存しない。
--
-- ■ 本人が承認するまで収集しない
--   notified_at が null のあいだ、サーバは collect:false を返し、
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
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 台帳に、エージェント側の列を足す
-- -----------------------------------------------------------------------------
alter table public.gw_devices add column if not exists source text not null default 'browser';
alter table public.gw_devices add column if not exists hostname      text;
alter table public.gw_devices add column if not exists serial        text;
alter table public.gw_devices add column if not exists os_build      text;
alter table public.gw_devices add column if not exists agent_version text;

-- 端末シークレットの sha256。平文は保存しない
alter table public.gw_devices add column if not exists secret_hash   text;
alter table public.gw_devices add column if not exists secret_set_at timestamptz;

alter table public.gw_devices add column if not exists enrolled_by uuid references auth.users(id) on delete set null;
alter table public.gw_devices add column if not exists enrolled_at timestamptz;

-- ブラウザの行 → そのPCで動いているエージェントの行
alter table public.gw_devices add column if not exists linked_device_id uuid
  references public.gw_devices(id) on delete set null;

-- エージェントが既定のブラウザを開くときに渡す、1回きりの合言葉。
-- これで「このブラウザは、このPCの中にいる」を本人につないでもらう
alter table public.gw_devices add column if not exists link_code_hash text;
alter table public.gw_devices add column if not exists link_expires_at timestamptz;

do $$
begin
  alter table public.gw_devices drop constraint if exists gw_devices_source_check;
  update public.gw_devices set source = 'browser' where source is null or source not in ('browser', 'agent');
  alter table public.gw_devices add constraint gw_devices_source_check
    check (source in ('browser', 'agent'));
exception when undefined_table then null;
end $$;

create index if not exists idx_gw_devices_source
  on public.gw_devices(tenant_id, source, status);
create index if not exists idx_gw_devices_linked
  on public.gw_devices(linked_device_id) where linked_device_id is not null;
create unique index if not exists idx_gw_devices_link_code
  on public.gw_devices(link_code_hash) where link_code_hash is not null;

comment on column public.gw_devices.source is
  'browser=ブラウザの localStorage が持つID / agent=PCに入れた常駐ソフト。'
  '同じPCで両方載るのは重複ではない。見ているものが違う';
comment on column public.gw_devices.secret_hash is
  '端末シークレットの sha256。平文は持たない（漏れても端末になりすませない）。'
  'source=agent の行だけが持つ';
comment on column public.gw_devices.linked_device_id is
  'ブラウザの行から、そのPCで動いているエージェントの行を指す。'
  'エージェントが既定のブラウザを開いて、本人がつなぐ';

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
-- 3) できごとに、エージェント側の種類を足す
--
--    seq は端末側の連番。オフラインで溜めて後から送るので、
--    同じものが2回届く。一意制約で1行にする
-- -----------------------------------------------------------------------------
alter table public.gw_device_events add column if not exists seq bigint;

create unique index if not exists idx_gw_device_events_once
  on public.gw_device_events(device_id, seq) where seq is not null;

alter table public.gw_device_events drop constraint if exists gw_device_events_kind_check;
alter table public.gw_device_events add constraint gw_device_events_kind_check
  check (kind in (
    -- 053（ブラウザ側）
    'first_seen', 'confirmed', 'installed', 'renamed',
    'suspended', 'resumed', 'retired', 'forgotten', 'linked',
    -- 054（エージェント側）
    'boot', 'shutdown', 'logon', 'logoff', 'lock', 'unlock', 'sleep', 'wake',
    'usb_attach', 'usb_detach', 'app_install', 'app_uninstall',
    'agent_start', 'agent_update', 'agent_error'))
  not valid;

-- -----------------------------------------------------------------------------
-- 4) 日別の集計に、エージェントが測れるぶんを足す
--
--    エージェントの active_min は「PCが使われていた時間」。
--    ブラウザの active_min は「社内システムを開いていた時間」。
--    行が別（source が違う）なので混ざらない
-- -----------------------------------------------------------------------------
alter table public.gw_device_usage add column if not exists idle_min   integer not null default 0;
alter table public.gw_device_usage add column if not exists locked_min integer not null default 0;

-- アプリ別。1日 × 1アプリで 1440分を超えることはない
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

comment on table public.gw_device_app_usage is
  'アプリ別の利用時間。実行ファイル名だけで、パスは持たない（ユーザー名が入るため）';

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

create index if not exists idx_gw_device_web_tenant
  on public.gw_device_web_usage(tenant_id, work_date desc);

comment on table public.gw_device_web_usage is
  'サイトの利用時間。カテゴリ単位でしか持たない。'
  'URLもホスト名も、端末の中で落としてから送るのでここには届かない';

-- -----------------------------------------------------------------------------
-- 5) アラートに、元のできごとを指させる
-- -----------------------------------------------------------------------------
alter table public.gw_device_alerts add column if not exists event_id uuid
  references public.gw_device_events(id) on delete set null;

-- -----------------------------------------------------------------------------
-- 6) ポリシーに、エージェント側の設定を足す
-- -----------------------------------------------------------------------------
alter table public.gw_device_policies add column if not exists blocked_software jsonb not null default '[]'::jsonb;
alter table public.gw_device_policies add column if not exists site_categories  jsonb not null default '{}'::jsonb;
alter table public.gw_device_policies add column if not exists idle_after_min   integer not null default 5;
alter table public.gw_device_policies add column if not exists usb_alert        boolean not null default true;
alter table public.gw_device_policies add column if not exists send_interval_sec integer not null default 300;

do $$
begin
  alter table public.gw_device_policies drop constraint if exists gw_device_policies_arrays;
  alter table public.gw_device_policies add constraint gw_device_policies_arrays check (
    jsonb_typeof(blocked_software) = 'array'
    and jsonb_typeof(site_categories) = 'object');
exception when undefined_table then null;
end $$;

-- -----------------------------------------------------------------------------
-- 7) 配布物の版
--
--    自動更新は署名の検証を省けない。更新の口は、そのまま
--    「全PCで任意のコードを動かせる口」になる。
--    3つそろっていない版は配らない（api/devices/manifest.js がそう作ってある）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_releases (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  version    text not null,
  url        text not null,
  sha256     text not null,
  notes      text,
  published  boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint gw_device_releases_version unique (tenant_id, version)
);

create index if not exists idx_gw_device_releases_live
  on public.gw_device_releases(tenant_id, created_at desc) where published;

-- -----------------------------------------------------------------------------
-- 8) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_device_app_usage   enable row level security;
alter table public.gw_device_web_usage   enable row level security;
alter table public.gw_device_enrollments enable row level security;
alter table public.gw_device_releases    enable row level security;

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

-- 登録トークンは人事だけ。平文は入っていないが、存在自体を配らない
drop policy if exists gw_device_enrollments_read on public.gw_device_enrollments;
create policy gw_device_enrollments_read on public.gw_device_enrollments
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

drop policy if exists gw_device_releases_read on public.gw_device_releases;
create policy gw_device_releases_read on public.gw_device_releases
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

notify pgrst, 'reload schema';

-- ちゃんと入ったか、その場で出す
select
  case when exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'gw_devices'
                       and column_name = 'secret_hash')
       then '✓ エージェント用の列を足しました' else '✗ 足せていません' end as 台帳,
  case when to_regclass('public.gw_device_enrollments') is null then '✗ 作れていません'
       else '✓ 登録トークンを作りました' end as 登録,
  case when to_regclass('public.gw_device_app_usage') is null then '✗ 作れていません'
       else '✓ アプリ別・サイト別を作りました' end as 集計,
  case when to_regclass('public.gw_device_releases') is null then '✗ 作れていません'
       else '✓ 配布物の版を作りました' end as 配布,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'gw_device%') as ポリシー数;

-- 確認:
--   -- まだ本人が承認していないエージェント（収集していない）
--   select hostname, enrolled_at from public.gw_devices
--    where source = 'agent' and notified_at is null;
--
--   -- 同じPCの、エージェントとブラウザ
--   select a.hostname, b.label
--     from public.gw_devices a
--     join public.gw_devices b on b.linked_device_id = a.id
--    where a.source = 'agent';
