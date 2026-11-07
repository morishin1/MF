-- Office / KEIEI 共通のメンバー書類追加分だけを管理。
-- 契約書・電子署名・採用・入社提出の原本は既存テーブルを読む（ここへ移動しない）。
-- 認可はサーバ API。匿名・一般ログインによる Data API の直接閲覧を禁止する。
create table if not exists public.gw_member_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  employee_id uuid not null references public.gw_employees(id) on delete restrict,
  doc_kind text not null check (length(doc_kind) between 2 and 80),
  filename text not null check (length(filename) between 1 and 160),
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('application/pdf','image/jpeg','image/png')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'received' check (status in ('received','verified')),
  uploaded_by uuid not null,
  verified_by uuid,
  verified_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint member_docs_verified_consistency check (
    (status = 'received' and verified_at is null and verified_by is null)
    or (status = 'verified' and verified_at is not null and verified_by is not null)
  )
);
create index if not exists gw_member_documents_employee_idx
  on public.gw_member_documents (tenant_id, employee_id, created_at desc);
alter table public.gw_member_documents enable row level security;
revoke all on public.gw_member_documents from public, anon, authenticated;
grant all on public.gw_member_documents to service_role;
comment on table public.gw_member_documents is
  'Office/KEIEIの追加・差替え書類。社員IDで統合。電子署名済みはgw_sign_requestsの証跡でしか判定しない。APIだけが読み書き。';
