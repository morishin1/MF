-- =============================================================================
-- 021_web_analytics.sql — 自社Webサイトのアクセス統合
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 表の名前について
--   仕様書では vercel_projects / analytics_daily という名前だったが、
--   この Supabase は LMS・事務ポータル・ENGER と共用している。
--   analytics_daily のような一般的な名前は将来ぶつかる可能性が高いので、
--   このリポジトリの決まりどおり gw_ を付けた（CLAUDE.md）。
--
-- 誰が見られるか
--   数字は経営情報なので、管理者と経営者だけ。人事権限では見せない。
--
-- データの出どころ
--   1) 自前の計測タグ（js/beacon.js → /api/collect）… 必ず取れる
--   2) 外部の集計（Vercel など）… 取れるサイトだけ
--   どちらで入れた行かを source 列に残し、混ざっても後から切り分けられるようにする。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 対象サイト
-- -----------------------------------------------------------------------------
create table if not exists public.gw_web_projects (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  -- Vercel のプロジェクトID。手で足したサイトでは空
  provider_id   text,
  provider      text not null default 'vercel' check (provider in ('vercel','manual')),

  -- 一覧に出す名前（"ENGER" など）。Vercel のプロジェクト名とは分けて持つ
  name          text not null,
  project_name  text,
  domain        text,

  -- 計測タグを貼るときの合鍵。/api/collect はこの値で受け口を判別する
  beacon_key    text unique,

  enabled       boolean not null default true,
  sort_order    int not null default 0,

  -- 直近の取り込み結果。取れていないサイトを画面で見分けるために残す
  last_synced_at timestamptz,
  sync_source    text,
  sync_error     text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (tenant_id, provider, provider_id)
);

create index if not exists idx_gw_web_projects_tenant
  on public.gw_web_projects(tenant_id, enabled, sort_order);
create index if not exists idx_gw_web_projects_beacon
  on public.gw_web_projects(beacon_key) where beacon_key is not null;


-- -----------------------------------------------------------------------------
-- 2) 日別の数字
--    同じ日を何度取り込んでも増えないよう、(project, date, source) で一意にして
--    上書きする。時間ごとに回すので、追記だと1日で24倍になる。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_web_daily (
  project_id uuid not null references public.gw_web_projects(id) on delete cascade,
  date       date not null,
  source     text not null default 'beacon' check (source in ('beacon','vercel')),

  pageviews  int not null default 0,
  visitors   int not null default 0,

  updated_at timestamptz not null default now(),
  primary key (project_id, date, source)
);

create index if not exists idx_gw_web_daily_date
  on public.gw_web_daily(date desc);


-- -----------------------------------------------------------------------------
-- 3) 流入元と人気ページ
--    上位だけ持てば足りるので、取り込み側で件数を絞ってから入れる。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_web_referrers (
  project_id uuid not null references public.gw_web_projects(id) on delete cascade,
  date       date not null,
  source     text not null default 'beacon' check (source in ('beacon','vercel')),
  -- "google" "direct" "x.com" など。ホスト名まで
  referrer   text not null,
  pageviews  int not null default 0,
  primary key (project_id, date, source, referrer)
);

create table if not exists public.gw_web_pages (
  project_id uuid not null references public.gw_web_projects(id) on delete cascade,
  date       date not null,
  source     text not null default 'beacon' check (source in ('beacon','vercel')),
  path       text not null,
  pageviews  int not null default 0,
  primary key (project_id, date, source, path)
);

create index if not exists idx_gw_web_referrers_date on public.gw_web_referrers(date desc);
create index if not exists idx_gw_web_pages_date on public.gw_web_pages(date desc);


-- -----------------------------------------------------------------------------
-- 4) RLS
--    アクセス数は経営情報。管理者と経営者だけに見せる。
--    書き込みは取り込み処理（service_role）だけなので、書き込みポリシーは置かない。
-- -----------------------------------------------------------------------------
alter table public.gw_web_projects  enable row level security;
alter table public.gw_web_daily     enable row level security;
alter table public.gw_web_referrers enable row level security;
alter table public.gw_web_pages     enable row level security;

create or replace function public.gw_can_see_analytics(p_tenant uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_tenant_staff(p_tenant) or public.gw_has_role(p_tenant, 'owner');
$$;

drop policy if exists gw_web_projects_select on public.gw_web_projects;
create policy gw_web_projects_select on public.gw_web_projects
  for select using (public.gw_can_see_analytics(tenant_id));

-- 明細3表は project_id 経由で判定する。テナント列を持たせると
-- 取り込みのたびに整合を気にすることになるため、親を1回引くほうを選んだ
drop policy if exists gw_web_daily_select on public.gw_web_daily;
create policy gw_web_daily_select on public.gw_web_daily
  for select using (exists (
    select 1 from public.gw_web_projects p
     where p.id = gw_web_daily.project_id
       and public.gw_can_see_analytics(p.tenant_id)));

drop policy if exists gw_web_referrers_select on public.gw_web_referrers;
create policy gw_web_referrers_select on public.gw_web_referrers
  for select using (exists (
    select 1 from public.gw_web_projects p
     where p.id = gw_web_referrers.project_id
       and public.gw_can_see_analytics(p.tenant_id)));

drop policy if exists gw_web_pages_select on public.gw_web_pages;
create policy gw_web_pages_select on public.gw_web_pages
  for select using (exists (
    select 1 from public.gw_web_projects p
     where p.id = gw_web_pages.project_id
       and public.gw_can_see_analytics(p.tenant_id)));


-- -----------------------------------------------------------------------------
-- 5) 口コミサイトのブロック（8grp.co.jp 用）
--    判定と記録は 8grp-site 側（Apache と PHP）が行う。この Supabase には
--    台帳と記録だけが入る。ここでは、その2表がまだ無ければ作っておく
--    （8grp-site の scripts/referrer-block/schema.sql と同じ内容）。
--    こちらの管理画面からも件数を見られるようにするため。
-- -----------------------------------------------------------------------------
create table if not exists public.blocked_referrers (
  id           uuid primary key default gen_random_uuid(),
  domain       text not null unique,
  service_name text not null,
  enabled      boolean not null default true,
  note         text,
  created_at   timestamptz not null default now()
);

create table if not exists public.blocked_access_logs (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  referer    text,
  domain     text,
  path       text,
  user_agent text
);

create index if not exists idx_blocked_access_logs_time
  on public.blocked_access_logs(created_at desc);
create index if not exists idx_blocked_access_logs_domain
  on public.blocked_access_logs(domain, created_at desc);

alter table public.blocked_referrers   enable row level security;
alter table public.blocked_access_logs enable row level security;

drop policy if exists blocked_referrers_rw on public.blocked_referrers;
create policy blocked_referrers_rw on public.blocked_referrers
  for all to authenticated using (true) with check (true);

drop policy if exists blocked_access_logs_select on public.blocked_access_logs;
create policy blocked_access_logs_select on public.blocked_access_logs
  for select to authenticated using (true);

insert into public.blocked_referrers (domain, service_name) values
  ('openwork.jp',    'OpenWork'),
  ('jobtalk.jp',     '転職会議'),
  ('en-hyouban.com', 'エンゲージ 会社の評判')
on conflict (domain) do nothing;
