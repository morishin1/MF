-- =============================================================================
-- 012_hr_files.sql — 入社・退職手続きの提出ファイル
--
-- 前提: 006_storage_policies.sql（safe_uuid）と 008_onboarding.sql が適用済み。
--
-- なぜ documents テーブルを使わないか
--   documents は会計の証憑用で、同じ取引先のメンバーなら誰でも読める。
--   マイナンバー確認書類や年金手帳の控えを同じ場所に置くと、社員同士で
--   見えてしまう。保存先のバケットごと分けて、本人と人事だけに絞る。
--
-- 社労士は「共有マークの付いた項目」に紐づくファイルだけ見える。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) バケット（非公開・証憑とは別）
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('hr', 'hr', false)
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- 2) 提出ファイルの台帳
-- -----------------------------------------------------------------------------
create table if not exists public.gw_procedure_files (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  procedure_id  uuid not null references public.gw_procedures(id) on delete cascade,
  -- どのチェック項目に対する提出か。項目が消えてもファイルは残す
  item_id       uuid references public.gw_procedure_items(id) on delete set null,

  filename      text not null,
  mime_type     text not null,
  size_bytes    integer,
  storage_path  text not null,

  -- 人事フォルダ（GDRIVE_HR_FOLDER_ID の下）へのコピー
  drive_file_id text,
  drive_link    text,

  uploaded_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_gw_procedure_files_proc
  on public.gw_procedure_files(procedure_id);


-- -----------------------------------------------------------------------------
-- 3) RLS
--    書き込みポリシーは意図的に置かない。
--    保存先パスと item_id の整合をサーバ側で組み立てる必要があるため、
--    api/onboarding/upload.js（service_role）を唯一の書き込み口にする。
-- -----------------------------------------------------------------------------
alter table public.gw_procedure_files enable row level security;

drop policy if exists gw_procedure_files_select on public.gw_procedure_files;
create policy gw_procedure_files_select on public.gw_procedure_files
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or public.gw_procedure_is_mine(procedure_id)
    or (
      public.gw_is_advisor(tenant_id)
      and exists (
        select 1 from public.gw_procedure_items i
         where i.id = gw_procedure_files.item_id
           and i.share_with_advisor
      )
    )
  );


-- -----------------------------------------------------------------------------
-- 4) Storage のポリシー
--    パス規約: <tenant_id>/<procedure_id>/<file_id>.<ext>
--    safe_uuid を通すのは、UUID でないパスが1つでもあると
--    キャスト失敗でクエリ全体が落ちるため（006 と同じ理由）。
-- -----------------------------------------------------------------------------
drop policy if exists hr_files_rw on storage.objects;
create policy hr_files_rw on storage.objects
  for all
  using (
    bucket_id = 'hr'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_is_hr(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_procedure_is_mine(public.safe_uuid(split_part(name, '/', 2)))
    )
  )
  with check (
    bucket_id = 'hr'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_is_hr(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_procedure_is_mine(public.safe_uuid(split_part(name, '/', 2)))
    )
  );
