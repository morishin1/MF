-- PROPOSAL ONLY / 未適用。代表・DB管理者の個別承認前に実行しない。
-- GW正本: phone は手入力受付、email/form は原本の ID だけ参照。
-- 原本・既読・通知・権限・メール設定は一切変更しない。ECは対象外。
-- 前提: gw_employees, gw_role_grants, gw_app_grants と marketing grant 制約。
-- API が本人トークンで原本権限を再確認した後、service_role だけが原子的RPCを呼ぶ。
-- public/authenticated に権限を付けない。担当の追加は原本の閲覧権限を増やさない。
begin;
create table if not exists public.gw_marketing_intake (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 channel text not null check(channel in ('phone','email','form')),
 biz text not null check(biz in ('mugen','space','site')),
 source_type text,
 source_id uuid,
 phone_name text,
 phone_contact text,
 phone_email text,
 email_pending boolean not null default false,
 phone_subject text,
 callback_wish text,
 received_at timestamptz,
 received_by uuid not null references auth.users(id),
 owner_employee_id uuid not null references public.gw_employees(id),
 next_action text not null check(length(btrim(next_action)) between 1 and 1000),
 due_at timestamptz not null,
 state text not null default 'open' check(state in ('open','done')),
 result text not null default '' check(length(result)<=2000),
 version integer not null default 1 check(version>0),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(phone_email is null or (length(phone_email)<=254 and length(split_part(phone_email,'@',1))<=64
   and phone_email=lower(phone_email)
   and phone_email ~ '^[a-z0-9_%+-]+(\.[a-z0-9_%+-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')),
 check(channel<>'phone' or biz<>'space' or phone_email is not null or email_pending),
 check(not email_pending or (channel='phone' and biz='space' and phone_email is null and state='open')),
 check(state<>'done' or length(btrim(result))>0),
 check((channel='phone' and source_type is null and source_id is null
   and phone_name is not null and phone_contact is not null and phone_subject is not null
   and length(btrim(phone_name)) between 1 and 100 and length(btrim(phone_contact)) between 1 and 254
   and length(btrim(phone_subject)) between 1 and 2000 and length(coalesce(callback_wish,''))<=500 and received_at is not null)
  or (channel in ('email','form') and source_type is not null and source_id is not null
   and phone_email is null and phone_name is null and phone_contact is null and phone_subject is null and callback_wish is null)),
 check(channel='phone' or (channel='email' and source_type='hr_mail')
   or (source_type in ('hr_lead','mugen_course') and biz='mugen')
   or (source_type='space_inquiry' and biz='space') or (source_type='site_contact' and biz='site'))
);
create unique index if not exists gw_marketing_intake_original_unique
 on public.gw_marketing_intake(tenant_id,source_type,source_id) where source_type is not null;
create index if not exists gw_marketing_intake_work on public.gw_marketing_intake(tenant_id,state,due_at);
create table if not exists public.gw_marketing_intake_events (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 intake_id uuid not null references public.gw_marketing_intake(id),
 request_id uuid not null,
 request_fingerprint text not null,
 kind text not null check(kind in ('created','updated','completed','reopened','duplicate')),
 actor_id uuid not null references auth.users(id),
 detail jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 unique(tenant_id,request_id)
);
alter table public.gw_marketing_intake enable row level security;
alter table public.gw_marketing_intake_events enable row level security;
revoke all on public.gw_marketing_intake,public.gw_marketing_intake_events from public,anon,authenticated;
grant select,insert,update on public.gw_marketing_intake to service_role;
grant select,insert on public.gw_marketing_intake_events to service_role;

-- This helper is service-only too. owner is implicit; Office/HR roles do not derive Marketing.
create or replace function public.gw_marketing_intake_employee_allowed(p_tenant uuid,p_employee uuid)
returns boolean language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from public.gw_employees e where e.id=p_employee and e.tenant_id=p_tenant
  and e.status in ('active','leaving')
  and not(e.status='leaving' and e.left_on is not null and e.left_on < (now() at time zone 'Asia/Tokyo')::date)
  and (exists(select 1 from public.gw_role_grants g where g.employee_id=e.id and g.tenant_id=p_tenant and g.role='owner')
    or exists(select 1 from public.gw_app_grants a where a.employee_id=e.id and a.tenant_id=p_tenant and a.app_key='marketing')));
$$;
revoke all on function public.gw_marketing_intake_employee_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.gw_marketing_intake_employee_allowed(uuid,uuid) to service_role;

create or replace function public.gw_marketing_intake_mutate(
 p_tenant uuid,p_actor uuid,p_employee uuid,p_action text,p_request_id uuid,
 p_id uuid,p_expected_version integer,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
 v public.gw_marketing_intake%rowtype;
 old_v public.gw_marketing_intake%rowtype;
 ev public.gw_marketing_intake_events%rowtype;
 owner_id uuid;
 request_hash text;
 event_kind text;
 event_detail jsonb;
 is_owner boolean;
begin
 if p_tenant is null or p_actor is null or p_employee is null or p_request_id is null
  or p_action is null or p_action not in ('create','update') or p_payload is null or jsonb_typeof(p_payload)<>'object'
  or octet_length(p_payload::text)>24000 then
  return jsonb_build_object('ok',false,'error','invalid_request','status',400);
 end if;
 if not public.gw_marketing_intake_employee_allowed(p_tenant,p_employee)
  or not exists(select 1 from public.gw_employees where id=p_employee and tenant_id=p_tenant and user_id=p_actor) then
  return jsonb_build_object('ok',false,'error','forbidden','status',403);
 end if;
 is_owner:=exists(select 1 from public.gw_role_grants where employee_id=p_employee and tenant_id=p_tenant and role='owner');
 request_hash:=encode(sha256(convert_to(p_action||coalesce(p_id::text,'')||coalesce(p_expected_version::text,'')||p_payload::text||p_actor::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||p_request_id::text,0));
 select * into ev from public.gw_marketing_intake_events where tenant_id=p_tenant and request_id=p_request_id;
 if found then
  if ev.request_fingerprint<>request_hash then return jsonb_build_object('ok',false,'error','request_conflict','status',409); end if;
  select * into v from public.gw_marketing_intake where tenant_id=p_tenant and id=ev.intake_id;
  if not found then return jsonb_build_object('ok',false,'error','not_found','status',404); end if;
  return jsonb_build_object('ok',true,'item',to_jsonb(v),'duplicate',true);
 end if;
 owner_id:=(p_payload->>'ownerEmployeeId')::uuid;
 if not public.gw_marketing_intake_employee_allowed(p_tenant,owner_id) then
  return jsonb_build_object('ok',false,'error','invalid_owner','status',400);
 end if;
 if nullif(btrim(p_payload->>'nextAction'),'') is null or length(p_payload->>'nextAction')>1000
  or nullif(p_payload->>'dueAt','') is null then return jsonb_build_object('ok',false,'error','invalid_work_fields','status',400); end if;
 if p_action='create' then
  if p_payload->>'channel' not in ('phone','email','form') or p_payload->>'biz' not in ('mugen','space','site') then
   return jsonb_build_object('ok',false,'error','invalid_channel_or_business','status',400);
  end if;
  if p_payload->>'channel'<>'phone' then
   perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||(p_payload->>'sourceType')||':'||(p_payload->>'sourceId'),0));
   select * into v from public.gw_marketing_intake where tenant_id=p_tenant
     and source_type=p_payload->>'sourceType' and source_id=(p_payload->>'sourceId')::uuid;
   if found then
    if v.biz<>p_payload->>'biz' then return jsonb_build_object('ok',false,'error','source_business_conflict','status',409); end if;
    insert into public.gw_marketing_intake_events(tenant_id,intake_id,request_id,request_fingerprint,kind,actor_id,detail)
     values(p_tenant,v.id,p_request_id,request_hash,'duplicate',p_actor,'{}'::jsonb);
    return jsonb_build_object('ok',true,'item',to_jsonb(v),'duplicate',true);
   end if;
  end if;
  insert into public.gw_marketing_intake(tenant_id,channel,biz,source_type,source_id,phone_name,phone_contact,phone_email,email_pending,phone_subject,callback_wish,
    received_at,received_by,owner_employee_id,next_action,due_at,created_by)
   values(p_tenant,p_payload->>'channel',p_payload->>'biz',p_payload->>'sourceType',(p_payload->>'sourceId')::uuid,
     p_payload->>'name',p_payload->>'contact',p_payload->>'email',coalesce((p_payload->>'emailPending')::boolean,false),p_payload->>'subject',p_payload->>'callbackWish',(p_payload->>'receivedAt')::timestamptz,
     p_actor,owner_id,p_payload->>'nextAction',(p_payload->>'dueAt')::timestamptz,p_actor) returning * into v;
  event_kind:='created';
  event_detail:=jsonb_build_object('channel',v.channel,'sourceType',v.source_type,'sourceId',v.source_id,
    'ownerEmployeeId',v.owner_employee_id,'nextAction',v.next_action,'dueAt',v.due_at,'state',v.state,'contactPending',v.email_pending);
 else
  select * into old_v from public.gw_marketing_intake where tenant_id=p_tenant and id=p_id for update;
  if not found then return jsonb_build_object('ok',false,'error','not_found','status',404); end if;
  if not is_owner and old_v.created_by<>p_actor and old_v.owner_employee_id<>p_employee then
   return jsonb_build_object('ok',false,'error','forbidden','status',403);
  end if;
  if p_expected_version is null or old_v.version<>p_expected_version then return jsonb_build_object('ok',false,'error','stale_record','status',409); end if;
  if p_payload->>'state' not in ('open','done') or length(coalesce(p_payload->>'result',''))>2000
    or length(coalesce(p_payload->>'note',''))>2000
    or (p_payload->>'state'='done' and nullif(btrim(p_payload->>'result'),'') is null) then
   return jsonb_build_object('ok',false,'error','invalid_completion','status',400);
  end if;
  if old_v.channel<>'phone' and (p_payload ? 'email' or p_payload ? 'emailPending') then
   return jsonb_build_object('ok',false,'error','original_must_not_be_copied','status',400);
  end if;
  if coalesce((p_payload->>'emailPending')::boolean,old_v.email_pending) and p_payload->>'state'='done' then
   return jsonb_build_object('ok',false,'error','email_pending_cannot_complete','status',400);
  end if;
  update public.gw_marketing_intake set owner_employee_id=owner_id,next_action=p_payload->>'nextAction',due_at=(p_payload->>'dueAt')::timestamptz,
    phone_email=case when p_payload ? 'email' then p_payload->>'email' else old_v.phone_email end,
    email_pending=coalesce((p_payload->>'emailPending')::boolean,old_v.email_pending),
    state=p_payload->>'state',result=coalesce(p_payload->>'result',''),version=version+1,updated_at=now()
    where tenant_id=p_tenant and id=p_id returning * into v;
  event_kind:=case when old_v.state<>'done' and v.state='done' then 'completed' when old_v.state='done' and v.state='open' then 'reopened' else 'updated' end;
  event_detail:=jsonb_build_object('from',jsonb_build_object('ownerEmployeeId',old_v.owner_employee_id,'nextAction',old_v.next_action,'dueAt',old_v.due_at,'state',old_v.state),
    'to',jsonb_build_object('ownerEmployeeId',v.owner_employee_id,'nextAction',v.next_action,'dueAt',v.due_at,'state',v.state),
    'result',v.result,'note',coalesce(p_payload->>'note',''),
    'emailChanged',old_v.phone_email is distinct from v.phone_email,'contactPending',v.email_pending);
 end if;
 insert into public.gw_marketing_intake_events(tenant_id,intake_id,request_id,request_fingerprint,kind,actor_id,detail)
  values(p_tenant,v.id,p_request_id,request_hash,event_kind,p_actor,event_detail);
 return jsonb_build_object('ok',true,'item',to_jsonb(v),'duplicate',false);
end;
$$;
revoke all on function public.gw_marketing_intake_mutate(uuid,uuid,uuid,text,uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.gw_marketing_intake_mutate(uuid,uuid,uuid,text,uuid,uuid,integer,jsonb) to service_role;
comment on table public.gw_marketing_intake is 'GW問い合わせ対応の正本。電話のみ原文を持ち、メール/フォームは原本参照のみ。対応完了は原本状態・既読と別。';
commit;
