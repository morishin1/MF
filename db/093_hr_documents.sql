-- =============================================================================
-- 093: 採用の応募書類（履歴書・職務経歴書・その他）
--
-- ■ 何をするものか
--   /hr の応募者詳細「書類」タブで、履歴書・職務経歴書をアップロードして見られるようにする。
--
-- ■ 既存の表を使わない理由
--   gw_procedure_files（db/012）は入社手続き（gw_procedures）に紐づく台帳で、
--   procedure_id が必須。応募者（gw_hr_applicants）はまだ社員でも手続きでもないので、
--   そこには入らない。応募者の書類を持つ表はほかに無いため、この表を足す。
--
-- ■ 差し替えても前の版を残す
--   1回のアップロード＝1行。同じ種類（履歴書など）の最新の1行を通常表示し、
--   それより前の行は「履歴」から見られる。上書きしない。
--
-- ■ 個人情報なので、公開URLにしない
--   ファイルは既存の private バケット hr の  <tenant>/recruit/<applicant>/<uuid>.<ext>  に置く。
--   見るときは api/hr/documents.js が数分だけ有効な signed URL を出す。
--   読めるのは採用を扱える人（gw_is_recruiting：管理者・経営者・人事・採用担当）だけ。
--   営業だけの人には見えない。書き込みは API（service_role）だけ。
--
-- ■ 削除
--   ファイルの実体は Storage から消す。行は deleted_at を入れて残す（誰がいつ消したかの記録）。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 081_hr_recruiting.sql（gw_hr_applicants・gw_is_recruiting）
-- =============================================================================

begin;

create table if not exists public.gw_hr_documents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  applicant_id  uuid not null references public.gw_hr_applicants(id) on delete cascade,

  doc_type      text not null default 'other'
                check (doc_type in ('resume', 'work_history', 'other')),   -- 履歴書 / 職務経歴書 / その他
  filename      text not null,
  storage_path  text not null,
  mime_type     text not null,
  size_bytes    integer,
  sha256        text,

  uploaded_by   uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_gw_hr_documents_applicant
  on public.gw_hr_documents(applicant_id, doc_type, created_at desc);
create index if not exists idx_gw_hr_documents_tenant
  on public.gw_hr_documents(tenant_id, created_at desc);

comment on table public.gw_hr_documents is
  '応募書類（履歴書・職務経歴書・その他）。1アップロード＝1行で、差し替えても前の版を残す。'
  'ファイルは private バケット hr。読めるのは採用を扱える人（gw_is_recruiting）だけ';

alter table public.gw_hr_documents enable row level security;

drop policy if exists gw_hr_documents_read on public.gw_hr_documents;
create policy gw_hr_documents_read on public.gw_hr_documents
  for select to authenticated
  using (public.gw_is_recruiting(tenant_id));

commit;

notify pgrst, 'reload schema';

-- 確認:
--   select a.name, d.doc_type, d.filename, d.created_at, d.deleted_at
--     from public.gw_hr_documents d join public.gw_hr_applicants a on a.id = d.applicant_id
--    order by d.created_at desc limit 20;
