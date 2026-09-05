-- =============================================================================
-- 020_library.sql — 社内文書（マニュアル・社内規定・様式）
--
-- 前提: db/006_storage_policies.sql（safe_uuid）と db/005_groupware_core.sql。
--
-- gw_doc_templates（011）との違い
--   あちらは「管理部が差し込んで書き出す雛形」で、管理部しか見ない。
--   こちらは「社員が読むための文書」。就業規則、経費のルール、申請様式など。
--   読む人が違うので、同じ表には入れない。
--
-- 置き方は2通りを許す
--   ・ファイルを上げる（バケット library）
--   ・外部のリンクを登録する（Google ドライブやスプレッドシートをそのまま使う場合）
--   すでに Google 側で運用している文書を無理に移させないため。
-- =============================================================================

create table if not exists public.gw_library (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  title       text not null,
  category    text not null default 'other'
              check (category in ('rule','manual','form','other')),
  description text,

  -- バケット library の中のパス。外部リンクだけの登録なら空
  file_path   text,
  file_name   text,
  mime_type   text,
  size_bytes  integer,

  -- Google ドライブなど、外に置いてある文書へのリンク
  link_url    text,

  -- false にすると社員には出ない（作りかけを隠す用）
  published   boolean not null default true,
  sort_order  int not null default 0,

  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- ファイルもリンクも無い行は、開くものが無くて意味を成さない
  constraint gw_library_has_target check (file_path is not null or link_url is not null)
);

create index if not exists idx_gw_library_tenant
  on public.gw_library(tenant_id, category, sort_order);


-- -----------------------------------------------------------------------------
-- RLS: 社員は公開されているものを読める。登録・編集は管理部だけ
-- -----------------------------------------------------------------------------
alter table public.gw_library enable row level security;

drop policy if exists gw_library_select on public.gw_library;
create policy gw_library_select on public.gw_library
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or (published and public.gw_employee_id(tenant_id) is not null)
  );

drop policy if exists gw_library_write on public.gw_library;
create policy gw_library_write on public.gw_library
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- -----------------------------------------------------------------------------
-- ファイルの置き場
--   パス規約: <tenant_id>/<uuid>.<ext>
--   社員なら誰でも読める。書き込みは管理部だけ。
--   safe_uuid を通すのは、UUID でないパスが混じるとキャストで
--   クエリ全体が落ちるため（006 と同じ理由）。
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('library', 'library', false)
on conflict (id) do nothing;

drop policy if exists library_read on storage.objects;
create policy library_read on storage.objects
  for select
  using (
    bucket_id = 'library'
    and public.gw_employee_id(public.safe_uuid(split_part(name, '/', 1))) is not null
  );

drop policy if exists library_write on storage.objects;
create policy library_write on storage.objects
  for all
  using (
    bucket_id = 'library'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_is_hr(public.safe_uuid(split_part(name, '/', 1)))
    )
  )
  with check (
    bucket_id = 'library'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_is_hr(public.safe_uuid(split_part(name, '/', 1)))
    )
  );
