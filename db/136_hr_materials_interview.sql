-- =============================================================================
-- 136: 採用HR「資料」マスタ + 面談への資料紐付け
--
-- 目的:
--   会社案内 / 採用資料 / 無限道場 / サービス / 地方創生 / AI・DX / その他を
--   HR内で一元管理し、面談ごとに選択して面談カードからすぐ開けるようにする。
--
-- 方針:
--   ・応募者固有の gw_hr_documents は使わない（資料は会社共通）。
--   ・URL または PDF のどちらか。PDFは既存 private bucket "hr" の
--     <tenant>/materials/<uuid>.pdf に保存する。
--   ・PDFの候補者向け外部共有は今回対象外。share_external=true は URL のみ許可。
--   ・削除ではなく is_active=false で無効化。面談との過去紐付けを壊さない。
--   ・カジュアル面談の既定資料は default_for_casual=true で複数指定できる。
--   ・RLS: 採用HRは読める。書き込みは API(service role) 経由だけ。
--
-- 前提:
--   db/081_hr_recruiting.sql（gw_is_recruiting / gw_hr_interviews）
--   storage bucket "hr"（db/093 で使用中）
-- =============================================================================

begin;

create table if not exists public.gw_hr_materials (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  name                text not null check (char_length(name) between 1 and 160),
  category            text not null check (category in ('company','recruiting','mugendojo','service','regional','ai_dx','other')),
  kind                text not null check (kind in ('url','file')),
  url                 text,
  storage_path        text,
  filename            text,
  mime_type           text,
  size_bytes          integer,
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
    (kind = 'url' and url is not null and storage_path is null and filename is null and mime_type is null and size_bytes is null)
    or
    (kind = 'file' and url is null and storage_path is not null and filename is not null and mime_type = 'application/pdf' and size_bytes is not null and size_bytes > 0)
  ),
  constraint gw_hr_materials_https_chk check (url is null or url ~ '^https://'),
  constraint gw_hr_materials_external_chk check (not share_external or kind = 'url')
);

comment on table public.gw_hr_materials is
  '採用HR共通資料。会社案内・採用資料・無限道場等。URL/PDF。PDFはprivate bucket hr、候補者外部共有はURLのみ。db/136';

create index if not exists idx_gw_hr_materials_tenant
  on public.gw_hr_materials(tenant_id, is_active, sort_order, created_at);
create index if not exists idx_gw_hr_materials_category
  on public.gw_hr_materials(tenant_id, category, is_active, sort_order);

create table if not exists public.gw_hr_interview_materials (
  interview_id  uuid not null references public.gw_hr_interviews(id) on delete cascade,
  material_id   uuid not null references public.gw_hr_materials(id) on delete restrict,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  sort_order    integer not null default 100,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (interview_id, material_id)
);

comment on table public.gw_hr_interview_materials is
  '面談で使うHR共通資料。面談削除時はリンクのみ削除、資料は無効化で残す。db/136';

create index if not exists idx_gw_hr_interview_materials_material
  on public.gw_hr_interview_materials(tenant_id, material_id, interview_id);

alter table public.gw_hr_materials enable row level security;
alter table public.gw_hr_interview_materials enable row level security;

drop policy if exists gw_hr_materials_read on public.gw_hr_materials;
create policy gw_hr_materials_read on public.gw_hr_materials
  for select using (public.gw_is_recruiting(tenant_id));

drop policy if exists gw_hr_interview_materials_read on public.gw_hr_interview_materials;
create policy gw_hr_interview_materials_read on public.gw_hr_interview_materials
  for select using (public.gw_is_recruiting(tenant_id));

notify pgrst, 'reload schema';
commit;
