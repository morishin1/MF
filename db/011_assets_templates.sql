-- =============================================================================
-- 011_assets_templates.sql — 貸与品・アカウント台帳と、書類の雛形
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 台帳は人事情報に近いので、既定は「管理者・人事」だけ。
--      ただし自分に貸与されているものは本人にも見せる（返却漏れを防ぐため）。
--   3. 雛形は社内文書なので、管理者・人事のみ。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 貸与品・アカウント
-- -----------------------------------------------------------------------------
create table if not exists public.gw_assets (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  kind        text not null default 'other'
              check (kind in ('pc','phone','account','key','other')),
  -- 「MacBook Air M2」「Slack」「オフィス鍵」など
  name        text not null,
  -- 製造番号・アカウント名など、個体を特定するもの
  identifier  text,

  assigned_to uuid references public.gw_employees(id) on delete set null,
  assigned_on date,
  returned_on date,

  status      text not null default 'in_stock'
              check (status in ('in_stock','assigned','returned','disposed')),

  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_assets_tenant
  on public.gw_assets(tenant_id, status);
create index if not exists idx_gw_assets_assignee
  on public.gw_assets(assigned_to);


-- -----------------------------------------------------------------------------
-- 2) 書類の雛形
--    body の中の {{氏名}} などを、対象者の情報で差し込んで使う。
--    差し込みは画面側で行う（DBには雛形そのものだけを持つ）。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_doc_templates (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,

  name             text not null,
  kind             text not null default 'general'
                   check (kind in ('onboarding','offboarding','general')),
  -- 対象の雇用区分。空配列なら全区分が対象
  employment_types text[] not null default '{}',

  body             text not null,
  note             text,

  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_gw_doc_templates_tenant
  on public.gw_doc_templates(tenant_id, kind);


-- -----------------------------------------------------------------------------
-- 3) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_assets        enable row level security;
alter table public.gw_doc_templates enable row level security;

-- 台帳の参照: 管理者・人事は全件。本人は自分に貸与されているものだけ
drop policy if exists gw_assets_select on public.gw_assets;
create policy gw_assets_select on public.gw_assets
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or assigned_to = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_assets_write on public.gw_assets;
create policy gw_assets_write on public.gw_assets
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 雛形: 管理者・人事のみ
drop policy if exists gw_doc_templates_select on public.gw_doc_templates;
create policy gw_doc_templates_select on public.gw_doc_templates
  for select
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

drop policy if exists gw_doc_templates_write on public.gw_doc_templates;
create policy gw_doc_templates_write on public.gw_doc_templates
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));
