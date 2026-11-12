-- Marketing PR attachments: private originals, accessed only through server-side Marketing authorization.
-- Apply in Supabase SQL editor after review, before enabling uploads.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values ('marketing-pr-originals','marketing-pr-originals',false,8388608,
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict(id) do update set public=false,file_size_limit=8388608,
 allowed_mime_types=excluded.allowed_mime_types;
create table if not exists public.gw_marketing_pr_files(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 uploaded_by uuid not null references auth.users(id),
 pr_id uuid not null unique references public.gw_marketing_pr_drafts(id) on delete cascade,
 filename text not null check(length(filename) between 1 and 200),
 mime_type text not null check(mime_type in
 ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
 size_bytes bigint not null check(size_bytes > 0 and size_bytes <= 8388608),
 storage_path text not null unique,
 confirmed_at timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists gw_marketing_pr_files_owner_idx
 on public.gw_marketing_pr_files(tenant_id,uploaded_by,created_at desc);
alter table public.gw_marketing_pr_files enable row level security;
revoke all on public.gw_marketing_pr_files from public, anon, authenticated;
comment on table public.gw_marketing_pr_files is
 'Private original Word/PDF files for the owner-owned Marketing PR drafts; server signed URLs only.';
commit;
