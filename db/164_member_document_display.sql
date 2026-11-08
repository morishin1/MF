-- Office contract register: UI-only visibility labels.
-- This table does NOT change employee employment_status, app access, or time clock data.
create table if not exists public.gw_member_document_display (
  tenant_id uuid not null,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  display_state text not null check (display_state in ('working','inactive','hidden')),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, employee_id)
);
alter table public.gw_member_document_display enable row level security;
revoke all on public.gw_member_document_display from public, anon, authenticated;
grant all on public.gw_member_document_display to service_role;
comment on table public.gw_member_document_display is
 'Display-only status in Office/KEIEI contract registers: working, inactive or hidden. No effect on employment, timecards or login.';
