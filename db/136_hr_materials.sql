-- =============================================================================
-- 136: 採用HR「資料」マスタ + 面談ごとの資料紐付け
--      /hr/materials.html で URL / PDF を管理し、面談カードからすぐ開けるようにする
--
-- 既存の gw_hr_documents は応募者本人の書類（applicant_id NOT NULL）なので再利用しない。
-- PDF は既存 private bucket "hr" の <tenant>/materials/<uuid>.pdf に保存する。
-- URL は https:// のみ。候補者へ共有できるのは URL 資料かつ share_external=true のものだけ。
-- =============================================================================

begin;

create table if not exists public.gw_hr_materials (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  name                text not null check (char_length(name) between 1 and 160),
  category            text not null default 'other'
                      check (category in ('company','recruiting','mugendojo','service','regional','ai_dx','other')),
  kind                text not null check (kind in ('url','file')),
  url                 text,
  storage_path        text,
  filename            text,
  mime_type           text,
  size_bytes          integer check (size_bytes is null or size_bytes >= 0),
  description         text check (description is null or char_length(description) <= 1000),
  sort_order          integer not null default 100,
  is_active           boolean not null default true,
  share_external      boolean not null default false,
  default_for_casual  boolean not null default false,
  created_by          uuid references auth.users(id) on delete set null,
  updated_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint gw_hr_materials_source_chk check (
    (kind = 'url' and url is not null and url ~ '^https://[^[:space:]]+$'
      and storage_path is null and filename is null and mime_type is null)
    or
    (kind = 'file' and url is null and storage_path is not null and filename is not null
      and mime_type = 'application/pdf')
  ),
  constraint gw_hr_materials_external_chk check (not share_external or kind = 'url')
);

create index if not exists idx_gw_hr_materials_tenant
  on public.gw_hr_materials(tenant_id, is_active, sort_order, created_at);
create index if not exists idx_gw_hr_materials_casual
  on public.gw_hr_materials(tenant_id, default_for_casual, is_active)
  where default_for_casual = true;

create table if not exists public.gw_hr_interview_materials (
  interview_id uuid not null references public.gw_hr_interviews(id) on delete cascade,
  material_id  uuid not null references public.gw_hr_materials(id) on delete restrict,
  sort_order   integer not null default 100,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (interview_id, material_id)
);

create index if not exists idx_gw_hr_interview_materials_material
  on public.gw_hr_interview_materials(material_id, interview_id);

comment on table public.gw_hr_materials is
  '採用HRで共通利用する面談資料マスタ。URL/PDF。応募者本人の書類 gw_hr_documents とは別。db/136';
comment on table public.gw_hr_interview_materials is
  '面談ごとに選択した共通資料。面談削除時は紐付け削除、資料は無効化して履歴を残す。db/136';

alter table public.gw_hr_materials enable row level security;
alter table public.gw_hr_interview_materials enable row level security;

drop policy if exists gw_hr_materials_read on public.gw_hr_materials;
create policy gw_hr_materials_read on public.gw_hr_materials
  for select to authenticated
  using (public.gw_is_recruiting(tenant_id));

drop policy if exists gw_hr_interview_materials_read on public.gw_hr_interview_materials;
create policy gw_hr_interview_materials_read on public.gw_hr_interview_materials
  for select to authenticated
  using (
    exists (
      select 1 from public.gw_hr_interviews i
       where i.id = interview_id
         and public.gw_is_recruiting(i.tenant_id)
    )
  );

notify pgrst, 'reload schema';
commit;
