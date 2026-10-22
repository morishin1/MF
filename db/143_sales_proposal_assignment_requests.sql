-- db/143: Sales 提案の担当を直接変更し、他メンバーからの変更依頼を承認する。
-- db/138・140・141・142 の後に適用。提案・既存の行動履歴は削除しない。
begin;
do $$
begin
  if to_regclass('public.gw_sales_proposals') is null
     or to_regclass('public.gw_sales_proposal_handoffs') is null
     or to_regprocedure('public.gw_sales_proposal_editable(uuid,uuid)') is null then
    raise exception 'db/143 requires db/138, db/140, db/141 and db/142';
  end if;
end $$;

-- ENGER の現在の CL 担当は参照用に分離する。Sales の担当者は後続イベントで自動上書きしない。
alter table public.gw_sales_proposals
  add column if not exists enger_cl_owner_id uuid references public.gw_employees(id) on delete set null,
  add column if not exists enger_cl_owner_name text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname='gw_sales_proposals_enger_cl_owner_name_chk'
    and conrelid='public.gw_sales_proposals'::regclass) then
    alter table public.gw_sales_proposals add constraint gw_sales_proposals_enger_cl_owner_name_chk
      check (enger_cl_owner_name is null or char_length(enger_cl_owner_name) <= 100);
  end if;
end $$;
update public.gw_sales_proposals
   set enger_cl_owner_id=sales_owner_id
 where source_system='enger' and enger_cl_owner_id is null and sales_owner_id is not null;

-- 管理者も担当案件の編集・保存ができる。一般メンバーは全件閲覧できるが引き続き担当本人だけが編集できる。
create or replace function public.gw_sales_proposal_editable(p_tenant uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null
    and public.gw_is_sales(p_tenant)
    and (public.gw_sales_is_manager(p_tenant)
      or (p_owner is not null and p_owner = public.gw_employee_id(p_tenant)))
$$;

-- db/142 のラッパーも新しい編集権限（担当本人または管理者）に合わせる。
create or replace function public.gw_sales_transfer_proposal_owner(
  p_proposal uuid, p_to_stage text, p_to_owner uuid,
  p_reason text, p_decision text, p_next_action text, p_next_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_tenant uuid; v_owner uuid; v_archived timestamptz;
begin
  select tenant_id, sales_owner_id, archived_at into v_tenant, v_owner, v_archived
    from public.gw_sales_proposals where id=p_proposal for update;
  if v_tenant is null or v_archived is not null or not public.gw_sales_proposal_editable(v_tenant,v_owner) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  return public.gw_sales_transfer_proposal(p_proposal,p_to_stage,p_to_owner,p_reason,p_decision,p_next_action,p_next_at);
end $$;
revoke all on function public.gw_sales_transfer_proposal_owner(uuid,text,uuid,text,text,text,timestamptz) from public, anon;
grant execute on function public.gw_sales_transfer_proposal_owner(uuid,text,uuid,text,text,text,timestamptz) to authenticated;

create table if not exists public.gw_sales_proposal_assignment_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  proposal_id uuid not null references public.gw_sales_proposals(id),
  stage text not null check (stage in ('proposal','cs','closing')),
  change_type text not null check (change_type in ('request','direct')),
  from_owner_id uuid references public.gw_employees(id) on delete set null,
  to_owner_id uuid references public.gw_employees(id) on delete set null,
  requested_by_employee_id uuid references public.gw_employees(id) on delete set null,
  reviewed_by_employee_id uuid references public.gw_employees(id) on delete set null,
  status text not null check (status in ('pending','approved','rejected','superseded')),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  review_note text check (review_note is null or char_length(review_note) <= 500),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status='pending' and change_type='request' and resolved_at is null and reviewed_by_employee_id is null)
      or (status in ('approved','rejected','superseded') and resolved_at is not null and reviewed_by_employee_id is not null)),
  check (change_type='direct' or to_owner_id is not null)
);
create index if not exists idx_gw_sales_proposal_assignment_history
  on public.gw_sales_proposal_assignment_requests(proposal_id, created_at desc);
create unique index if not exists uq_gw_sales_proposal_assignment_pending
  on public.gw_sales_proposal_assignment_requests(proposal_id, stage) where status='pending';
alter table public.gw_sales_proposal_assignment_requests enable row level security;
drop policy if exists gw_sales_proposal_assignment_requests_read on public.gw_sales_proposal_assignment_requests;
create policy gw_sales_proposal_assignment_requests_read on public.gw_sales_proposal_assignment_requests
  for select to authenticated using (public.gw_is_sales(tenant_id)
    and public.gw_sales_proposal_visible_id(proposal_id));
grant select on public.gw_sales_proposal_assignment_requests to authenticated;
revoke insert, update, delete on public.gw_sales_proposal_assignment_requests from authenticated, anon;

-- 共通の反映処理。担当・未完了タスク・活動履歴を同じ DB transaction で更新する。
create or replace function public.gw_sales_apply_proposal_stage_owner(
  p_proposal uuid, p_stage text, p_to_owner uuid, p_change_id uuid, p_actor uuid, p_reason text
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v public.gw_sales_proposals%rowtype;
  v_from_owner uuid;
  v_user uuid := (select auth.uid());
begin
  select * into v from public.gw_sales_proposals where id=p_proposal for update;
  if not found then raise exception 'proposal_not_found' using errcode='42501'; end if;
  if v.archived_at is not null or v.status in ('won','lost','stopped','closed_no_reply') then
    raise exception 'proposal_not_active' using errcode='23514';
  end if;
  if p_stage='proposal' then v_from_owner:=v.sales_owner_id;
  elsif p_stage='cs' then v_from_owner:=coalesce(v.cs_owner_id,v.sales_owner_id);
  elsif p_stage='closing' then v_from_owner:=coalesce(v.closing_owner_id,v.sales_owner_id);
  else raise exception 'invalid_stage' using errcode='23514';
  end if;
  if v_from_owner is not distinct from p_to_owner then
    raise exception 'assignment_unchanged' using errcode='23514';
  end if;
  if p_to_owner is not null and not public.gw_sales_employee_ok(p_to_owner,v.tenant_id) then
    raise exception 'invalid_target_employee' using errcode='23514';
  end if;
  update public.gw_sales_proposals
     set sales_owner_id=case when p_stage='proposal' or handoff_stage=p_stage then p_to_owner else sales_owner_id end,
         cs_owner_id=case when p_stage='cs' then p_to_owner else cs_owner_id end,
         closing_owner_id=case when p_stage='closing' then p_to_owner else closing_owner_id end,
         updated_by=v_user, updated_at=now()
   where id=v.id;
  update public.gw_sales_proposal_tasks
     set assignee_id=p_to_owner
   where proposal_id=v.id and status='open' and kind <> 'manager_review'
     and (assignee_id=v_from_owner or assignee_id is null);
  insert into public.gw_sales_proposal_activities(
    tenant_id,proposal_id,company_id,kind,occurred_at,employee_id,created_by,note,detail
  ) values (
    v.tenant_id,v.id,v.company_id,'assign',now(),p_actor,v_user,
    '担当変更（'||case p_stage when 'proposal' then '提案' when 'cs' then 'CS' else 'クロージング' end||'）：'||btrim(p_reason),
    jsonb_build_object('stage',p_stage,'from',v_from_owner,'to',p_to_owner,'reason',btrim(p_reason),'changeId',p_change_id)
  );
  return v_from_owner;
end $$;
revoke all on function public.gw_sales_apply_proposal_stage_owner(uuid,text,uuid,uuid,uuid,text) from public, anon, authenticated;

create or replace function public.gw_sales_proposal_assign_stage_owner(
  p_proposal uuid, p_stage text, p_to_owner uuid, p_reason text
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v public.gw_sales_proposals%rowtype;
  v_actor uuid;
  v_from_owner uuid;
  v_team jsonb;
  v_change uuid;
begin
  if (select auth.uid()) is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select * into v from public.gw_sales_proposals where id=p_proposal for update;
  if not found then raise exception 'proposal_not_found' using errcode='42501'; end if;
  v_actor:=public.gw_employee_id(v.tenant_id);
  if v_actor is null or not public.gw_is_sales(v.tenant_id) or v.archived_at is not null
     or not (public.gw_sales_is_manager(v.tenant_id) or v.sales_owner_id=v_actor) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_stage not in ('proposal','cs','closing') or p_stage <> case
      when v.handoff_stage='closing' then 'closing'
      when v.handoff_stage='cs' and v.cs_owner_id is not null then 'cs'
      else 'proposal' end then
    raise exception 'invalid_stage' using errcode='23514';
  end if;
  if v.status in ('won','lost','stopped','closed_no_reply') then
    raise exception 'proposal_not_active' using errcode='23514';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'reason_required' using errcode='23514';
  end if;
  if p_stage='proposal' then v_from_owner:=v.sales_owner_id;
  elsif p_stage='cs' then v_from_owner:=coalesce(v.cs_owner_id,v.sales_owner_id);
  elsif p_stage='closing' then v_from_owner:=coalesce(v.closing_owner_id,v.sales_owner_id);
  else raise exception 'invalid_stage' using errcode='23514'; end if;
  if p_stage in ('cs','closing') then
    if p_stage='cs' then select cs_members into v_team from public.gw_sales_proposal_settings where tenant_id=v.tenant_id;
    else select closing_members into v_team from public.gw_sales_proposal_settings where tenant_id=v.tenant_id; end if;
    if p_to_owner is not null and (v_team is null or not (v_team @> to_jsonb(p_to_owner::text))) then
      raise exception 'target_not_in_configured_team' using errcode='23514';
    end if;
  end if;
  update public.gw_sales_proposal_assignment_requests
     set status='superseded', reviewed_by_employee_id=v_actor,
         review_note='担当者が直接変更されたため申請を終了しました', resolved_at=now()
   where proposal_id=v.id and stage=p_stage and status='pending';
  insert into public.gw_sales_proposal_assignment_requests(
    tenant_id,proposal_id,stage,change_type,from_owner_id,to_owner_id,requested_by_employee_id,
    reviewed_by_employee_id,status,reason,created_at,resolved_at
  ) values (v.tenant_id,v.id,p_stage,'direct',v_from_owner,p_to_owner,v_actor,v_actor,'approved',btrim(p_reason),now(),now())
  returning id into v_change;
  perform public.gw_sales_apply_proposal_stage_owner(v.id,p_stage,p_to_owner,v_change,v_actor,p_reason);
  return v_change;
end $$;
revoke all on function public.gw_sales_proposal_assign_stage_owner(uuid,text,uuid,text) from public, anon;
grant execute on function public.gw_sales_proposal_assign_stage_owner(uuid,text,uuid,text) to authenticated;

create or replace function public.gw_sales_proposal_request_assignment(
  p_proposal uuid, p_stage text, p_to_owner uuid, p_reason text
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v public.gw_sales_proposals%rowtype;
  v_actor uuid;
  v_from_owner uuid;
  v_team jsonb;
  v_request uuid;
begin
  if (select auth.uid()) is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select * into v from public.gw_sales_proposals where id=p_proposal for update;
  if not found then raise exception 'proposal_not_found' using errcode='42501'; end if;
  v_actor:=public.gw_employee_id(v.tenant_id);
  if v_actor is null or not public.gw_is_sales(v.tenant_id) or v.archived_at is not null then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_stage not in ('proposal','cs','closing') or p_stage <> case
      when v.handoff_stage='closing' then 'closing'
      when v.handoff_stage='cs' and v.cs_owner_id is not null then 'cs'
      else 'proposal' end then
    raise exception 'invalid_stage' using errcode='23514';
  end if;
  if v.status in ('won','lost','stopped','closed_no_reply') then
    raise exception 'proposal_not_active' using errcode='23514';
  end if;
  if p_to_owner is null or not public.gw_sales_employee_ok(p_to_owner,v.tenant_id) then
    raise exception 'invalid_target_employee' using errcode='23514';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'reason_required' using errcode='23514';
  end if;
  if p_stage in ('cs','closing') then
    if p_stage='cs' then select cs_members into v_team from public.gw_sales_proposal_settings where tenant_id=v.tenant_id;
    else select closing_members into v_team from public.gw_sales_proposal_settings where tenant_id=v.tenant_id; end if;
    if v_team is null or not (v_team @> to_jsonb(p_to_owner::text)) then
      raise exception 'target_not_in_configured_team' using errcode='23514';
    end if;
  end if;
  if p_stage='proposal' then v_from_owner:=v.sales_owner_id;
  elsif p_stage='cs' then
    v_from_owner:=coalesce(v.cs_owner_id,v.sales_owner_id);
    select cs_members into v_team from public.gw_sales_proposal_settings where tenant_id=v.tenant_id;
  elsif p_stage='closing' then
    v_from_owner:=coalesce(v.closing_owner_id,v.sales_owner_id);
    select closing_members into v_team from public.gw_sales_proposal_settings where tenant_id=v.tenant_id;
  else raise exception 'invalid_stage' using errcode='23514'; end if;
  if public.gw_sales_is_manager(v.tenant_id) or v_actor=v.sales_owner_id or v_actor=v_from_owner then
    raise exception 'request_not_needed' using errcode='23514';
  end if;
  if v_from_owner is not distinct from p_to_owner then raise exception 'assignment_unchanged' using errcode='23514'; end if;
  if p_stage in ('cs','closing') and (v_team is null or not (v_team @> to_jsonb(p_to_owner::text))) then
    raise exception 'target_not_in_configured_team' using errcode='23514';
  end if;
  insert into public.gw_sales_proposal_assignment_requests(
    tenant_id,proposal_id,stage,change_type,from_owner_id,to_owner_id,requested_by_employee_id,status,reason
  ) values (v.tenant_id,v.id,p_stage,'request',v_from_owner,p_to_owner,v_actor,'pending',btrim(p_reason))
  returning id into v_request;
  return v_request;
end $$;
revoke all on function public.gw_sales_proposal_request_assignment(uuid,text,uuid,text) from public, anon;
grant execute on function public.gw_sales_proposal_request_assignment(uuid,text,uuid,text) to authenticated;

create or replace function public.gw_sales_proposal_review_assignment_request(
  p_request uuid, p_decision text, p_note text default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v public.gw_sales_proposals%rowtype;
  r public.gw_sales_proposal_assignment_requests%rowtype;
  v_actor uuid;
  v_proposal_id uuid;
  v_current_owner uuid;
  v_team jsonb;
  v_decision text:=btrim(coalesce(p_decision,''));
  v_note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
  if (select auth.uid()) is null then raise exception 'authentication_required' using errcode='42501'; end if;
  -- Lock in proposal -> request order, matching submission and direct assignment.
  select proposal_id into v_proposal_id from public.gw_sales_proposal_assignment_requests where id=p_request;
  if not found then raise exception 'request_not_found' using errcode='42501'; end if;
  select * into v from public.gw_sales_proposals where id=v_proposal_id for update;
  if not found then raise exception 'proposal_not_found' using errcode='42501'; end if;
  select * into r from public.gw_sales_proposal_assignment_requests where id=p_request for update;
  if r.status <> 'pending' or r.change_type <> 'request' then
    raise exception 'request_not_pending' using errcode='23514';
  end if;
  v_actor:=public.gw_employee_id(v.tenant_id);
  if v_actor is null or not public.gw_is_sales(v.tenant_id) or v.archived_at is not null then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if v_actor=r.requested_by_employee_id then raise exception 'self_review_forbidden' using errcode='42501'; end if;
  if r.stage <> case
      when v.handoff_stage='closing' then 'closing'
      when v.handoff_stage='cs' and v.cs_owner_id is not null then 'cs'
      else 'proposal' end then
    raise exception 'request_stale' using errcode='23514';
  end if;
  if r.stage='proposal' then v_current_owner:=v.sales_owner_id;
  elsif r.stage='cs' then v_current_owner:=coalesce(v.cs_owner_id,v.sales_owner_id);
  else v_current_owner:=coalesce(v.closing_owner_id,v.sales_owner_id); end if;
  if not public.gw_sales_is_manager(v.tenant_id) and v_current_owner is distinct from v_actor then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if v_current_owner is distinct from r.from_owner_id then raise exception 'request_stale' using errcode='23514'; end if;
  if v.status in ('won','lost','stopped','closed_no_reply') then raise exception 'proposal_not_active' using errcode='23514'; end if;
  if v_decision not in ('approve','reject') or char_length(coalesce(v_note,'')) > 500 then
    raise exception 'invalid_decision' using errcode='23514';
  end if;
  if v_decision='approve' then
    if r.to_owner_id is null or not public.gw_sales_employee_ok(r.to_owner_id,v.tenant_id) then
      raise exception 'invalid_target_employee' using errcode='23514';
    end if;
    if r.stage in ('cs','closing') then
      if r.stage='cs' then select cs_members into v_team from public.gw_sales_proposal_settings where tenant_id=v.tenant_id;
      else select closing_members into v_team from public.gw_sales_proposal_settings where tenant_id=v.tenant_id; end if;
      if v_team is null or not (v_team @> to_jsonb(r.to_owner_id::text)) then
        raise exception 'target_not_in_configured_team' using errcode='23514';
      end if;
    end if;
    perform public.gw_sales_apply_proposal_stage_owner(v.id,r.stage,r.to_owner_id,r.id,v_actor,r.reason);
  end if;
  update public.gw_sales_proposal_assignment_requests
     set status=case when v_decision='approve' then 'approved' else 'rejected' end,
         reviewed_by_employee_id=v_actor,review_note=v_note,resolved_at=now()
   where id=r.id;
  return r.id;
end $$;
revoke all on function public.gw_sales_proposal_review_assignment_request(uuid,text,text) from public, anon;
grant execute on function public.gw_sales_proposal_review_assignment_request(uuid,text,text) to authenticated;

commit;
notify pgrst, 'reload schema';
