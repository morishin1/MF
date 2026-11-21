begin;

-- The Sales API authorizes the actor and computes the existing follow-up plan.
-- Commit the activity, proposal state and task changes together.
create or replace function public.gw_record_sales_proposal_progress(
  p_tenant uuid, p_proposal uuid, p_expected_at timestamptz, p_actor uuid,
  p_activity jsonb, p_patch jsonb, p_complete uuid[], p_cancel jsonb, p_create jsonb
) returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  proposal public.gw_sales_proposals%rowtype;
  activity public.gw_sales_proposal_activities%rowtype;
  patch public.gw_sales_proposals%rowtype;
begin
  select * into proposal from public.gw_sales_proposals
    where tenant_id = p_tenant and id = p_proposal and archived_at is null for update;
  if not found or proposal.updated_at is distinct from p_expected_at then
    raise exception using errcode = '40001', message = 'proposal_changed';
  end if;

  activity := jsonb_populate_record(null::public.gw_sales_proposal_activities, p_activity);
  patch := jsonb_populate_record(proposal, p_patch);

  insert into public.gw_sales_proposal_activities (
    id, tenant_id, proposal_id, company_id, kind, result, outcome, occurred_at,
    employee_id, note, detail, source_event, created_by
  ) values (
    activity.id, p_tenant, p_proposal, proposal.company_id, activity.kind, activity.result,
    activity.outcome, activity.occurred_at, activity.employee_id, activity.note,
    activity.detail, activity.source_event, p_actor
  );

  update public.gw_sales_proposals
    set status = patch.status, close_reason = patch.close_reason, closed_at = patch.closed_at,
        updated_by = p_actor, updated_at = clock_timestamp()
    where tenant_id = p_tenant and id = p_proposal;

  update public.gw_sales_proposal_tasks
    set status = 'done', done_at = activity.occurred_at, done_by = p_actor, done_activity_id = activity.id
    where tenant_id = p_tenant and proposal_id = p_proposal and status = 'open' and id = any(p_complete);

  update public.gw_sales_proposal_tasks as task
    set status = 'canceled', cancel_reason = change.reason
    from jsonb_to_recordset(p_cancel) as change(id uuid, reason text)
    where task.tenant_id = p_tenant and task.proposal_id = p_proposal
      and task.status = 'open' and task.id = change.id;

  insert into public.gw_sales_proposal_tasks (
    tenant_id, proposal_id, kind, title, due_at, assignee_id, auto, source_event, created_by
  )
  select p_tenant, p_proposal, task.kind, task.title, task.due_at, task.assignee_id, task.auto, task.source_event, p_actor
  from jsonb_to_recordset(p_create) as task(
    kind text, title text, due_at timestamptz, assignee_id uuid, auto boolean, source_event text
  );
end;
$$;

revoke all on function public.gw_record_sales_proposal_progress(
  uuid, uuid, timestamptz, uuid, jsonb, jsonb, uuid[], jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.gw_record_sales_proposal_progress(
  uuid, uuid, timestamptz, uuid, jsonb, jsonb, uuid[], jsonb, jsonb
) to service_role;

-- Only the latest commercially relevant event is needed for a proposal.
create index if not exists idx_gw_sales_proposal_progress_latest
  on public.gw_sales_proposal_activities(tenant_id, proposal_id, created_at desc, id desc)
  where detail ? 'salesProgress';

-- Use the caller's Sales RLS. Totals are based on explicit contract confirmation and
-- recorded amounts. An Office document request or generic deal budget contributes no sales.
create or replace function public.gw_sales_enger_revenue(p_tenant uuid, p_from date, p_to date)
returns table (
  monthly_forecast numeric, monthly_confirmed numeric,
  referral_forecast numeric, referral_confirmed numeric, excluded_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  with commercial as (
    select p.status, (p.closed_at at time zone 'Asia/Tokyo')::date as won_on,
           a.progress->>'revenueKind' as kind,
           (a.progress->>'startOn') as start_on,
           case when a.progress->>'revenue' ~ '^[0-9]{1,12}$'
                then (a.progress->>'revenue')::numeric end as amount,
           a.progress->>'stage' as stage,
           a.progress->'contractConfirmed' = 'true'::jsonb as confirmed
    from public.gw_sales_proposals p
    join lateral (
      select detail->'salesProgress' as progress
      from public.gw_sales_proposal_activities a
      where a.tenant_id = p.tenant_id and a.proposal_id = p.id and a.detail ? 'salesProgress'
      order by a.created_at desc, a.id desc
      limit 1
    ) a on true
    left join public.gw_sales_proposal_source_state source
      on source.tenant_id = p.tenant_id and source.source_proposal_id = p.source_proposal_id
    where p.tenant_id = p_tenant and p.source_system = 'enger' and p.archived_at is null
      and not coalesce(source.deleted, false) and p.sent_at is not null
      and p.status not in ('lost','stopped','closed_no_reply')
  ), period as (
    select *, start_on between p_from::text and p_to::text as starts_in_period,
              won_on between p_from and p_to as won_in_period
    from commercial
  )
  select
    coalesce(sum(amount) filter (where kind = 'monthly' and status <> 'won' and stage in ('proposal','meeting','conditions','hold') and starts_in_period), 0),
    coalesce(sum(amount) filter (where kind = 'monthly' and status = 'won' and confirmed and stage in ('won','active') and starts_in_period), 0),
    coalesce(sum(amount) filter (where kind = 'one_time' and status <> 'won' and stage in ('proposal','meeting','conditions','hold') and starts_in_period), 0),
    coalesce(sum(amount) filter (where kind = 'one_time' and status = 'won' and confirmed and stage in ('won','active') and won_in_period), 0),
    count(*) filter (where (starts_in_period or won_in_period) and
      (amount is null or (status = 'won' and (confirmed is not true or (kind = 'monthly' and start_on is null)))))
  from period;
$$;

revoke all on function public.gw_sales_enger_revenue(uuid, date, date) from public, anon;
grant execute on function public.gw_sales_enger_revenue(uuid, date, date) to authenticated, service_role;

commit;
