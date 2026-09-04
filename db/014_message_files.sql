-- =============================================================================
-- 014_message_files.sql — メッセージの添付ファイル
--
-- 前提: 006_storage_policies.sql（safe_uuid）と 010_messages.sql が適用済み。
--
-- 方針
--   バケットは会計の証憑（documents）とも人事書類（hr）とも分ける。
--   やりとりの添付は「そのスレッドの参加者だけ」が見られればよく、
--   他の2つとは見せる相手がまったく違うため。
--
--   書き込みポリシーは置かない。保存先パスとスレッドの対応をサーバ側で
--   組み立てる必要があるので、api/messages/upload.js を唯一の口にする。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) バケット（非公開）
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('messages', 'messages', false)
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- 2) 添付の台帳
--    先にファイルを預けてから本文を送るので、message_id は後から入る。
--    送信されずに残った行は message_id が null のままになる。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_message_files (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  thread_id    uuid not null references public.gw_threads(id) on delete cascade,
  message_id   uuid references public.gw_messages(id) on delete cascade,

  filename     text not null,
  mime_type    text not null,
  size_bytes   integer,
  storage_path text not null,

  uploaded_by  uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_gw_message_files_thread
  on public.gw_message_files(thread_id, created_at);
create index if not exists idx_gw_message_files_message
  on public.gw_message_files(message_id);


-- -----------------------------------------------------------------------------
-- 3) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_message_files enable row level security;

-- 参照: そのスレッドの参加者だけ。管理者でも参加していなければ見えない
drop policy if exists gw_message_files_select on public.gw_message_files;
create policy gw_message_files_select on public.gw_message_files
  for select
  using (public.gw_in_thread(thread_id));


-- -----------------------------------------------------------------------------
-- 4) Storage のポリシー
--    パス規約: <tenant_id>/<thread_id>/<file_id>.<ext>
--    safe_uuid を通すのは、UUID でないパスが1つでもあるとキャスト失敗で
--    クエリ全体が落ちるため（006 と同じ理由）。
-- -----------------------------------------------------------------------------
drop policy if exists message_files_rw on storage.objects;
create policy message_files_rw on storage.objects
  for all
  using (
    bucket_id = 'messages'
    and public.gw_in_thread(public.safe_uuid(split_part(name, '/', 2)))
  )
  with check (
    bucket_id = 'messages'
    and public.gw_in_thread(public.safe_uuid(split_part(name, '/', 2)))
  );
