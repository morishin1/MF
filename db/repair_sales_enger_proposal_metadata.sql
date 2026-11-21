-- Applied independently from the schema migration after reviewing the candidate counts.
-- Scope: Eight's ENGER import. No Sales proposal is closed or reassigned.
begin;

with observations as (
  select s.tenant_id, s.id, e.stage
  from public.gw_sales_proposals s
  join enger.proposals e on s.source_proposal_id = e.id::text
  where s.tenant_id = '4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac'
    and s.source_system = 'enger' and s.archived_at is null and e.deleted_at is null
    and s.status not in ('won', 'lost', 'closed_no_reply', 'stopped')
    and e.stage = '失注' and s.source_stage is distinct from e.stage
  for share of e
), corrected as (
  update public.gw_sales_proposals s set source_stage = o.stage
  from observations o
  where s.id = o.id and s.tenant_id = o.tenant_id
    and s.archived_at is null and s.status not in ('won', 'lost', 'closed_no_reply', 'stopped')
    and s.source_stage is distinct from o.stage
  returning s.id
)
select count(*) as corrected_source_stages from corrected;

with proven as (
  select t.id, t.tenant_id, t.proposal_id, a.id as activity_id, a.occurred_at, a.created_by
  from public.gw_sales_proposal_tasks t
  join public.gw_sales_proposals s on s.tenant_id = t.tenant_id and s.id = t.proposal_id
  join lateral (
    select a.id, a.occurred_at, a.created_by
    from public.gw_sales_proposal_activities a
    where a.tenant_id = s.tenant_id and a.proposal_id = s.id and a.kind = 'sent'
      and a.result is distinct from 'resent' and a.occurred_at = s.sent_at
    order by a.created_at, a.id
    limit 1
  ) a on true
  where t.tenant_id = '4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac'
    and s.source_system = 'enger' and s.archived_at is null
    and t.kind = 'prepare' and t.auto and t.source_event = 'auto:prepare'
    and t.status = 'open' and t.due_at < now()
  for share of s
), completed as (
  update public.gw_sales_proposal_tasks t
  set status = 'done', done_at = p.occurred_at, done_by = p.created_by, done_activity_id = p.activity_id
  from proven p
  where t.id = p.id and t.tenant_id = p.tenant_id and t.proposal_id = p.proposal_id
    and t.status = 'open' and t.kind = 'prepare' and t.auto and t.source_event = 'auto:prepare'
    and t.due_at < now()
  returning t.id
)
select count(*) as completed_preparation_tasks from completed;

commit;
