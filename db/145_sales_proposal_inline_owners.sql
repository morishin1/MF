-- Sales 担当者プルダウンと管理者の全件一括操作。
-- 前提：db/142_sales_team_proposals_bulk.sql
-- 「提案担当」は元の提案担当で保持。handoff_stage と current sales_owner は別。
begin;
do $$
begin
  if to_regclass('public.gw_sales_proposals') is null
     or to_regprocedure('public.gw_sales_bulk_proposals(uuid[],text,text,text)') is null
     or to_regprocedure('public.gw_sales_is_manager(uuid)') is null then
    raise exception 'requires db/142_sales_team_proposals_bulk.sql';
  end if;
end $$;

alter table public.gw_sales_proposals
  add column if not exists proposal_owner_id uuid references public.gw_employees(id) on delete set null;

-- すでにCSへ引継いだものは handoffs の提案担当を採用。
-- 引継ぎ履歴のない進行中行は担当履歴を推測せず、未登録のまま扱う。
update public.gw_sales_proposals p
set proposal_owner_id = coalesce(
  (select h.from_owner_id from public.gw_sales_proposal_handoffs h
   where h.proposal_id=p.id and h.from_stage='proposal'
   order by h.created_at asc limit 1),
  case when coalesce(p.handoff_stage,'proposal')='proposal' then p.sales_owner_id else null end
)
where p.proposal_owner_id is null;

-- 起点の担当者が空の場合でも、正式引継ぎで current sales_owner が
-- 上書きされる前に、起点担当を残す。ENGER内の元提案者の文字名は変更しない。
create or replace function public.gw_sales_keep_proposal_owner()
returns trigger language plpgsql set search_path='' as $$
begin
  if TG_OP = 'INSERT' then
    if new.proposal_owner_id is null and coalesce(new.handoff_stage,'proposal')='proposal' then
      new.proposal_owner_id := new.sales_owner_id;
    end if;
  elsif new.proposal_owner_id is null and old.proposal_owner_id is null
    and coalesce(old.handoff_stage,'proposal')='proposal' then
    new.proposal_owner_id := old.sales_owner_id;
  end if;
  return new;
end $$;
drop trigger if exists gw_sales_keep_proposal_owner_tr on public.gw_sales_proposals;
create trigger gw_sales_keep_proposal_owner_tr
before insert or update of sales_owner_id,handoff_stage on public.gw_sales_proposals
for each row execute function public.gw_sales_keep_proposal_owner();

-- 一括操作は従来の本人に加えて管理者（CEO/管理者/manager）も実行可。
-- 同じ 50件上限・事前ロック・アーカイブ・監査記録を維持。
create or replace function public.gw_sales_bulk_proposals(
  p_ids uuid[], p_action text, p_service text default null, p_title text default null
) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v public.gw_sales_proposals%rowtype;
  v_user uuid := (select auth.uid());
  v_owner uuid;
  v_tenant uuid;
  v_count int := 0;
  v_ids uuid[];
  v_note text;
begin
  if v_user is null or p_ids is null or cardinality(p_ids) < 1 or cardinality(p_ids) > 50 then
    raise exception 'invalid_selection' using errcode='23514';
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) <> cardinality(p_ids) then
    raise exception 'duplicate_or_null_selection' using errcode='23514';
  end if;
  if p_action not in ('archive','restore','edit') or p_action is null then
    raise exception 'invalid_action' using errcode='23514';
  end if;
  if p_action = 'edit' then
    if (p_service is null and p_title is null)
       or (p_service is not null and char_length(btrim(p_service)) not between 1 and 100)
       or (p_title is not null and (cardinality(v_ids) <> 1 or char_length(btrim(p_title)) not between 1 and 200)) then
      raise exception 'invalid_edit_fields' using errcode='23514';
    end if;
  end if;
  -- 対象のロック、テナントと所有者検証を先に全部実行し、部分成功を防ぐ。
  for v in select * from public.gw_sales_proposals where id = any(v_ids) order by id for update loop
    if v_tenant is null then v_tenant := v.tenant_id; end if;
    if v.tenant_id <> v_tenant or not public.gw_is_sales(v.tenant_id)
       or not (public.gw_sales_is_manager(v.tenant_id)
         or public.gw_sales_proposal_editable(v.tenant_id,v.sales_owner_id)) then
      raise exception 'forbidden' using errcode='42501';
    end if;
    if p_action = 'edit' and (v.archived_at is not null or (p_title is not null and v.source_system = 'enger')) then
      raise exception 'cannot_edit_archived_or_source_title' using errcode='23514';
    end if;
    if (p_action = 'archive' and v.archived_at is not null)
      or (p_action = 'restore' and v.archived_at is null) then
      raise exception 'invalid_archive_state' using errcode='23514';
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count <> cardinality(v_ids) then
    raise exception 'selection_not_found' using errcode='42501';
  end if;
  v_owner := public.gw_employee_id(v_tenant);
  if p_action = 'archive' then
    update public.gw_sales_proposals set archived_at=now(), archived_by=v_user, updated_by=v_user, updated_at=now()
    where id=any(v_ids);
    update public.gw_sales_proposal_tasks
      set status='canceled', cancel_reason='提案をアーカイブしたため'
      where proposal_id=any(v_ids) and status='open';
    v_note := '提案をアーカイブ';
  elsif p_action = 'restore' then
    update public.gw_sales_proposals set archived_at=null, archived_by=null, updated_by=v_user, updated_at=now()
    where id=any(v_ids);
    v_note := '提案をアーカイブから復元（タスクは自動再開しません）';
  else
    update public.gw_sales_proposals set
      service=coalesce(btrim(p_service),service),
      title=coalesce(btrim(p_title),title), updated_by=v_user, updated_at=now() where id=any(v_ids);
    v_note := '提案情報を編集';
  end if;
  insert into public.gw_sales_proposal_activities(
    tenant_id,proposal_id,company_id,kind,occurred_at,employee_id,created_by,note,detail)
  select p.tenant_id,p.id,p.company_id,'memo',now(),v_owner,v_user,v_note,
    jsonb_build_object('action',p_action,'bulkCount',v_count)
    from public.gw_sales_proposals p where p.id=any(v_ids);
  return v_count;
end $$;
revoke all on function public.gw_sales_bulk_proposals(uuid[],text,text,text) from public, anon;
grant execute on function public.gw_sales_bulk_proposals(uuid[],text,text,text) to authenticated;




-- すべてのSalesメンバーが一覧から各役割の担当者を変更できる。
-- 正式引継ぎ（handoff_stage）は進めない。新担当は履歴に残す。
-- 同時操作は以前の担当IDを比較して 409 にできるようにする。
create or replace function public.gw_sales_set_proposal_stage_owner(
  p_proposal uuid, p_stage text, p_owner uuid, p_expected_owner uuid
) returns boolean
language plpgsql security definer set search_path=''
as $$
declare
  v public.gw_sales_proposals%rowtype;
  v_old uuid;
  v_actor uuid;
  v_current_stage text;
  v_task_moves integer := 0;
begin
  if (select auth.uid()) is null or p_stage not in ('proposal','cs','closing') or p_stage is null then
    raise exception 'invalid_stage_or_session' using errcode='42501';
  end if;
  select * into v from public.gw_sales_proposals where id=p_proposal for update;
  if not found then raise exception 'proposal_not_found' using errcode='42501'; end if;
  v_actor := public.gw_employee_id(v.tenant_id);
  if not public.gw_is_sales(v.tenant_id) or v_actor is null then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if v.archived_at is not null then
    raise exception 'proposal_archived' using errcode='23514';
  end if;
  if p_owner is not null and not public.gw_sales_employee_ok(p_owner, v.tenant_id) then
    raise exception 'invalid_member' using errcode='23514';
  end if;
  v_current_stage := coalesce(v.handoff_stage,'proposal');
  v_old := case p_stage
    when 'proposal' then v.proposal_owner_id
    when 'cs' then v.cs_owner_id
    else v.closing_owner_id end;
  if v_old is distinct from p_expected_owner then
    raise exception 'owner_changed' using errcode='40001';
  end if;
  if v_old is not distinct from p_owner then return false; end if;
  if p_owner is null and p_stage = v_current_stage then
    raise exception 'current_owner_required' using errcode='23514';
  end if;

  if p_stage = 'proposal' then
    update public.gw_sales_proposals set proposal_owner_id=p_owner,
      sales_owner_id=case when v_current_stage='proposal' then p_owner else sales_owner_id end,
      updated_by=(select auth.uid()),updated_at=now() where id=p_proposal;
  elsif p_stage = 'cs' then
    update public.gw_sales_proposals set cs_owner_id=p_owner,
      sales_owner_id=case when v_current_stage='cs' then p_owner else sales_owner_id end,
      updated_by=(select auth.uid()),updated_at=now() where id=p_proposal;
  else
    update public.gw_sales_proposals set closing_owner_id=p_owner,
      sales_owner_id=case when v_current_stage='closing' then p_owner else sales_owner_id end,
      updated_by=(select auth.uid()),updated_at=now() where id=p_proposal;
  end if;
  if v_current_stage=p_stage then
    update public.gw_sales_proposal_tasks set assignee_id=p_owner
      where proposal_id=p_proposal and status='open' and kind<>'manager_review'
      and (assignee_id is not distinct from v.sales_owner_id);
    get diagnostics v_task_moves=row_count;
  end if;

  insert into public.gw_sales_proposal_activities(
      tenant_id,proposal_id,company_id,kind,occurred_at,employee_id,created_by,note,detail)
    values(v.tenant_id,p_proposal,v.company_id,'assign',now(),v_actor,(select auth.uid()),
      case p_stage when 'proposal' then '提案担当を変更' when 'cs' then 'CS担当を変更'
        else 'クロージング担当を変更' end,
      jsonb_build_object('stage',p_stage,'from',v_old,'to',p_owner,'taskMoves',v_task_moves));
  return true;
end $$;
revoke all on function public.gw_sales_set_proposal_stage_owner(uuid,text,uuid,uuid) from public,anon;
grant execute on function public.gw_sales_set_proposal_stage_owner(uuid,text,uuid,uuid) to authenticated;
comment on function public.gw_sales_set_proposal_stage_owner(uuid,text,uuid,uuid) is
  'Salesメンバーは担当変更のみ可能。工程の正式引継ぎは従来の操作で行い、監査履歴を保存する';
comment on function public.gw_sales_bulk_proposals(uuid[],text,text,text) is
  '提案の本人またはSales管理側が最大50件編集・アーカイブ・復元。履歴・監査記録は残る';

-- 管理者は正式引継ぎ・共同担当の設定も可能。既存の工程/証跡のガードは保持。
create or replace function public.gw_sales_transfer_proposal_owner(
  p_proposal uuid, p_to_stage text, p_to_owner uuid,
  p_reason text, p_decision text, p_next_action text, p_next_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_tenant uuid; v_owner uuid; v_archived timestamptz;
begin
  select tenant_id, sales_owner_id, archived_at into v_tenant, v_owner, v_archived
  from public.gw_sales_proposals where id = p_proposal for update;
  if v_tenant is null or v_archived is not null or not public.gw_is_sales(v_tenant) or not (public.gw_sales_is_manager(v_tenant) or public.gw_sales_proposal_editable(v_tenant,v_owner)) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  return public.gw_sales_transfer_proposal(p_proposal,p_to_stage,p_to_owner,p_reason,p_decision,p_next_action,p_next_at);
end $$;
revoke all on function public.gw_sales_transfer_proposal_owner(uuid,text,uuid,text,text,text,timestamptz) from public, anon;
grant execute on function public.gw_sales_transfer_proposal_owner(uuid,text,uuid,text,text,text,timestamptz) to authenticated;


create or replace function public.gw_sales_set_supporters(
  p_proposal uuid, p_stage text, p_members uuid[]
) returns integer
language plpgsql security definer set search_path=''
as $$
declare
  v_tenant uuid;
  v_owner uuid;
  v_old uuid[];
  v_member uuid;
  v_count integer;
begin
  select tenant_id,sales_owner_id into v_tenant,v_owner
    from public.gw_sales_proposals where id=p_proposal and archived_at is null for update;
  if v_tenant is null or not public.gw_is_sales(v_tenant) or not (public.gw_sales_is_manager(v_tenant) or public.gw_sales_proposal_editable(v_tenant,v_owner)) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_stage not in ('proposal','cs','closing') or p_stage is null
     or p_members is null or cardinality(p_members)>10 then
    raise exception 'invalid_members_or_stage' using errcode='23514';
  end if;
  if exists (select 1 from unnest(p_members) x where x is null) or
     (select count(distinct x) from unnest(p_members) x) <> cardinality(p_members) then
    raise exception 'invalid_duplicate_members' using errcode='23514';
  end if;
  for v_member in select unnest(p_members) loop
    if not public.gw_sales_employee_ok(v_member,v_tenant) then
      raise exception 'invalid_member' using errcode='23514';
    end if;
  end loop;
  select coalesce(array_agg(employee_id order by employee_id),'{}'::uuid[]) into v_old
    from public.gw_sales_proposal_supporters where proposal_id=p_proposal and stage=p_stage;
  delete from public.gw_sales_proposal_supporters
    where proposal_id=p_proposal and stage=p_stage
      and employee_id <> all(p_members);
  insert into public.gw_sales_proposal_supporters(tenant_id,proposal_id,stage,employee_id,added_by)
    select v_tenant,p_proposal,p_stage,member,(select auth.uid()) from unnest(p_members) member
    on conflict (proposal_id,stage,employee_id) do nothing;
  get diagnostics v_count=row_count;
  insert into public.gw_sales_proposal_activities(tenant_id,proposal_id,kind,employee_id,created_by,note,detail)
    values(v_tenant,p_proposal,'memo',public.gw_employee_id(v_tenant),(select auth.uid()),
      '共同担当者を更新',jsonb_build_object('stage',p_stage,'before',v_old,'after',p_members));
  return cardinality(p_members);
end $$;
revoke all on function public.gw_sales_set_supporters(uuid,text,uuid[]) from public, anon;
grant execute on function public.gw_sales_set_supporters(uuid,text,uuid[]) to authenticated;


commit;
notify pgrst,'reload schema';
