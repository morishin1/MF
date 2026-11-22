begin;

-- One append-only record per assessment revision. The proposal remains the source
-- of ownership, progress and contracts.
create table public.gw_sales_proposal_assessments (
  tenant_id uuid not null references public.tenants(id),
  proposal_id uuid not null references public.gw_sales_proposals(id),
  revision integer not null check (revision > 0),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  assessment jsonb not null check (jsonb_typeof(assessment) = 'object'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, proposal_id, revision)
);

alter table public.gw_sales_proposal_assessments enable row level security;
revoke all on public.gw_sales_proposal_assessments from public, anon, authenticated;
grant select, insert on public.gw_sales_proposal_assessments to service_role;

create view public.gw_sales_proposal_latest_results with (security_invoker = true) as
select distinct on (tenant_id, proposal_id) tenant_id, proposal_id, facts->>'interviewResult' as interview_result
from public.gw_sales_proposal_assessments
order by tenant_id, proposal_id, revision desc;

revoke all on public.gw_sales_proposal_latest_results from public, anon, authenticated;
grant select on public.gw_sales_proposal_latest_results to service_role;

create function public.gw_append_sales_proposal_assessment(
  p_tenant uuid, p_proposal uuid, p_revision integer, p_actor uuid, p_employee uuid,
  p_manager boolean, p_facts jsonb, p_assessment jsonb
) returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  p public.gw_sales_proposals%rowtype;
  current_revision integer;
begin
  select * into p from public.gw_sales_proposals
    where tenant_id = p_tenant and id = p_proposal and source_system = 'enger'
      and archived_at is null and sent_at is not null
    for update;
  if not found or p.contact_stop or p.status in ('won', 'lost', 'stopped', 'closed_no_reply')
    or (p_manager is not true and (p_employee is null or p.sales_owner_id is distinct from p_employee)) then
    raise exception using errcode = '42501', message = 'proposal_not_editable';
  end if;
  select coalesce(max(revision), 0) into current_revision from public.gw_sales_proposal_assessments
    where tenant_id = p_tenant and proposal_id = p_proposal;
  if current_revision is distinct from p_revision then
    raise exception using errcode = '40001', message = 'assessment_changed';
  end if;
  insert into public.gw_sales_proposal_assessments(tenant_id, proposal_id, revision, facts, assessment, created_by)
    values (p_tenant, p_proposal, current_revision + 1, p_facts, p_assessment, p_actor);
  return current_revision + 1;
end;
$$;

revoke all on function public.gw_append_sales_proposal_assessment(uuid, uuid, integer, uuid, uuid, boolean, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.gw_append_sales_proposal_assessment(uuid, uuid, integer, uuid, uuid, boolean, jsonb, jsonb)
  to service_role;

commit;
