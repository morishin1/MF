-- 176: Secure, company-scoped job/talent intake from the ENGER business portal.
-- Drafts are never inserted directly into public ENGER jobs/candidates.
begin;
create table if not exists enger.dx2_company_partner_submissions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 company_id uuid not null references enger.companies(id),
 member_id uuid not null references enger.dx2_company_portal_members(id),
 client_request_id uuid not null,
 item_type text not null check (item_type in ('job','talent')),
 title text not null check (char_length(title) between 2 and 160),
 description text not null default '' check (char_length(description)<=3000),
 skills jsonb not null default '[]'::jsonb,
 budget text,
 start_date date,
 work_style text,
 attachment_path text,
 attachment_name text,
 attachment_mime text,
 attachment_size integer,
 status text not null default 'pending_review'
  check (status in ('pending_review','approved','needs_changes','rejected')),
 review_note text,
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint company_submission_request_unique unique(tenant_id,company_id,client_request_id),
 constraint company_submission_skills_array check(jsonb_typeof(skills)='array'
  and jsonb_array_length(skills)<=16),
 constraint company_submission_attachment_bounds check(attachment_size is null or attachment_size between 1 and 5242880)
);
create index if not exists company_partner_submissions_review
 on enger.dx2_company_partner_submissions(tenant_id,status,created_at desc);
create index if not exists company_partner_submissions_company
 on enger.dx2_company_partner_submissions(tenant_id,company_id,created_at desc);
alter table enger.dx2_company_partner_submissions enable row level security;
revoke all on enger.dx2_company_partner_submissions from PUBLIC,anon,authenticated;
grant select,insert,update on enger.dx2_company_partner_submissions to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('enger-company-private','enger-company-private',false,5242880,
 array['application/pdf','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict(id) do nothing;
comment on table enger.dx2_company_partner_submissions is
 'Company-submitted jobs and member skill sheets. Always staff-reviewed before ENGER matching or public availability.';
commit;