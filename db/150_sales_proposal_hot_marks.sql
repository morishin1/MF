-- Manual fire marker. Additive; no stage, task, probability or notification changes.
begin;
do $$
begin
 if to_regclass('public.gw_sales_proposals') is null
  or to_regclass('public.gw_sales_proposal_activities') is null
  or to_regprocedure('public.gw_is_sales(uuid)') is null
  or to_regprocedure('public.gw_sales_is_manager(uuid)') is null
  or to_regprocedure('public.gw_sales_proposal_editable(uuid,uuid)') is null
  or to_regprocedure('public.gw_employee_id(uuid)') is null then
  raise exception 'Sales proposal permissions/schema must be applied before db/150';
 end if;
end $$;
create table if not exists public.gw_sales_proposal_hot_marks (
 proposal_id uuid primary key references public.gw_sales_proposals(id) on delete cascade,
 tenant_id uuid not null references public.tenants(id),
 is_hot boolean not null default false,
 version integer not null default 0 check(version >= 0),
 updated_at timestamptz not null default now(),
 updated_by uuid not null
);
alter table public.gw_sales_proposal_hot_marks enable row level security;
revoke all on public.gw_sales_proposal_hot_marks from public, anon, authenticated;
grant select on public.gw_sales_proposal_hot_marks to authenticated, service_role;
drop policy if exists sales_hot_read on public.gw_sales_proposal_hot_marks;
create policy sales_hot_read on public.gw_sales_proposal_hot_marks for select to authenticated
 using (public.gw_is_sales(tenant_id));
create or replace function public.gw_sales_set_proposal_hot(p_proposal uuid,p_hot boolean,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 p public.gw_sales_proposals%rowtype;
 m public.gw_sales_proposal_hot_marks%rowtype;
begin
 if auth.uid() is null or p_hot is null or p_expected_version is null or p_expected_version < 0 then
  raise exception 'invalid_input' using errcode='42501';
 end if;
 select * into p from public.gw_sales_proposals where id=p_proposal for update;
 if not found or not coalesce(public.gw_is_sales(p.tenant_id),false)
  or not coalesce((public.gw_sales_is_manager(p.tenant_id) or public.gw_sales_proposal_editable(p.tenant_id,p.sales_owner_id)),false) then
  raise exception 'forbidden' using errcode='42501';
 end if;
 if p.archived_at is not null then raise exception 'archived' using errcode='23514'; end if;
 select * into m from public.gw_sales_proposal_hot_marks where proposal_id=p.id;
 if coalesce(m.version,0) <> p_expected_version then raise exception 'hot_changed' using errcode='40001'; end if;
 if coalesce(m.is_hot,false) = p_hot then
  return jsonb_build_object('isHot',p_hot,'version',coalesce(m.version,0));
 end if;
 insert into public.gw_sales_proposal_hot_marks(proposal_id,tenant_id,is_hot,version,updated_by)
 values(p.id,p.tenant_id,p_hot,coalesce(m.version,0)+1,auth.uid())
 on conflict(proposal_id) do update set is_hot=excluded.is_hot,version=excluded.version,updated_by=excluded.updated_by,updated_at=now()
 returning * into m;
 insert into public.gw_sales_proposal_activities(tenant_id,proposal_id,company_id,kind,occurred_at,employee_id,created_by,note,detail)
 values(p.tenant_id,p.id,p.company_id,'memo',now(),public.gw_employee_id(p.tenant_id),auth.uid(),
  case when p_hot then 'ホットマークを付けました' else 'ホットマークを外しました' end,
  jsonb_build_object('action','hot_mark','isHot',p_hot,'version',m.version));
 return jsonb_build_object('isHot',m.is_hot,'version',m.version);
end $$;
revoke all on function public.gw_sales_set_proposal_hot(uuid,boolean,integer) from public,anon;
grant execute on function public.gw_sales_set_proposal_hot(uuid,boolean,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
