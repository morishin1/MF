-- PROPOSAL ONLY: 管理者が対象プロジェクト・前提SQLを確認し、承認後に手動実行する。
-- Sales合格 → Officeの書類作成依頼。契約作成/署名/送信/成約/稼働の自動更新は一切しない。
-- 前提: Sales 138/140/141/142、119/130 app grants、120退職ゲート、Office 099、056 doc orders、076 site contracts。
-- PR205 の149番SQLとは独立。既存データの合格推定/遡及起票/自動通知なし。
begin;
do $$ begin
  if to_regclass('public.gw_sales_proposals') is null
     or to_regclass('public.gw_doc_orders') is null or to_regclass('public.gw_site_contracts') is null
     or to_regprocedure('public.gw_has_app(uuid,text)') is null
     or to_regprocedure('public.gw_employee_is_left(text,date)') is null
     or to_regprocedure('public.gw_sales_is_manager(uuid)') is null
     or to_regprocedure('public.gw_is_office(uuid)') is null
     or not exists(select 1 from information_schema.columns where table_schema='public'
       and table_name='gw_sales_proposals' and column_name='archived_at') then
    raise exception 'requires Sales138/140/141/142, app119/130, left120, Office099, docs056 and site076';
  end if;
end $$;

-- lib/gw.js canAccessOfficeと同じ: Office業務ロール AND アプリ入口。
create or replace function public.gw_sales_contract_office(p_tenant uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select (select auth.uid()) is not null and public.gw_is_office(p_tenant)
    and (public.gw_has_role(p_tenant,'owner') or public.gw_has_app(p_tenant,'office') or public.is_tenant_staff(p_tenant))
$$;
create or replace function public.gw_sales_contract_office_member(p_tenant uuid,p_employee uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.gw_employees e where e.id=p_employee and e.tenant_id=p_tenant
    and not public.gw_employee_is_left(e.status,e.left_on) and e.user_id is not null
    and exists(select 1 from public.gw_role_grants r where r.employee_id=e.id and r.tenant_id=p_tenant and r.role in ('owner','manager','finance'))
    and (exists(select 1 from public.gw_role_grants r where r.employee_id=e.id and r.tenant_id=p_tenant and r.role='owner')
      or exists(select 1 from public.gw_app_grants a where a.employee_id=e.id and a.tenant_id=p_tenant and a.app_key='office')
      or exists(select 1 from public.memberships m where m.user_id=e.user_id and m.tenant_id=p_tenant and m.role in ('admin','staff'))))
$$;

-- 合格の参照情報を今後ブラウザの直接DB操作で偽装させない。
-- 正規のHMAC受信APIはservice_roleなので動作を維持。既存の記録内容は書き換えない。
create or replace function public.gw_sales_contract_guard_source()
returns trigger language plpgsql set search_path='' as $$
begin
  if current_user in ('authenticated','anon') then
    if TG_TABLE_NAME='gw_sales_proposal_activities' then
      if new.kind='sync' then raise exception 'source_provenance_readonly' using errcode='42501'; end if;
    elsif TG_OP='INSERT' then
      if new.source_system='enger' then raise exception 'source_provenance_readonly' using errcode='42501'; end if;
    elsif new.source_system is distinct from old.source_system
       or new.source_proposal_id is distinct from old.source_proposal_id
       or new.source_stage is distinct from old.source_stage then
      raise exception 'source_provenance_readonly' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists gw_sales_contract_guard_proposal on public.gw_sales_proposals;
create trigger gw_sales_contract_guard_proposal before insert or update on public.gw_sales_proposals
  for each row execute function public.gw_sales_contract_guard_source();
drop trigger if exists gw_sales_contract_guard_activity on public.gw_sales_proposal_activities;
create trigger gw_sales_contract_guard_activity before insert on public.gw_sales_proposal_activities
  for each row execute function public.gw_sales_contract_guard_source();

create table if not exists public.gw_sales_contract_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  proposal_id uuid not null references public.gw_sales_proposals(id) on delete restrict,
  contract_type text not null check(contract_type in ('client_ses','bp_order','employment','contractor','needs_confirmation')),
  status text not null default 'requested' check(status in ('requested','in_progress','review','completed','cancelled')),
  requested_due_on date not null,
  planned_start_on date,
  note text check(note is null or char_length(note)<=2000),
  assignee_id uuid references public.gw_employees(id) on delete set null,
  artifact_reference text check(artifact_reference is null or char_length(artifact_reference)<=2000),
  employee_id uuid references public.gw_employees(id) on delete set null,
  doc_order_id uuid references public.gw_doc_orders(id) on delete restrict,
  site_contract_id uuid references public.gw_site_contracts(id) on delete restrict,
  version integer not null default 1 check(version>0),
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,proposal_id),
  constraint gw_sales_contract_request_draft check(status<>'completed' or
    (contract_type<>'needs_confirmation' and assignee_id is not null and char_length(btrim(coalesce(artifact_reference,'')))>=10))
);
create index if not exists idx_gw_sales_contract_requests_queue on public.gw_sales_contract_requests(tenant_id,status,requested_due_on);
create table if not exists public.gw_sales_contract_request_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  request_id uuid not null references public.gw_sales_contract_requests(id) on delete restrict,
  action text not null check(action in ('create','resubmit','update','reopen','cancel')),
  from_status text,
  to_status text not null,
  version integer not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_employee_id uuid references public.gw_employees(id) on delete set null,
  reason text check(reason is null or char_length(reason)<=1000),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(request_id,version)
);
comment on table public.gw_sales_contract_requests is 'Officeへの書類作成依頼。completedは作成担当者による完了記録で、契約締結/署名済み/成約ではない。';
comment on column public.gw_sales_contract_requests.artifact_reference is '人が入力した書類の保管場所/管理番号。書類の内容・存在・署名の自動検証ではない。リンクとして実行しない。';

alter table public.gw_sales_contract_requests enable row level security;
alter table public.gw_sales_contract_request_events enable row level security;
drop policy if exists sales_contract_request_read on public.gw_sales_contract_requests;
create policy sales_contract_request_read on public.gw_sales_contract_requests for select to authenticated
  using(public.gw_is_sales(tenant_id) or public.gw_sales_contract_office(tenant_id));
drop policy if exists sales_contract_request_event_read on public.gw_sales_contract_request_events;
create policy sales_contract_request_event_read on public.gw_sales_contract_request_events for select to authenticated
  using(public.gw_is_sales(tenant_id) or public.gw_sales_contract_office(tenant_id));
-- 直接のINSERT/UPDATE/DELETE禁止。atomic RPCだけで更新・監査を行う。
revoke all on public.gw_sales_contract_requests,public.gw_sales_contract_request_events from public,anon,authenticated;
-- Sales projection masks HR IDs; a raw SELECT would bypass that boundary. Only read RPC is exposed.
grant all on public.gw_sales_contract_requests,public.gw_sales_contract_request_events to service_role;

create or replace function public.gw_sales_contract_acceptance(p public.gw_sales_proposals)
returns text language sql stable security definer set search_path='' as $$
  select case when p.source_system<>'enger' then null
    when p.source_stage in ('合格','面談合格') then 'ENGER現在ステージ：'||p.source_stage
    when exists(select 1 from public.gw_sales_proposal_activities a where a.tenant_id=p.tenant_id and a.proposal_id=p.id
      and a.kind='sync' and nullif(a.source_event,'') is not null and a.created_by is null and a.employee_id is null
      and a.detail->>'to' in ('合格','面談合格')) then 'ENGER合格への連携履歴' else null end
$$;

create or replace function public.gw_sales_contract_request_action(
  p_tenant uuid,p_proposal uuid,p_mode text,p_action text,p_expected_version integer default null,p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_p public.gw_sales_proposals%rowtype;
  v public.gw_sales_contract_requests%rowtype;
  v_old public.gw_sales_contract_requests%rowtype;
  v_user uuid := (select auth.uid());
  v_actor uuid;
  v_reason text := nullif(btrim(p_payload->>'reason'),'');
  v_status text;
  v_keys text[];
begin
  if v_user is null or p_mode is null or p_mode not in ('sales','office') then raise exception 'forbidden' using errcode='42501'; end if;
  if (p_mode='sales' and not public.gw_is_sales(p_tenant))
     or (p_mode='office' and not public.gw_sales_contract_office(p_tenant)) then raise exception 'forbidden' using errcode='42501'; end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'invalid_payload' using errcode='23514'; end if;
  v_keys := case when p_mode='sales' then array['contractType','requestedDueOn','plannedStartOn','note','reason']
    else array['status','assigneeId','contractType','requestedDueOn','plannedStartOn','artifactReference','employeeId','docOrderId','siteContractId','reason'] end;
  if exists(select 1 from jsonb_object_keys(p_payload) k where not k=any(v_keys)) then raise exception 'invalid_payload' using errcode='23514'; end if;
  if p_action is null or (p_mode='sales' and p_action not in ('create','resubmit','cancel'))
     or (p_mode='office' and p_action not in ('update','reopen','cancel')) then raise exception 'invalid_action' using errcode='23514'; end if;
  -- 同一提案を先にロック: 並行createでも一件、担当変更/アーカイブと競合しても最新値で判定。
  select * into v_p from public.gw_sales_proposals where id=p_proposal and tenant_id=p_tenant for update;
  if not found then raise exception 'forbidden' using errcode='42501'; end if;
  v_actor := public.gw_employee_id(p_tenant);
  if p_mode='sales' and not (public.gw_sales_is_manager(p_tenant)
      or (v_actor is not null and v_actor=v_p.sales_owner_id)) then raise exception 'forbidden' using errcode='42501'; end if;
  if p_action in ('create','resubmit','reopen') then
    if v_p.archived_at is not null or v_p.contact_stop or v_p.status in ('lost','stopped','closed_no_reply') then
      raise exception 'proposal_inactive' using errcode='23514'; end if;
    if public.gw_sales_contract_acceptance(v_p) is null or v_p.source_stage in ('不合格','見送り','辞退','不採用','失注','クローズ') then
      raise exception 'pass_required' using errcode='23514'; end if;
  end if;
  select * into v from public.gw_sales_contract_requests where tenant_id=p_tenant and proposal_id=p_proposal for update;
  if p_action='create' and found then return jsonb_build_object('id',v.id,'version',v.version,'replayed',true); end if;
  if p_action<>'create' and not found then raise exception 'invalid_transition' using errcode='23514'; end if;
  if p_action<>'create' then
    if p_expected_version is null or p_expected_version<>v.version then raise exception 'version_conflict' using errcode='PT409'; end if;
    if char_length(coalesce(v_reason,'')) not between 3 and 1000 then raise exception 'reason_required' using errcode='23514'; end if;
  end if;
  v_old := v;
  if p_action='create' then
    v.id:=gen_random_uuid(); v.tenant_id:=p_tenant; v.proposal_id:=p_proposal;
    v.status:='requested'; v.version:=1; v.requested_by:=v_user; v.requested_at:=now();
  elsif p_action in ('resubmit','reopen') then
    if v.status not in ('cancelled','completed') then raise exception 'invalid_transition' using errcode='23514'; end if;
    v.status:='requested'; v.assignee_id:=null; v.artifact_reference:=null;
    -- Reopen/resubmit keeps existing document associations: no duplicate contract and no silent loss of a protected HR link.
    v.requested_by:=v_user; v.requested_at:=now();
  elsif p_action='cancel' then
    if v.status in ('completed','cancelled') then raise exception 'invalid_transition' using errcode='23514'; end if;
    v.status:='cancelled';
  elsif p_action='update' then
    v_status:=coalesce(p_payload->>'status',v.status);
    if not ((v.status='requested' and v_status in ('requested','in_progress'))
        or (v.status='in_progress' and v_status in ('in_progress','review'))
        or (v.status='review' and v_status in ('review','in_progress','completed'))) then
      raise exception 'invalid_transition' using errcode='23514'; end if;
    -- アーカイブ/見送り後の作成完了を防ぐ。既存依頼は取消・内容確認だけ可能。
    if ((v.status='requested' and v_status='in_progress') or (v.status='in_progress' and v_status='review') or v_status='completed')
      and (v_p.archived_at is not null or v_p.contact_stop or public.gw_sales_contract_acceptance(v_p) is null
      or v_p.status in ('lost','stopped','closed_no_reply') or v_p.source_stage in ('不合格','見送り','辞退','不採用','失注','クローズ')) then
      raise exception 'proposal_inactive' using errcode='23514'; end if;
    v.status:=v_status;
  end if;
  if p_action<>'cancel' then
    if p_payload?'contractType' then v.contract_type:=p_payload->>'contractType'; end if;
    if p_payload?'requestedDueOn' then
      if coalesce(p_payload->>'requestedDueOn','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid_date' using errcode='23514'; end if;
      v.requested_due_on:=(p_payload->>'requestedDueOn')::date;
    end if;
    if p_payload?'plannedStartOn' then
      if p_payload->>'plannedStartOn' is not null and p_payload->>'plannedStartOn' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid_date' using errcode='23514'; end if;
      v.planned_start_on:=(p_payload->>'plannedStartOn')::date;
    end if;
    if p_mode='sales' and p_payload?'note' then v.note:=nullif(btrim(p_payload->>'note'),''); end if;
    if p_mode='office' and p_action='update' then
      if p_payload?'assigneeId' then v.assignee_id:=(p_payload->>'assigneeId')::uuid; end if;
      if p_payload?'artifactReference' then v.artifact_reference:=nullif(btrim(p_payload->>'artifactReference'),''); end if;
      if p_payload?'employeeId' then v.employee_id:=(p_payload->>'employeeId')::uuid; end if;
      if p_payload?'docOrderId' then v.doc_order_id:=(p_payload->>'docOrderId')::uuid; end if;
      if p_payload?'siteContractId' then v.site_contract_id:=(p_payload->>'siteContractId')::uuid; end if;
    end if;
  end if;
  if v.contract_type is null or v.contract_type not in ('client_ses','bp_order','employment','contractor','needs_confirmation')
     or v.requested_due_on is null or char_length(coalesce(v.note,''))>2000
     or char_length(coalesce(v.artifact_reference,''))>2000 then raise exception 'invalid_payload' using errcode='23514'; end if;
  if p_action<>'cancel' and v.assignee_id is not null and not public.gw_sales_contract_office_member(p_tenant,v.assignee_id) then
    raise exception 'invalid_assignee' using errcode='23514'; end if;
  if p_action<>'cancel' and v.employee_id is not null and not exists(select 1 from public.gw_employees e where e.id=v.employee_id and e.tenant_id=p_tenant) then
    raise exception 'invalid_document_link' using errcode='23514'; end if;
  if p_action<>'cancel' and v.doc_order_id is not null and (v.employee_id is null
      or v.contract_type not in ('employment','contractor')
      or not exists(select 1 from public.gw_doc_orders d where d.id=v.doc_order_id and d.tenant_id=p_tenant and d.employee_id=v.employee_id
        and d.doc_kind=case when v.contract_type='employment' then 'employment' else 'other' end)) then
    raise exception 'invalid_document_link' using errcode='23514'; end if;
  -- HR書類IDは、人事台帳を扱えるOffice利用者だけが新しく紐付けられる。内容は返さない。
  if not public.gw_is_hr(p_tenant) and (v.doc_order_id is distinct from v_old.doc_order_id
      or (v_old.doc_order_id is not null and v.employee_id is distinct from v_old.employee_id)) then
    raise exception 'forbidden' using errcode='42501'; end if;
  if p_action<>'cancel' and v.site_contract_id is not null and (v.employee_id is null
      or not exists(select 1 from public.gw_site_contracts c where c.id=v.site_contract_id and c.tenant_id=p_tenant and c.employee_id=v.employee_id)) then
    raise exception 'invalid_document_link' using errcode='23514'; end if;
  if v.status='completed' and (v.contract_type='needs_confirmation' or v.assignee_id is null
      or char_length(btrim(coalesce(v.artifact_reference,'')))<10) then raise exception 'draft_required' using errcode='23514'; end if;
  v.updated_at:=now();
  if p_action='create' then
    insert into public.gw_sales_contract_requests select v.*;
  else
    v.version:=v.version+1;
    update public.gw_sales_contract_requests set contract_type=v.contract_type,status=v.status,
      requested_due_on=v.requested_due_on,planned_start_on=v.planned_start_on,note=v.note,assignee_id=v.assignee_id,
      artifact_reference=v.artifact_reference,employee_id=v.employee_id,doc_order_id=v.doc_order_id,site_contract_id=v.site_contract_id,
      version=v.version,requested_by=v.requested_by,requested_at=v.requested_at,updated_at=v.updated_at where id=v.id;
  end if;
  insert into public.gw_sales_contract_request_events(tenant_id,request_id,action,from_status,to_status,version,actor_id,actor_employee_id,reason,detail)
    values(p_tenant,v.id,p_action,v_old.status,v.status,v.version,v_user,v_actor,v_reason,
      jsonb_build_object('contractType',v.contract_type,'requestedDueOn',v.requested_due_on,'plannedStartOn',v.planned_start_on,
        'assigneeId',v.assignee_id,'artifactReference',v.artifact_reference,'employeeId',v.employee_id,
        'docOrderId',v.doc_order_id,'siteContractId',v.site_contract_id,'note',v.note));
  return jsonb_build_object('id',v.id,'version',v.version,'replayed',false);
end $$;

create or replace function public.gw_sales_contract_requests_read(p_tenant uuid,p_mode text,p_proposal uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_rows jsonb; v_count integer; v_members jsonb:='[]'::jsonb; v_actor uuid;
begin
  if (select auth.uid()) is null or p_mode is null or p_mode not in ('sales','office')
    or (p_mode='sales' and not public.gw_is_sales(p_tenant))
    or (p_mode='office' and not public.gw_sales_contract_office(p_tenant)) then raise exception 'forbidden' using errcode='42501'; end if;
  v_actor:=public.gw_employee_id(p_tenant);
  with picked as (
    select p.*,r.id as request_key,public.gw_sales_contract_acceptance(p) as evidence
      from public.gw_sales_proposals p left join public.gw_sales_contract_requests r on r.proposal_id=p.id and r.tenant_id=p.tenant_id
      where p.tenant_id=p_tenant and (p_proposal is null or p.id=p_proposal)
        and ((p_mode='office' and r.id is not null) or (p_mode='sales' and (r.id is not null
          or (p.archived_at is null and public.gw_sales_contract_acceptance(p) is not null))))
      order by coalesce(r.updated_at,p.updated_at) desc,p.id limit 1001
  ), limited as (select * from picked limit 1000)
  select (select count(*) from picked),coalesce(jsonb_agg(jsonb_build_object(
    'proposalId',p.id,'companyName',p.company_name,'title',p.title,'talentInitials',p.talent_initials,
    'sourceStage',p.source_stage,'sourceUrl',p.source_url,'salesStatus',p.status,'archived',p.archived_at is not null,
    'accepted',p.evidence is not null,'acceptedEvidence',p.evidence,
    'canRequest',p_mode='sales' and p.evidence is not null and p.archived_at is null and not p.contact_stop
      and p.status not in ('lost','stopped','closed_no_reply') and coalesce(p.source_stage,'') not in ('不合格','見送り','辞退','不採用','失注','クローズ')
      and (public.gw_sales_is_manager(p_tenant) or (v_actor is not null and v_actor=p.sales_owner_id)),
    'canCancelRequest',p_mode='sales' and r.id is not null and r.status not in ('completed','cancelled')
      and (public.gw_sales_is_manager(p_tenant) or (v_actor is not null and v_actor=p.sales_owner_id)),
    'request',case when r.id is null then null else jsonb_build_object(
      'id',r.id,'proposalId',r.proposal_id,'contractType',r.contract_type,'status',r.status,
      'requestedDueOn',r.requested_due_on,'plannedStartOn',r.planned_start_on,'note',r.note,
      'assigneeId',r.assignee_id,'assigneeName',a.display_name,'artifactReference',r.artifact_reference,
      'employeeId',case when p_mode='office' then r.employee_id else null end,
      'docOrderId',case when p_mode='office' and public.gw_is_hr(p_tenant) then r.doc_order_id else null end,
      'hasDocOrder',p_mode='office' and r.doc_order_id is not null,
      'siteContractId',case when p_mode='office' then r.site_contract_id else null end,
      'version',r.version,'requestedAt',r.requested_at,'requestedByName',u.display_name,'updatedAt',r.updated_at,
      'history',case when p_proposal is null then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('id',h.id,'action',h.action,'fromStatus',h.from_status,'toStatus',h.to_status,
          'version',h.version,'actorName',e.display_name,'reason',h.reason,'at',h.created_at) order by h.version desc)
        from (select * from public.gw_sales_contract_request_events where request_id=r.id and tenant_id=p_tenant order by version desc limit 100) h
        left join public.gw_employees e on e.id=h.actor_employee_id and e.tenant_id=p_tenant),'[]'::jsonb) end,
      'historyTruncated',p_proposal is not null and r.version>100) end) order by coalesce(r.updated_at,p.updated_at) desc,p.id),'[]'::jsonb)
    into v_count,v_rows from limited p left join public.gw_sales_contract_requests r on r.id=p.request_key and r.tenant_id=p_tenant
    left join public.gw_employees a on a.id=r.assignee_id and a.tenant_id=p_tenant
    left join public.gw_employees u on u.user_id=r.requested_by and u.tenant_id=p_tenant;
  if p_mode='office' then select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.display_name) order by e.display_name),'[]'::jsonb)
    into v_members from public.gw_employees e where e.tenant_id=p_tenant and public.gw_sales_contract_office_member(p_tenant,e.id); end if;
  return jsonb_build_object('rows',v_rows,'truncated',v_count>1000,'members',v_members,
    'canLinkHrDocs',p_mode='office' and public.gw_is_hr(p_tenant));
end $$;

revoke all on function public.gw_sales_contract_office(uuid),public.gw_sales_contract_office_member(uuid,uuid),
  public.gw_sales_contract_acceptance(public.gw_sales_proposals),public.gw_sales_contract_guard_source(),
  public.gw_sales_contract_request_action(uuid,uuid,text,text,integer,jsonb),public.gw_sales_contract_requests_read(uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.gw_sales_contract_office(uuid) to authenticated;
grant execute on function public.gw_sales_contract_request_action(uuid,uuid,text,text,integer,jsonb),
  public.gw_sales_contract_requests_read(uuid,text,uuid) to authenticated;
commit;
notify pgrst,'reload schema';
