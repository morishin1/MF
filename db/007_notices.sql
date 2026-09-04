-- =============================================================================
-- 007_notices.sql — 社内お知らせ
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針（005 のヘッダに書いた原則をそのまま踏襲する）
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 基礎条件に user_tenant_ids() は使わない。
--      顧問先ロールのユーザーもテナントIDを持つため、社内情報が漏れる。
--      「そのテナントの社員名簿に載っていること」= gw_employee_id() で判定する。
--   3. 部署宛てのお知らせは API ではなく RLS で絞る。
--      anon key と JWT はブラウザにあるので、API 層の if は境界にならない。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) お知らせ本体
-- -----------------------------------------------------------------------------
create table if not exists public.gw_notices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  title       text not null,
  body        text not null,

  -- 表示上の色分けに使う。運用しながら増やす想定
  category    text not null default 'general'
              check (category in ('general','important','system','event')),

  -- 宛先。'all' = 全社 / 'department' = departments に挙げた部署のみ
  audience    text not null default 'all'
              check (audience in ('all','department')),
  departments text[] not null default '{}',

  pinned      boolean not null default false,

  -- 'draft' は本人と管理者にしか見えない。'published' で配信開始
  status      text not null default 'published'
              check (status in ('draft','published','archived')),

  publish_at  timestamptz not null default now(),
  expires_at  timestamptz,

  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_notices_tenant
  on public.gw_notices(tenant_id, status, publish_at desc);


-- -----------------------------------------------------------------------------
-- 2) 既読
--    誰が読んだかを管理者が確認できるようにする（要件: 既読状況）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_notice_reads (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  notice_id   uuid not null references public.gw_notices(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  read_at     timestamptz not null default now(),
  unique (notice_id, employee_id)
);

create index if not exists idx_gw_notice_reads_notice
  on public.gw_notice_reads(notice_id);


-- -----------------------------------------------------------------------------
-- 3) ヘルパ: 自分の部署名
--    RLS の中から呼ぶので SECURITY DEFINER。未登録なら null。
-- -----------------------------------------------------------------------------
create or replace function public.gw_my_department(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select department
    from public.gw_employees
   where tenant_id = p_tenant
     and user_id = auth.uid()
   limit 1
$$;

-- 自分にそのお知らせが配信されているか
create or replace function public.gw_notice_targets_me(
  p_tenant uuid, p_audience text, p_departments text[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
           when p_audience = 'all' then true
           else coalesce(public.gw_my_department(p_tenant), '') = any(coalesce(p_departments, '{}'))
         end
$$;


-- -----------------------------------------------------------------------------
-- 4) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_notices      enable row level security;
alter table public.gw_notice_reads enable row level security;

-- 参照: 管理者はすべて。社員は「自分宛て・公開中・期限内」のみ
drop policy if exists gw_notices_select on public.gw_notices;
create policy gw_notices_select on public.gw_notices
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or (
      public.gw_employee_id(tenant_id) is not null
      and status = 'published'
      and publish_at <= now()
      and (expires_at is null or expires_at > now())
      and public.gw_notice_targets_me(tenant_id, audience, departments)
    )
  );

-- 作成・編集・削除: 管理者(staff/admin) または 人事権限(hr/owner)
drop policy if exists gw_notices_write on public.gw_notices;
create policy gw_notices_write on public.gw_notices
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 既読の参照: 管理者は全員分（既読状況の集計）、社員は自分の分だけ
drop policy if exists gw_notice_reads_select on public.gw_notice_reads;
create policy gw_notice_reads_select on public.gw_notice_reads
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

-- 社員名簿に自分の行を読む権限を足す（追加のみ。既存ポリシーは変更しない）。
-- 005 の gw_employees_select は is_tenant_staff 限定なので、メンバー（顧問先ロール）は
-- 自分の氏名すら引けない。お知らせの既読を自分で付けるために必要になる。
drop policy if exists gw_employees_self_select on public.gw_employees;
create policy gw_employees_self_select on public.gw_employees
  for select using (user_id = auth.uid());

-- 既読を付けられるのは自分の分だけ。他人の既読は作れない
drop policy if exists gw_notice_reads_insert on public.gw_notice_reads;
create policy gw_notice_reads_insert on public.gw_notice_reads
  for insert
  with check (employee_id = public.gw_employee_id(tenant_id));
