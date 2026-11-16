-- HR-owned participation, learning goals and reviews only. LMS activity stays in lms.*.
create table public.gw_hr_learning (
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 applicant_id uuid not null,
 version integer not null default 1 check(version > 0),
 participation boolean,
 lms_user_id uuid,
 lms_email text,
 plan jsonb,
 reviews jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now(),
 updated_by uuid not null references auth.users(id),
 primary key(tenant_id,applicant_id),
 foreign key(tenant_id,applicant_id) references public.gw_hr_applicants(tenant_id,id) on delete cascade,
 check(plan is null or jsonb_typeof(plan)='object'),
 check(jsonb_typeof(reviews)='object')
);
alter table public.gw_hr_learning enable row level security;
revoke all on public.gw_hr_learning from public,anon,authenticated;
grant select on public.gw_hr_learning to authenticated;
grant all on public.gw_hr_learning to service_role;
create policy recruiting_read on public.gw_hr_learning for select to authenticated using(public.gw_is_recruiting(tenant_id));

-- Serialize CAS against an applicant lock. State + timeline + audit commit together.
create function public.gw_hr_save_learning(p_tenant uuid,p_applicant uuid,p_actor uuid,p_expected integer,p_action text,p_value jsonb)
returns public.gw_hr_learning language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.gw_hr_learning; before_value jsonb; after_value jsonb;
begin
 perform 1 from public.gw_hr_applicants where tenant_id=p_tenant and id=p_applicant for update;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into r from public.gw_hr_learning where tenant_id=p_tenant and applicant_id=p_applicant for update;
 if coalesce(r.version,0)<>p_expected then raise exception 'version_conflict' using errcode='40001'; end if;
 before_value=to_jsonb(r);
 if p_action not in ('participation','plan','review') then raise exception 'invalid_action'; end if;
 if r.applicant_id is null then
  insert into public.gw_hr_learning(tenant_id,applicant_id,updated_by) values(p_tenant,p_applicant,p_actor) returning * into r;
 else r.version=r.version+1;
 end if;
 if p_action='participation' then
  r.participation=(p_value->>'participation')::boolean;
  -- Never replace an established LMS identity by another account.
  if r.lms_user_id is not null and p_value->>'userId' is not null and r.lms_user_id<>(p_value->>'userId')::uuid then raise exception 'identity_conflict'; end if;
  r.lms_user_id=coalesce(r.lms_user_id,(p_value->>'userId')::uuid);
  r.lms_email=coalesce(r.lms_email,p_value->>'email');
 elsif p_action='plan' then
  if r.reviews<>'{}'::jsonb and (r.plan->>'startOn') is distinct from (p_value->>'startOn') then raise exception 'reviewed_plan_dates_locked'; end if;
  r.plan=p_value;
 else
  r.reviews=jsonb_set(r.reviews,array[p_value->>'checkpoint'],p_value->'evaluation',true);
 end if;
 r.updated_at=clock_timestamp(); r.updated_by=p_actor;
 update public.gw_hr_learning set version=r.version,participation=r.participation,lms_user_id=r.lms_user_id,lms_email=r.lms_email,plan=r.plan,reviews=r.reviews,updated_at=r.updated_at,updated_by=r.updated_by where tenant_id=p_tenant and applicant_id=p_applicant;
 after_value=to_jsonb(r);
 insert into public.gw_hr_timeline(tenant_id,applicant_id,event_key,label,detail,created_by)
 values(p_tenant,p_applicant,'learning_'||p_action,'育成・評価を更新',jsonb_build_object('before',before_value,'after',after_value)::text,p_actor);
 insert into public.gw_activity_log(tenant_id,actor_id,action,target,detail)
 values(p_tenant,p_actor,'hr.learning.'||p_action,'hr_applicant:'||p_applicant,jsonb_build_object('version',r.version,'action',p_action));
 return r;
end $$;
revoke all on function public.gw_hr_save_learning(uuid,uuid,uuid,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.gw_hr_save_learning(uuid,uuid,uuid,integer,text,jsonb) to service_role;
