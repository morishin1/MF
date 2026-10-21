-- db/142: Sales 提案管理の「チーム全件閲覧・担当者だけ編集・複数選択・アーカイブ」
-- db/138, 140, 141 適用後に実行。既存提案・履歴は削除しない。
begin;
do $$
begin
  if to_regclass('public.gw_sales_proposal_handoffs') is null
     or to_regprocedure('public.gw_sales_transfer_proposal(uuid,text,uuid,text,text,text,timestamptz)') is null then
    raise exception 'db/142 needs db/138, db/140, db/141';
  end if;
end $$;

alter table public.gw_sales_proposals
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id) on delete set null;
create index if not exists idx_gw_sales_proposals_active_tenant
  on public.gw_sales_proposals(tenant_id, archived_at, updated_at desc);

-- 見る：テナント内のSales利用者は全員。書く：現在の担当者だけ。
-- 他メンバーの窓口・行動履歴・タスクも見ることは可能だが、更新は許さない。
create or replace function public.gw_sales_proposal_visible(p_tenant uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select public.gw_is_sales(p_tenant)
$$;
create or replace function public.gw_sales_proposal_editable(p_tenant uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null
    and public.gw_is_sales(p_tenant)
    and p_owner is not null and p_owner = public.gw_employee_id(p_tenant)
$$;
create or replace function public.gw_sales_proposal_editable_id(p_proposal uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.gw_sales_proposals p
    where p.id = p_proposal and p.archived_at is null
      and public.gw_sales_proposal_editable(p.tenant_id, p.sales_owner_id)
  )
$$;
revoke all on function public.gw_sales_proposal_editable(uuid,uuid) from public;
revoke all on function public.gw_sales_proposal_editable_id(uuid) from public;
grant execute on function public.gw_sales_proposal_editable(uuid,uuid) to authenticated, service_role;
grant execute on function public.gw_sales_proposal_editable_id(uuid) to authenticated, service_role;

-- 既存の「担当者だけ閲覧」は全員閲覧に。子表のSELECTは visible_id を通じて全員閲覧。
drop policy if exists gw_sales_proposals_select on public.gw_sales_proposals;
create policy gw_sales_proposals_select on public.gw_sales_proposals
  for select to authenticated using (public.gw_is_sales(tenant_id)
    and public.gw_sales_proposal_visible(tenant_id, sales_owner_id));
drop policy if exists gw_sales_proposals_update on public.gw_sales_proposals;
create policy gw_sales_proposals_update on public.gw_sales_proposals
  for update to authenticated
  using (archived_at is null and public.gw_sales_proposal_editable(tenant_id, sales_owner_id))
  with check (archived_at is null and public.gw_sales_proposal_editable(tenant_id, sales_owner_id));
drop policy if exists gw_sales_proposals_insert on public.gw_sales_proposals;
create policy gw_sales_proposals_insert on public.gw_sales_proposals
  for insert to authenticated with check (public.gw_sales_proposal_editable(tenant_id, sales_owner_id));

drop policy if exists gw_sales_proposal_activities_insert on public.gw_sales_proposal_activities;
create policy gw_sales_proposal_activities_insert on public.gw_sales_proposal_activities
  for insert to authenticated with check (
    public.gw_is_sales(tenant_id) and public.gw_sales_proposal_editable_id(proposal_id)
    and (employee_id is null or employee_id = public.gw_employee_id(tenant_id)));

drop policy if exists gw_sales_proposal_tasks_insert on public.gw_sales_proposal_tasks;
create policy gw_sales_proposal_tasks_insert on public.gw_sales_proposal_tasks
  for insert to authenticated with check (
    public.gw_is_sales(tenant_id) and public.gw_sales_proposal_editable_id(proposal_id));
drop policy if exists gw_sales_proposal_tasks_update on public.gw_sales_proposal_tasks;
create policy gw_sales_proposal_tasks_update on public.gw_sales_proposal_tasks
  for update to authenticated
  using (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_editable_id(proposal_id))
  with check (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_editable_id(proposal_id));

-- 専用の引継ぎRPC：管理者も「他人の担当案件」を直接移動しない。
-- db/141の関数定義にあるアクセス条件のみの書き換えは再定義せず、
-- 既存RPCに対して、引継ぎ先に渡す前に権限を確認するラッパーを新設。
-- 旧RPCは authenticated から取り上げ、専用ラッパーだけ使わせる。
revoke all on function public.gw_sales_transfer_proposal(uuid,text,uuid,text,text,timestamptz) from public, anon, authenticated;
-- db/141の function は SECURITY DEFINER なので内部呼出しは可能。
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
  if v_tenant is null or v_archived is not null or not public.gw_sales_proposal_editable(v_tenant,v_owner) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  return public.gw_sales_transfer_proposal(p_proposal,p_to_stage,p_to_owner,p_reason,p_decision,p_next_action,p_next_at);
end $$;
revoke all on function public.gw_sales_transfer_proposal_owner(uuid,text,uuid,text,text,text,timestamptz) from public, anon;
grant execute on function public.gw_sales_transfer_proposal_owner(uuid,text,uuid,text,text,text,timestamptz) to authenticated;

-- 一括操作：最大50件・本人が現在担当する同一テナントの案件だけ。1件でも権限違反なら全部失敗。
-- 削除は「アーカイブ」。履歴は残し、未完了のフォローは停止。復元可能。
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
    if v.tenant_id <> v_tenant or not public.gw_sales_proposal_editable(v.tenant_id,v.sales_owner_id) then
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


-- 任意の追加担当：主担当は変えない。各役割に補助担当（最大10名）を付けられる。
create table if not exists public.gw_sales_proposal_supporters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  proposal_id uuid not null references public.gw_sales_proposals(id),
  stage text not null check (stage in ('proposal','cs','closing')),
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(proposal_id,stage,employee_id)
);
create index if not exists idx_gw_sales_supporters_proposal
  on public.gw_sales_proposal_supporters(proposal_id,stage);
alter table public.gw_sales_proposal_supporters enable row level security;
drop policy if exists gw_sales_supporters_select on public.gw_sales_proposal_supporters;
create policy gw_sales_supporters_select on public.gw_sales_proposal_supporters
  for select to authenticated
  using (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id));
grant select on public.gw_sales_proposal_supporters to authenticated;
revoke insert, update, delete on public.gw_sales_proposal_supporters from authenticated, anon;

-- 補助担当の追加/除外は、現在担当する本人だけ。記録は追記しておく。
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
  if v_tenant is null or not public.gw_sales_proposal_editable(v_tenant,v_owner) then
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
    values(v_tenant,p_proposal,'memo',v_owner,(select auth.uid()),
      '共同担当者を更新',jsonb_build_object('stage',p_stage,'before',v_old,'after',p_members));
  return cardinality(p_members);
end $$;
revoke all on function public.gw_sales_set_supporters(uuid,text,uuid[]) from public, anon;
grant execute on function public.gw_sales_set_supporters(uuid,text,uuid[]) to authenticated;

comment on function public.gw_sales_bulk_proposals(uuid[],text,text,text) is
  '現在の提案担当本人のみが最大50件を編集・アーカイブ・復元する。元データ・履歴は削除しない(db/142)';
commit;
notify pgrst, 'reload schema';
