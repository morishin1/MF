-- Personal planning only. No company career, evaluation, contract or task rows are changed.
begin;
create table public.gw_career_self_plans (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),
 employee_id uuid not null references public.gw_employees(id),user_id uuid not null references auth.users(id),
 plan jsonb not null default '{}' check(jsonb_typeof(plan)='object'),revision integer not null default 1 check(revision>0),
 updated_at timestamptz not null default now(),unique(tenant_id,employee_id)
);
create table public.gw_career_coach_turns (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),
 employee_id uuid not null references public.gw_employees(id),user_id uuid not null references auth.users(id),
 request_key uuid not null,draft_hash text not null check(draft_hash ~ '^[0-9a-f]{64}$'),
 question text not null check(length(question) between 1 and 1000),status text not null check(status in ('pending','done','failed')),
 advice jsonb,model text,usage jsonb,charge_yen numeric not null default 1 check(charge_yen>=0),
 created_at timestamptz not null default now(),finished_at timestamptz,
 unique(tenant_id,employee_id,request_key)
);
create index career_coach_budget on public.gw_career_coach_turns(tenant_id,created_at);
create index career_coach_self on public.gw_career_coach_turns(tenant_id,employee_id,user_id,created_at desc);
alter table public.gw_career_self_plans enable row level security;
alter table public.gw_career_coach_turns enable row level security;
revoke all on public.gw_career_self_plans,public.gw_career_coach_turns from public,anon,authenticated,service_role;
grant select,insert,update on public.gw_career_self_plans,public.gw_career_coach_turns to service_role;

create function public.gw_career_self_manage(p_tenant uuid,p_employee uuid,p_user uuid,p_action text,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p public.gw_career_self_plans;r public.gw_career_coach_turns;ts timestamptz:=now();
 day_start timestamptz:=date_trunc('day',now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
 month_start timestamptz:=date_trunc('month',now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
begin
 if p_action='claim' then perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||'career_coach',0)); end if;
 perform 1 from public.gw_employees where id=p_employee and tenant_id=p_tenant and user_id=p_user and status<>'left' for update;
 if not found then raise exception 'self_only'; end if;
 if p_action='save' then
  select * into p from public.gw_career_self_plans where tenant_id=p_tenant and employee_id=p_employee for update;
  if p.id is null then
   if (p_data->>'expectedRevision')::int is distinct from 0 then raise exception 'stale_plan'; end if;
   insert into public.gw_career_self_plans(tenant_id,employee_id,user_id,plan) values(p_tenant,p_employee,p_user,p_data->'plan') returning * into p;
  else
   if p.user_id is distinct from p_user or (p_data->>'expectedRevision')::int is distinct from p.revision then raise exception 'stale_plan'; end if;
   update public.gw_career_self_plans set plan=p_data->'plan',revision=revision+1,updated_at=ts where id=p.id returning * into p;
  end if;
  return to_jsonb(p);
 elsif p_action='claim' then
  select * into r from public.gw_career_coach_turns where tenant_id=p_tenant and employee_id=p_employee and request_key=(p_data->>'requestKey')::uuid;
  if found then
   if r.user_id<>p_user then raise exception 'self_only'; end if;
   return jsonb_build_object('replayed',true,'draftHash',r.draft_hash,'turn',to_jsonb(r));
  end if;
  if (select count(*) from public.gw_career_coach_turns where tenant_id=p_tenant and employee_id=p_employee and created_at>=day_start)>=5 then return '{"blocked":true,"reason":"daily"}'::jsonb; end if;
  -- Reserve 1 JPY per attempt, including an unknown/failed provider result. No automatic paid retries.
  if (select coalesce(sum(charge_yen),0) from public.gw_career_coach_turns where tenant_id=p_tenant and created_at>=month_start)+1>1000 then return '{"blocked":true,"reason":"budget"}'::jsonb; end if;
  insert into public.gw_career_coach_turns(tenant_id,employee_id,user_id,request_key,draft_hash,question,status)
   values(p_tenant,p_employee,p_user,(p_data->>'requestKey')::uuid,p_data->>'draftHash',p_data->>'question','pending') returning * into r;
  return jsonb_build_object('replayed',false,'turn',to_jsonb(r));
 elsif p_action='finish' then
  select * into r from public.gw_career_coach_turns where tenant_id=p_tenant and employee_id=p_employee and user_id=p_user and request_key=(p_data->>'requestKey')::uuid for update;
  if not found then raise exception 'self_only'; end if;
  if r.status<>'pending' then return to_jsonb(r); end if;
  if p_data->>'status' not in ('done','failed') then raise exception 'invalid_status'; end if;
  update public.gw_career_coach_turns set status=p_data->>'status',finished_at=ts,
    advice=case when p_data->>'status'='done' then p_data->'advice' else null end,model=p_data->>'model',usage=p_data->'usage',
    charge_yen=case when p_data->>'status'='done' then greatest(0,coalesce((p_data->>'estimatedYen')::numeric,1)) else 1 end
   where id=r.id returning * into r;return to_jsonb(r);
 end if;
 raise exception 'invalid_action';
end $$;
revoke all on function public.gw_career_self_manage(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.gw_career_self_manage(uuid,uuid,uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
