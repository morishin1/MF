-- =============================================================================
-- 053: 端末管理（グループウェアから登録する形）
--
-- 設計の全文は docs/device-management.md。ここには「なぜこの形か」だけ書く。
--
-- ■ PCに入れるソフトは作らない
--   常駐エージェントをやめたので、分かるのは
--   「どの端末から社内システムに入ったか」と「いつ・どれだけ開いていたか」だけ。
--   USB・インストールされたソフト・アプリ別の時間・PCの起動終了は、
--   ブラウザからは取れない。取れないものの置き場を作らない。
--
-- ■ 端末の見分けは、ブラウザが持つIDでやる
--   ログインした人のブラウザに device_uid を1つ置く。それが端末の印。
--   Cookie を消せば別の端末に見える。それでよい。
--   ここで防ぎたいのは「見慣れない端末から社内システムに入られること」で、
--   本人が自分の端末を隠すことではない。
--
-- ■ 本人が確認するまで、利用時間は数えない
--   gw_devices.notified_at が null のあいだ、日別の集計は書かない。
--   入ったこと自体（first_seen）は残す。これはログインの記録であって、
--   働き方の記録ではない。
--
-- ■ 管理者が見たことも残す
--   gw_device_views。片側だけが透明な仕組みにしない。
--   本人は「自分の記録を、いつ誰が見たか」を読める。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) 前の版（常駐エージェント前提）を入れてしまっていた場合の後始末
--
--    エージェントは作らなかったので、これらに行が入ることはない。
--    空のときだけ落とす。1行でも入っていたら残して、人が見てから決める
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['gw_device_app_usage', 'gw_device_web_usage', 'gw_device_enrollments']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('select 1 from public.%I limit 1', t);
      if not found then
        execute format('drop table public.%I', t);
        raise notice '使わなくなった % を落としました', t;
      else
        raise warning '% に行があるので残しました。中身を確認してから手で消してください', t;
      end if;
    end if;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 1) 端末台帳
-- -----------------------------------------------------------------------------
create table if not exists public.gw_devices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- ブラウザの localStorage に置くID。これが端末の印
  device_uid  text not null,

  employee_id uuid references public.gw_employees(id) on delete set null,

  -- 貸与品台帳のPCと紐づける。台帳と端末管理が別物になると、
  -- 「誰に貸したPCか」が2か所で食い違う
  asset_id    uuid references public.gw_assets(id) on delete set null,

  -- 本人が付けた名前。ブラウザはPCの名前を教えてくれないので、
  -- 既定は「Windows 11 の Chrome」のような組み立てたもの
  label       text not null,
  os          text,
  os_version  text,
  browser     text,
  model       text,
  screen      text,
  user_agent  text,

  status text not null default 'unconfirmed'
         check (status in ('unconfirmed', 'active', 'suspended', 'retired')),

  -- 本人が告知を読んだ時刻。null のあいだ利用時間は数えない
  notified_at  timestamptz,
  -- アプリとして入れた（PWA）時刻
  installed_at timestamptz,

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz,

  note        text,
  retired_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint gw_devices_uid unique (device_uid)
);

-- 前の版から入れ替えるとき用。作り直さずに列だけ足す
alter table public.gw_devices add column if not exists label        text;
alter table public.gw_devices add column if not exists os           text;
alter table public.gw_devices add column if not exists browser      text;
alter table public.gw_devices add column if not exists model        text;
alter table public.gw_devices add column if not exists screen       text;
alter table public.gw_devices add column if not exists user_agent   text;
alter table public.gw_devices add column if not exists installed_at timestamptz;
alter table public.gw_devices add column if not exists first_seen_at timestamptz not null default now();

do $$
begin
  -- 前の版は hostname だった。中身を label に移す
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'gw_devices'
                and column_name = 'hostname') then
    update public.gw_devices set label = coalesce(label, hostname) where label is null;
    alter table public.gw_devices alter column hostname drop not null;
  end if;
  -- 常駐エージェント用の列。もう使わない
  alter table public.gw_devices drop column if exists secret_hash;
  alter table public.gw_devices drop column if exists secret_set_at;
  alter table public.gw_devices drop column if exists agent_version;
  alter table public.gw_devices drop column if exists serial;
  alter table public.gw_devices drop column if exists enrolled_by;
  alter table public.gw_devices drop column if exists enrolled_at;

  update public.gw_devices set label = '名前のない端末' where label is null;
  alter table public.gw_devices alter column label set not null;
exception when undefined_table then null;
end $$;

-- status の許す値を、この版のものにそろえる
do $$
begin
  alter table public.gw_devices drop constraint if exists gw_devices_status_check;
  update public.gw_devices set status = 'unconfirmed' where status not in
    ('unconfirmed', 'active', 'suspended', 'retired');
  alter table public.gw_devices add constraint gw_devices_status_check
    check (status in ('unconfirmed', 'active', 'suspended', 'retired'));
exception when undefined_table then null;
end $$;

create index if not exists idx_gw_devices_tenant
  on public.gw_devices(tenant_id, status);
create index if not exists idx_gw_devices_employee
  on public.gw_devices(employee_id, last_seen_at desc);

comment on table public.gw_devices is
  '社内システムに入るのに使われている端末。'
  '常駐ソフトは入れていないので、分かるのは「どの端末から入ったか」まで';
comment on column public.gw_devices.device_uid is
  'ブラウザの localStorage に置くID。Cookieを消せば別の端末に見える。'
  '防ぎたいのは見慣れない端末からの利用で、本人が自分の端末を隠すことではない';
comment on column public.gw_devices.notified_at is
  '本人が告知を読んだ時刻。null のあいだ日別の利用時間は数えない';

-- -----------------------------------------------------------------------------
-- 2) 端末に起きたこと（追記のみ）
--
--    数は多くない。本人が「この端末に何があったか」を読むためのもの
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_events (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,

  work_date date not null,
  at        timestamptz not null default now(),

  kind text not null,
  detail jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

-- 前の版は常駐エージェント用の種類しか許していなかった。
-- seq（端末側の連番）も、もう来ない
do $$
begin
  alter table public.gw_device_events drop constraint if exists gw_device_events_kind_check;
  alter table public.gw_device_events drop constraint if exists gw_device_events_once;
  alter table public.gw_device_events alter column seq drop not null;
exception when undefined_table or undefined_column then null;
end $$;

alter table public.gw_device_events drop column if exists seq;

-- 落としてから足す。add constraint に if not exists は無い
alter table public.gw_device_events drop constraint if exists gw_device_events_kind_check;
alter table public.gw_device_events add constraint gw_device_events_kind_check
  check (kind in ('first_seen', 'confirmed', 'installed', 'renamed',
                  'suspended', 'resumed', 'retired', 'forgotten'))
  not valid;

create index if not exists idx_gw_device_events_device
  on public.gw_device_events(device_id, at desc);
create index if not exists idx_gw_device_events_tenant
  on public.gw_device_events(tenant_id, at desc);

-- -----------------------------------------------------------------------------
-- 3) 日別の利用時間
--
--    「社内システムを開いていた時間」であって、パソコンの稼働時間ではない。
--    画面の文言もそう書く。取り違えると、数字の意味が変わる
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_usage (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  device_id   uuid not null references public.gw_devices(id) on delete cascade,
  employee_id uuid references public.gw_employees(id) on delete set null,
  work_date   date not null,

  -- 開いていた時間の合計（分）。5分ごとの合図をつなぎ合わせて数える
  active_min  integer not null default 0,
  -- そのうち深夜・休日にあたるぶん
  night_min   integer not null default 0,
  holiday_min integer not null default 0,
  -- 合図が届いた回数。数字の粗さを確かめるために持つ
  beats       integer not null default 0,

  first_at    timestamptz,
  last_at     timestamptz,
  updated_at  timestamptz not null default now(),

  constraint gw_device_usage_day unique (device_id, work_date)
);

alter table public.gw_device_usage add column if not exists beats integer not null default 0;
-- 常駐エージェント用。ブラウザからは取れない
alter table public.gw_device_usage drop column if exists idle_min;
alter table public.gw_device_usage drop column if exists locked_min;

create index if not exists idx_gw_device_usage_tenant
  on public.gw_device_usage(tenant_id, work_date desc);
create index if not exists idx_gw_device_usage_employee
  on public.gw_device_usage(employee_id, work_date desc);

comment on table public.gw_device_usage is
  '社内システムを開いていた時間。パソコンの稼働時間ではない。'
  '5分ごとの合図をつなぎ合わせた、おおよその値';

-- -----------------------------------------------------------------------------
-- 4) アラート
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_alerts (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,

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
  -- 「深夜に使っていた」が1晩で10件出ると、どれも読まれなくなる
  dedupe_key text,
  constraint gw_device_alerts_dedupe unique (device_id, dedupe_key)
);

alter table public.gw_device_alerts drop column if exists event_id;

create index if not exists idx_gw_device_alerts_open
  on public.gw_device_alerts(tenant_id, status, occurred_at desc);

-- -----------------------------------------------------------------------------
-- 5) ポリシー（会社ごとに1行）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_policies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,

  night_from time not null default '22:00',
  night_to   time not null default '05:00',

  -- 見慣れない端末から入られたときに知らせるか
  unknown_alert boolean not null default true,
  night_alert   boolean not null default true,

  -- 何分から「深夜に使っていた」とするか
  night_min_minutes   integer not null default 60,
  holiday_min_minutes integer not null default 120,
  -- 何日使われていない端末を「使われていない」とするか
  stale_days integer not null default 60,

  keep_events_days  integer not null default 400,
  keep_daily_months integer not null default 13,

  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.gw_device_policies add column if not exists unknown_alert boolean not null default true;
alter table public.gw_device_policies add column if not exists night_min_minutes integer not null default 60;
alter table public.gw_device_policies add column if not exists holiday_min_minutes integer not null default 120;
alter table public.gw_device_policies add column if not exists stale_days integer not null default 60;
-- 常駐エージェント用。もう使わない
alter table public.gw_device_policies drop column if exists blocked_software;
alter table public.gw_device_policies drop column if exists site_categories;
alter table public.gw_device_policies drop column if exists idle_after_min;
alter table public.gw_device_policies drop column if exists usb_alert;
alter table public.gw_device_policies drop column if exists send_interval_sec;
alter table public.gw_device_policies drop constraint if exists gw_device_policies_arrays;

-- -----------------------------------------------------------------------------
-- 6) 管理者の閲覧履歴
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
-- 7) RLS
--
--    読むだけ許す。書き込みは api/devices/*（service_role）だけ。
--    本人は自分の端末ぶん、人事・経営者は全件
-- -----------------------------------------------------------------------------
alter table public.gw_devices         enable row level security;
alter table public.gw_device_events   enable row level security;
alter table public.gw_device_usage    enable row level security;
alter table public.gw_device_alerts   enable row level security;
alter table public.gw_device_policies enable row level security;
alter table public.gw_device_views    enable row level security;

drop policy if exists gw_devices_read on public.gw_devices;
create policy gw_devices_read on public.gw_devices
  for select to authenticated
  using (public.gw_is_hr(tenant_id)
         or employee_id = public.gw_employee_id(tenant_id));

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

-- 使わなくなった表のポリシーが残っていても害はないが、掃除しておく
drop policy if exists gw_device_app_read on public.gw_device_app_usage;
drop policy if exists gw_device_web_read on public.gw_device_web_usage;
drop policy if exists gw_device_enrollments_read on public.gw_device_enrollments;

notify pgrst, 'reload schema';

-- ちゃんと入ったか、その場で出す
select
  case when to_regclass('public.gw_devices') is null then '✗ 作れていません'
       else '✓ 端末台帳を作りました' end as 端末台帳,
  case when to_regclass('public.gw_device_usage') is null then '✗ 作れていません'
       else '✓ 日別の利用時間を作りました' end as 利用時間,
  case when to_regclass('public.gw_device_views') is null then '✗ 作れていません'
       else '✓ 閲覧履歴を作りました' end as 閲覧履歴,
  case when to_regclass('public.gw_device_app_usage') is null then '✓ 使わない表は残っていません'
       else '△ gw_device_app_usage が残っています' end as 後始末,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'gw_device%') as ポリシー数;

-- 確認:
--   -- まだ本人が確認していない端末（利用時間は数えていない）
--   select label, employee_id, first_seen_at from public.gw_devices where notified_at is null;
--
--   -- 誰が誰の記録を見たか
--   select v.at, v.viewer_name, e.display_name, v.scope
--     from public.gw_device_views v
--     left join public.gw_employees e on e.id = v.employee_id
--    order by v.at desc limit 50;
