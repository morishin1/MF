-- db/141: Sales 提案→CS→クロージングのバトンタッチ（db/138・140 の後に実行）
-- 適用前提: db/138, db/140。既存の行動記録は消さない。実行は Supabase SQL Editor で手動。
begin;
do $$
begin
  if to_regclass('public.gw_sales_proposals') is null
     or to_regclass('public.gw_sales_proposal_settings') is null
     or to_regclass('public.gw_sales_proposal_activities') is null
     or to_regprocedure('public.gw_sales_proposal_visible(uuid,uuid)') is null then
    raise exception 'db/141 requires db/138 and db/140';
  end if;
end $$;

alter table public.gw_sales_proposals
  add column if not exists handoff_stage text not null default 'proposal',
  add column if not exists cs_owner_id uuid references public.gw_employees(id) on delete set null,
  add column if not exists closing_owner_id uuid references public.gw_employees(id) on delete set null,
  add column if not exists sent_shared_at timestamptz;

-- 過去の提案は「提案送信済み＝CS相当」と表示。誰かに実際に引き継いだ記録は捏造しない。
update public.gw_sales_proposals
   set handoff_stage = 'cs'
 where sent_at is not null and handoff_stage = 'proposal';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_sales_proposals_handoff_stage_chk'
    and conrelid = 'public.gw_sales_proposals'::regclass) then
    alter table public.gw_sales_proposals
      add constraint gw_sales_proposals_handoff_stage_chk
      check (handoff_stage in ('proposal', 'cs', 'closing'));
  end if;
end $$;

alter table public.gw_sales_proposal_settings
  add column if not exists cs_members jsonb not null default '[]'::jsonb,
  add column if not exists closing_members jsonb not null default '[]'::jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_sales_proposal_settings_teams_chk'
    and conrelid = 'public.gw_sales_proposal_settings'::regclass) then
    alter table public.gw_sales_proposal_settings
      add constraint gw_sales_proposal_settings_teams_chk
      check (jsonb_typeof(cs_members) = 'array' and jsonb_array_length(cs_members) <= 20
         and jsonb_typeof(closing_members) = 'array' and jsonb_array_length(closing_members) <= 20);
  end if;
end $$;

-- バトンタッチは追記専用。誰がいつ/誰に/どの判断/理由/次の行動を渡したか残す。
create table if not exists public.gw_sales_proposal_handoffs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  proposal_id uuid not null references public.gw_sales_proposals(id),
  from_stage text not null check (from_stage in ('proposal','cs')),
  to_stage text not null check (to_stage in ('cs','closing')),
  from_owner_id uuid references public.gw_employees(id) on delete set null,
  to_owner_id uuid not null references public.gw_employees(id),
  actor_employee_id uuid references public.gw_employees(id) on delete set null,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  decision text not null check (decision in ('advance','needs_detail','hold','other')),
  next_action text not null check (char_length(btrim(next_action)) between 1 and 500),
  next_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  slack_sent_at timestamptz
);
create index if not exists idx_gw_sales_proposal_handoffs
  on public.gw_sales_proposal_handoffs(proposal_id, created_at desc);
alter table public.gw_sales_proposal_handoffs enable row level security;
drop policy if exists gw_sales_proposal_handoffs_read on public.gw_sales_proposal_handoffs;
create policy gw_sales_proposal_handoffs_read on public.gw_sales_proposal_handoffs
  for select to authenticated
  using (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id));
-- INSERT/UPDATE/DELETE policy は作らない。引継ぎは下の専用RPCからだけ実施。
grant select on public.gw_sales_proposal_handoffs to authenticated;
revoke insert, update, delete on public.gw_sales_proposal_handoffs from authenticated, anon;

-- 既存の時系列にも引継ぎの記録を残す
alter table public.gw_sales_proposal_activities drop constraint if exists gw_sales_proposal_activities_kind_check;
alter table public.gw_sales_proposal_activities drop constraint if exists gw_sales_proposal_activities_kind_chk;
alter table public.gw_sales_proposal_activities
  add constraint gw_sales_proposal_activities_kind_chk check (kind in (
    'matched','sent','call','mail','reply','check','meeting','result','decision','assign',
    'due_change','task','memo','contact','link','sync','handoff'
  ));

-- 処理は1トランザクション: RLSを迂回する箇所は権限とテナント/担当を自分で厳格に確認する。
create or replace function public.gw_sales_transfer_proposal(
  p_proposal uuid, p_to_stage text, p_to_owner uuid,
  p_reason text, p_decision text, p_next_action text, p_next_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v public.gw_sales_proposals%rowtype;
  v_actor uuid;
  v_handoff uuid;
  v_settings public.gw_sales_proposal_settings%rowtype;
  v_team jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication_required' using errcode='42501';
  end if;
  select * into v from public.gw_sales_proposals where id=p_proposal for update;
  if not found then raise exception 'proposal_not_found' using errcode='42501'; end if;
  v_actor := public.gw_employee_id(v.tenant_id);
  if not public.gw_is_sales(v.tenant_id) or v_actor is null
     or not (public.gw_sales_is_manager(v.tenant_id) or v.sales_owner_id = v_actor) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if v.status in ('won','lost','stopped','closed_no_reply') or v.sent_at is null then
    raise exception 'proposal_not_active' using errcode='23514';
  end if;
  if (v.handoff_stage = 'proposal' and p_to_stage <> 'cs')
     or (v.handoff_stage = 'cs' and p_to_stage <> 'closing')
     or v.handoff_stage = 'closing' then
    raise exception 'invalid_handoff_transition' using errcode='23514';
  end if;
  if not public.gw_sales_employee_ok(p_to_owner, v.tenant_id) then
    raise exception 'invalid_target_employee' using errcode='23514';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500
     or p_next_action is null or char_length(btrim(p_next_action)) not between 1 and 500
     or p_decision not in ('advance','needs_detail','hold','other') or p_decision is null then
    raise exception 'reason_decision_next_action_required' using errcode='23514';
  end if;
  -- CSから詳細担当へは実際に電話でつながったか、相手の返信が確認できたことが必須
  if p_to_stage = 'closing' then
    if p_decision not in ('advance','needs_detail') then
      raise exception 'closing_requires_advance' using errcode='23514';
    end if;
    if not exists (select 1 from public.gw_sales_proposal_activities a
       where a.proposal_id=v.id and
         ((a.kind='call' and a.result='connected') or a.kind='reply')) then
      raise exception 'cs_contact_required' using errcode='23514';
    end if;
  end if;
  select * into v_settings from public.gw_sales_proposal_settings where tenant_id=v.tenant_id;
  v_team := case when p_to_stage='cs' then v_settings.cs_members else v_settings.closing_members end;
  if v_team is null or jsonb_typeof(v_team) <> 'array'
     or not (v_team @> to_jsonb(p_to_owner::text)) then
    raise exception 'target_not_in_configured_team' using errcode='23514';
  end if;
  insert into public.gw_sales_proposal_handoffs(
    tenant_id,proposal_id,from_stage,to_stage,from_owner_id,to_owner_id,actor_employee_id,
    reason,decision,next_action,next_at,created_by
  ) values (
    v.tenant_id,v.id,v.handoff_stage,p_to_stage,v.sales_owner_id,p_to_owner,v_actor,
    btrim(p_reason),p_decision,btrim(p_next_action),p_next_at,(select auth.uid())
  ) returning id into v_handoff;
  update public.gw_sales_proposals
    set handoff_stage=p_to_stage, sales_owner_id=p_to_owner,
        cs_owner_id=case when p_to_stage='cs' then p_to_owner else cs_owner_id end,
        closing_owner_id=case when p_to_stage='closing' then p_to_owner else closing_owner_id end,
        updated_by=(select auth.uid()), updated_at=now()
    where id=v.id;
  update public.gw_sales_proposal_tasks
    set assignee_id=p_to_owner
    where proposal_id=v.id and status='open' and kind <> 'manager_review'
      and (assignee_id = v.sales_owner_id or assignee_id is null);
  insert into public.gw_sales_proposal_activities(
    tenant_id,proposal_id,company_id,kind,occurred_at,employee_id,created_by,note,detail
  ) values (
    v.tenant_id,v.id,v.company_id,'handoff',now(),v_actor,(select auth.uid()),btrim(p_reason),
    jsonb_build_object('handoffId',v_handoff,'fromStage',v.handoff_stage,'toStage',p_to_stage,
      'fromOwner',v.sales_owner_id,'toOwner',p_to_owner,'decision',p_decision,
      'nextAction',p_next_action,'nextAt',p_next_at)
  );
  return v_handoff;
end $$;
revoke all on function public.gw_sales_transfer_proposal(uuid,text,uuid,text,text,text,timestamptz) from public, anon;
grant execute on function public.gw_sales_transfer_proposal(uuid,text,uuid,text,text,text,timestamptz) to authenticated;
comment on function public.gw_sales_transfer_proposal(uuid,text,uuid,text,text,text,timestamptz) is
  'Salesの提案→CS→クロージング。本人/管理者が実施し履歴・担当・タスクを1トランザクションで変更する（db/141）';

commit;