-- Trigger INSERTs remain synchronous: NOT zero-latency or failure-isolated.
-- PostgreSQL execution, lock contention and timeout behavior are NOT validated.
-- CANDIDATE ONLY. NOT APPLIED. Number 148 must be checked against all active branches.
-- Independent of Slack Q&A migration 147. No cron, send adapter or source-content copy.
-- Review on main 5ae9b909, then validate against a disposable PostgreSQL instance first.
-- Installing is NOT activation: no config rows are seeded and every flag defaults false.
begin;
create table public.gw_coach_config (
 tenant_id uuid primary key references public.tenants(id),
 enabled boolean not null default false,
 ai_enabled boolean not null default false,
 delivery_enabled boolean not null default false,
 owner_user_id uuid,
 updated_at timestamptz not null default now()
);
create table public.gw_coach_recipients (
 tenant_id uuid not null references public.tenants(id),
 employee_id uuid not null references public.gw_employees(id),
 team_id text not null, sender_id text not null, owner_slack_id text not null,
 member_slack_id text not null, conversation_id text not null,
 members jsonb not null check(jsonb_typeof(members)='array'),
 mapping_version uuid not null default gen_random_uuid(),
 verified_at timestamptz not null,
 primary key(tenant_id,employee_id)
);
create table public.gw_coach_reviews (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id),
 employee_id uuid not null references public.gw_employees(id),
 report_date date not null,
 source_revision bigint not null default 1,
 evaluation_epoch text not null default 'provisional',
 generation bigint not null default 1,
 state text not null default 'queued' check(state in ('queued','processing','owner_review','no_action','approved','delivery_attempted','delivery_unknown','sent')),
 -- Only IDs/revision metadata from canonical records, never report/schedule contents.
 source_metadata jsonb not null default '{}',
 draft jsonb, approval jsonb,
 claim_token uuid, claimed_at timestamptz,
 delivery_state text not null default 'none' check(delivery_state in ('none','attempted','unknown','sent')),
 delivery_token uuid, delivery_generation bigint, delivery_approval jsonb,
 delivery_receipts jsonb not null default '[]',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,employee_id,report_date)
);
create index gw_coach_reviews_queue_idx on public.gw_coach_reviews(tenant_id,state,updated_at);

-- Append-only source metadata inbox. Deliberately no FK: source save does not wait
-- on review/employee/config row locks. Normal INSERT/index locks still apply.
create table public.gw_coach_events (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null, employee_id uuid not null, report_date date,
 source_kind text not null check(source_kind in ('nippo','schedule')),
 source_id text not null,
 state text not null default 'pending' check(state in ('pending','done')),
 created_at timestamptz not null default now(), processed_at timestamptz
);
create index gw_coach_events_pending_idx on public.gw_coach_events(tenant_id,created_at,id) where state='pending';
create index gw_coach_events_pending_employee_idx on public.gw_coach_events(tenant_id,employee_id) where state='pending';


-- No tenant-facing policies. Service-role is the ONLY callable/readable principal.
alter table public.gw_coach_events enable row level security;
create policy coach_events_service on public.gw_coach_events for all to service_role using(true) with check(true);
alter table public.gw_coach_config enable row level security;
alter table public.gw_coach_recipients enable row level security;
alter table public.gw_coach_reviews enable row level security;
create policy coach_config_service on public.gw_coach_config for all to service_role using(true) with check(true);
create policy coach_recipients_service on public.gw_coach_recipients for all to service_role using(true) with check(true);
create policy coach_reviews_service on public.gw_coach_reviews for all to service_role using(true) with check(true);
revoke all on public.gw_coach_config, public.gw_coach_recipients, public.gw_coach_reviews, public.gw_coach_events from public,anon,authenticated;
grant select,insert,update,delete on public.gw_coach_config, public.gw_coach_recipients, public.gw_coach_reviews, public.gw_coach_events to service_role;

create function public.gw_coach_enqueue(p_tenant_id uuid,p_employee_id uuid,p_report_date date,p_source_kind text,p_source_id text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
 if not exists(select 1 from public.gw_coach_config where tenant_id=p_tenant_id and enabled) then return null; end if;
 if p_report_date is null or p_source_kind not in ('nippo','schedule','refresh','member','evidence') or p_source_id is null then raise exception 'invalid coach source'; end if;
 if not exists(select 1 from public.gw_employees where id=p_employee_id and tenant_id=p_tenant_id) then raise exception 'coach employee tenant mismatch'; end if;
 insert into public.gw_coach_reviews(tenant_id,employee_id,report_date,evaluation_epoch,source_metadata)
 values(p_tenant_id,p_employee_id,p_report_date,'provisional:'||p_report_date::text,jsonb_build_object('kind',p_source_kind,'id',p_source_id,'observed_at',clock_timestamp()))
 on conflict(tenant_id,employee_id,report_date) do update set
  source_revision=gw_coach_reviews.source_revision+1,generation=gw_coach_reviews.generation+1,
  source_metadata=excluded.source_metadata,draft=null,approval=null,claim_token=null,claimed_at=null,
  state=case when gw_coach_reviews.delivery_state='attempted' then 'delivery_attempted' when gw_coach_reviews.delivery_state='unknown' then 'delivery_unknown' else 'queued' end,
  updated_at=now()
 returning id into v_id;
 return v_id;
end $$;

create function public.gw_coach_refresh(p_id uuid,p_evaluation_epoch text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_evaluation_epoch !~ '^(provisional|final):[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'invalid evaluation epoch'; end if;
 update public.gw_coach_reviews r set evaluation_epoch=p_evaluation_epoch,generation=generation+1,
 draft=null,approval=null,claim_token=null,claimed_at=null,
 state=case when delivery_state='attempted' then 'delivery_attempted' when delivery_state='unknown' then 'delivery_unknown' else 'queued' end,updated_at=now()
 where r.id=p_id and r.evaluation_epoch<>p_evaluation_epoch
 and not (r.evaluation_epoch like 'final:%' and p_evaluation_epoch like 'provisional:%')
 and split_part(p_evaluation_epoch,':',2)=r.report_date::text
 and exists(select 1 from public.gw_coach_config c where c.tenant_id=r.tenant_id and c.enabled);
 return found;
end $$;

create function public.gw_coach_claim(p_id uuid,p_generation bigint,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_claim_token is null then return false; end if;
 update public.gw_coach_reviews r set state='processing',claim_token=p_claim_token,claimed_at=now(),updated_at=now()
 where id=p_id and generation=p_generation
 and (state='queued' or (state='processing' and claimed_at<now()-interval '10 minutes'))
 and delivery_state not in ('attempted','unknown')
 and exists(select 1 from public.gw_coach_config c where c.tenant_id=r.tenant_id and c.enabled and c.ai_enabled and c.owner_user_id is not null);
 return found;
end $$;

create function public.gw_coach_finish(p_id uuid,p_generation bigint,p_claim_token uuid,p_state text,p_draft jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_state not in ('owner_review','no_action') or jsonb_typeof(p_draft)<>'object' or p_draft is null then return false; end if;
 update public.gw_coach_reviews r set state=p_state,draft=p_draft,approval=null,claim_token=null,claimed_at=null,updated_at=now()
 where id=p_id and generation=p_generation and state='processing' and claim_token=p_claim_token
 and exists(select 1 from public.gw_coach_config c where c.tenant_id=r.tenant_id and c.enabled and c.ai_enabled);
 return found;
end $$;

-- Server MUST authenticate owner, bind draft/source hashes and verify entire recipient set.
-- SQL additionally binds actor/generation; JSON is not a substitute for server verification.
create function public.gw_coach_approve(p_id uuid,p_generation bigint,p_approval jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if jsonb_typeof(p_approval)<>'object' or p_approval is null
 or nullif(p_approval->>'draft_hash','') is null or nullif(p_approval->>'source_hash','') is null
 or jsonb_typeof(p_approval->'target') is distinct from 'object' then return false; end if;
 update public.gw_coach_reviews r set approval=p_approval,state='approved',updated_at=now()
 where id=p_id and generation=p_generation and state='owner_review' and draft is not null
 and delivery_state not in ('attempted','unknown')
 and not exists(select 1 from public.gw_coach_events e where e.tenant_id=r.tenant_id and e.employee_id=r.employee_id and e.state='pending')
 and p_approval->>'draft_hash'=r.draft->>'id'
 and p_approval->>'source_hash'=r.draft->>'sourceHash'
 and p_approval->>'text'=r.draft->>'text'
 and p_approval->>'epoch'=r.evaluation_epoch and r.draft->>'epoch'=r.evaluation_epoch
 and not exists(select 1 from jsonb_array_elements(r.delivery_receipts) receipt where receipt->'approval'->>'text'=p_approval->>'text')
 and exists(select 1 from public.gw_coach_config c where c.tenant_id=r.tenant_id and c.enabled and c.owner_user_id::text=p_approval->>'actor_user_id');
 return found;
end $$;

-- No real sender exists. Persist attempted BEFORE any future external send. Never lease-retry it.
create function public.gw_coach_attempt(p_id uuid,p_generation bigint,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_claim_token is null then return false; end if;
 update public.gw_coach_reviews r set state='delivery_attempted',delivery_state='attempted',
 delivery_token=p_claim_token,delivery_generation=p_generation,delivery_approval=approval,updated_at=now()
 where id=p_id and generation=p_generation and state='approved' and approval is not null
 and delivery_state not in ('attempted','unknown')
 and not exists(select 1 from public.gw_coach_events e where e.tenant_id=r.tenant_id and e.employee_id=r.employee_id and e.state='pending')
 and approval->>'draft_hash'=draft->>'id' and approval->>'source_hash'=draft->>'sourceHash'
 and approval->>'text'=draft->>'text' and approval->>'epoch'=evaluation_epoch
 and not exists(select 1 from jsonb_array_elements(r.delivery_receipts) receipt where receipt->'approval'->>'text'=r.approval->>'text')
 and exists(select 1 from public.gw_coach_config c where c.tenant_id=r.tenant_id and c.enabled and c.delivery_enabled and c.owner_user_id::text=r.approval->>'actor_user_id');
 return found;
end $$;

create function public.gw_coach_complete_attempt(p_id uuid,p_claim_token uuid,p_sent boolean,p_message_id text default null)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_sent is null or (p_sent and nullif(p_message_id,'') is null) then return false; end if;
 -- Completion remains possible after disable, so already-attempted outcome is recorded safely.
 update public.gw_coach_reviews set delivery_state=case when p_sent then 'sent' else 'unknown' end,
 state=case when not p_sent then 'delivery_unknown' when generation=delivery_generation then 'sent' else 'queued' end,
 delivery_receipts=case when p_sent then delivery_receipts||jsonb_build_array(jsonb_build_object('message_id',p_message_id,'generation',delivery_generation,'approval',delivery_approval,'completed_at',clock_timestamp())) else delivery_receipts end,
 updated_at=now()
 where id=p_id and delivery_token=p_claim_token and delivery_state='attempted';
 return found;
end $$;

-- Report table has no tenant_id: refuse ambiguous user-to-employee mappings.
-- Handle OLD and NEW scope on moves/retraction/delete. Do not copy report text.
create function public.gw_coach_nippo_changed() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_old jsonb; v_new jsonb; v_row jsonb; v_tenant uuid; v_employee uuid; v_count bigint; v_previous text;
begin
 if tg_op<>'INSERT' then v_old=to_jsonb(old); end if;
 if tg_op<>'DELETE' then v_new=to_jsonb(new); end if;
 if tg_op='UPDATE' and v_old=v_new then return new; end if;
 for v_row in select x from jsonb_array_elements(jsonb_build_array(v_old,v_new)) x loop
  if v_row is null or v_row='null'::jsonb or nullif(v_row->>'submitted_at','') is null then continue; end if;
  -- One metadata event per affected user/date; OLD/NEW moves may need two scopes.
  if v_previous=concat(v_row->>'user_id','/',v_row->>'work_date') then continue; end if;
  v_previous=concat(v_row->>'user_id','/',v_row->>'work_date');
  select count(*),min(e.id::text)::uuid,min(e.tenant_id::text)::uuid into v_count,v_employee,v_tenant
  from public.gw_employees e where e.user_id::text=v_row->>'user_id';
  if v_count=1 and exists(select 1 from public.gw_coach_config where tenant_id=v_tenant and enabled) then
   insert into public.gw_coach_events(tenant_id,employee_id,report_date,source_kind,source_id)
   values(v_tenant,v_employee,(v_row->>'work_date')::date,'nippo',v_row->>'id');
  end if;
 end loop;
 if tg_op='DELETE' then return old; end if; return new;
exception when others then
 -- Ordinary errors are best-effort warnings. query_canceled/assert_failure are NOT caught;
 -- no claim that this synchronous INSERT can never delay or abort original saving.
 raise warning 'coach report event append failed (%); reconcile metadata queue',sqlstate;
 if tg_op='DELETE' then return old; end if; return new;
end $$;

-- Schedule source-save path ONLY appends metadata; it never touches review rows.
create function public.gw_coach_schedule_changed() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_old jsonb; v_new jsonb; v_row jsonb; v_previous text;
begin
 if tg_op<>'INSERT' then v_old=to_jsonb(old); end if;
 if tg_op<>'DELETE' then v_new=to_jsonb(new); end if;
 if tg_op='UPDATE' and v_old=v_new then return new; end if;
 for v_row in select x from jsonb_array_elements(jsonb_build_array(v_old,v_new)) x loop
  if v_row is null or v_row='null'::jsonb or v_row->>'source' is distinct from 'self' or coalesce(v_row->>'category','')='private' then continue; end if;
  if v_previous=concat(v_row->>'tenant_id','/',v_row->>'employee_id') then continue; end if;
  v_previous=concat(v_row->>'tenant_id','/',v_row->>'employee_id');
  if exists(select 1 from public.gw_coach_config where tenant_id::text=v_row->>'tenant_id' and enabled) then
   insert into public.gw_coach_events(tenant_id,employee_id,report_date,source_kind,source_id)
   values((v_row->>'tenant_id')::uuid,(v_row->>'employee_id')::uuid,null,'schedule',v_row->>'id');
  end if;
 end loop;
 if tg_op='DELETE' then return old; end if; return new;
exception when others then
 -- Best effort only; cancellation and synchronous insert latency remain possible.
 raise warning 'coach schedule event append failed (%); reconcile metadata queue',sqlstate;
 if tg_op='DELETE' then return old; end if; return new;
end $$;

-- Explicit representative POST only; NO cron. Process at most 20 inbox events.
-- Row claim, review upsert and done marker share one transaction. Rollback leaves
-- events pending for safe explicit retry; SKIP LOCKED avoids duplicate collection.
create function public.gw_coach_collect(p_tenant_id uuid,p_limit int default 10)
returns int language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_event record; v_review record; v_count int=0;
begin
 -- Hold activation state for this collector transaction only, so disable cannot
 -- make enqueue silently no-op after an event has been claimed then marked done.
 -- Source triggers only use MVCC reads; this lock is outside the source-save path.
 perform 1 from public.gw_coach_config where tenant_id=p_tenant_id and enabled for share;
 if not found then return 0; end if;
 for v_event in select * from public.gw_coach_events
  where tenant_id=p_tenant_id and state='pending'
  order by created_at,id limit greatest(1,least(20,coalesce(p_limit,10)))
  for update skip locked
 loop
  -- A deleted/moved member must not poison the entire inbox or cross tenants.
  if exists(select 1 from public.gw_employees where id=v_event.employee_id and tenant_id=p_tenant_id) then
   if v_event.source_kind='nippo' and v_event.report_date is not null then
    perform public.gw_coach_enqueue(p_tenant_id,v_event.employee_id,v_event.report_date,'nippo',v_event.source_id);
   elsif v_event.source_kind='schedule' then
    for v_review in select id,report_date from public.gw_coach_reviews
     where tenant_id=p_tenant_id and employee_id=v_event.employee_id
     and report_date between (now() at time zone 'Asia/Tokyo')::date-30 and (now() at time zone 'Asia/Tokyo')::date
     order by id
    loop
     perform public.gw_coach_enqueue(p_tenant_id,v_event.employee_id,v_review.report_date,'schedule',v_event.source_id);
    end loop;
   end if;
  end if;
  update public.gw_coach_events set state='done',processed_at=now() where id=v_event.id;
  v_count=v_count+1;
 end loop;
 return v_count;
end $$;

create trigger gw_coach_nippo_after_save after insert or update or delete on public.tc_nippo
 for each row execute function public.gw_coach_nippo_changed();
create trigger gw_coach_schedule_after_save after insert or update or delete on public.gw_calendar_events
 for each row execute function public.gw_coach_schedule_changed();

-- Do NOT use broad ALTER DEFAULT PRIVILEGES or grant existing Q&A functions access here.
revoke all on function public.gw_coach_collect(uuid,int), public.gw_coach_enqueue(uuid,uuid,date,text,text), public.gw_coach_refresh(uuid,text), public.gw_coach_claim(uuid,bigint,uuid), public.gw_coach_finish(uuid,bigint,uuid,text,jsonb), public.gw_coach_approve(uuid,bigint,jsonb), public.gw_coach_attempt(uuid,bigint,uuid), public.gw_coach_complete_attempt(uuid,uuid,boolean,text), public.gw_coach_nippo_changed(), public.gw_coach_schedule_changed() from public,anon,authenticated;
grant execute on function public.gw_coach_collect(uuid,int), public.gw_coach_enqueue(uuid,uuid,date,text,text), public.gw_coach_refresh(uuid,text), public.gw_coach_claim(uuid,bigint,uuid), public.gw_coach_finish(uuid,bigint,uuid,text,jsonb), public.gw_coach_approve(uuid,bigint,jsonb), public.gw_coach_attempt(uuid,bigint,uuid), public.gw_coach_complete_attempt(uuid,uuid,boolean,text) to service_role;
commit;
-- No NOTIFY, config activation, live data inserts, sends, leases or cron run here.
-- Recovery: processing older than 10m is claimable with a fresh token; old finish is rejected.
-- A crashed delivery_attempted must be completed p_sent=false to quarantine, NEVER re-claimed.
-- No automatic unknown reset. Manual receipt reconciliation/new approval requires separate design.
