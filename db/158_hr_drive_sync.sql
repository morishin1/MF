-- 158_hr_drive_sync.sql
-- Office入退社書類の「アップロード済み」事実を実ファイル存在と分離して記録。
-- 署名URLを発行しただけの空ファイル台帳を、提出済みと誤認しないため。
-- 既存データは実体のあるものだけ backfill。ファイル本体は読み取らない。
begin;
alter table public.gw_procedure_files
  add column if not exists uploaded_at timestamptz;

-- 過去のアップロードは、private hr bucket に実体があることを確認してから完了扱い。
update public.gw_procedure_files f
   set uploaded_at = coalesce(o.created_at, f.created_at, now())
  from storage.objects o
 where o.bucket_id = 'hr'
   and o.name = f.storage_path
   and f.uploaded_at is null;

create index if not exists idx_gw_procedure_files_confirmed
  on public.gw_procedure_files(procedure_id, uploaded_at)
  where uploaded_at is not null;

comment on column public.gw_procedure_files.uploaded_at is
  '実ファイル存在とサイズをサーバで検査して確定した日時。NULLはアップロード未確定。';
commit;
