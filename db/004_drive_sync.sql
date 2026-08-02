-- 004_drive_sync.sql
-- Google Drive 保存の記録用カラムを documents に追加。
-- 追加のみ・既存データは変更しないため、そのまま実行可。

alter table public.documents add column if not exists drive_file_id   text;
alter table public.documents add column if not exists drive_link      text;
alter table public.documents add column if not exists drive_synced_at timestamptz;

-- 未同期の抽出を速くする（Driveへの遡り同期で使用）
create index if not exists idx_documents_drive_pending
  on public.documents(tenant_id, client_id)
  where drive_file_id is null;
