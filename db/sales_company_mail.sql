-- Dedicated audit/reservation ledger. API enforces Sales role, canonical tenant and company scope.
-- No browser role can read or write message bodies directly.
begin;
create table if not exists public.gw_sales_company_mail (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 company_id uuid not null,
 sales_company_id uuid,
 request_key uuid not null,
 fingerprint text not null check (length(fingerprint)=64),
 to_email text not null check (length(to_email) between 3 and 254),
 from_email text not null,
 subject text not null check (length(subject) between 1 and 300),
 body_text text not null check (length(body_text) between 1 and 20000),
 actor_id uuid not null,
 actor_name text not null,
 status text not null default 'sending' check (status in ('sending','accepted','unknown','not_sent')),
 provider_message_id text,
 created_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz,
 unique (tenant_id,request_key)
);
create index if not exists gw_sales_company_mail_history on public.gw_sales_company_mail (tenant_id,company_id,created_at desc);
alter table public.gw_sales_company_mail enable row level security;
revoke all on public.gw_sales_company_mail from public,anon,authenticated;
grant select,insert,update on public.gw_sales_company_mail to service_role;
comment on table public.gw_sales_company_mail is 'Server-only durable SMTP reservation + exact message audit. Never automatically retry sending/unknown.';
commit;
