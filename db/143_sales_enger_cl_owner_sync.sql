-- db/143: ENGER CL担当の変更を Sales営業担当へ同期（順序保証・監査・タスク引継ぎ）
-- 前提: db/138・db/140・db/141。既存の提案や履歴は削除しない。
-- 適用先: グループウェア（MF）の Supabase。ENGERのSupabaseには適用しない。
begin;

do $$
begin
  if to_regclass('public.gw_sales_proposals') is null
     or to_regclass('public.gw_sales_proposal_tasks') is null
     or to_regclass('public.gw_sales_proposal_activities') is null
     or to_regclass('public.gw_sales_proposal_handoffs') is null then
    raise exception 'db/143 requires db/138, db/140 and db/141';
  end if;
end $$;

-- 内容はハッシュのみ。ENGERのCL名・メールを追加保存しない。
-- 最後のCL更新イベント時刻を保持し、後着した古い通知で担当が巻き戻らないようにする。
alter table public.gw_sales_proposals
  add column if not exists enger_cl_key text,
  add column if not exists enger_cl_synced_at timestamptz;
alter table public.gw_sales_proposals
  drop constraint if exists gw_sales_proposals_enger_cl_key_chk;
alter table public.gw_sales_proposals
  add constraint gw_sales_proposals_enger_cl_key_chk
  check (enger_cl_key is null or enger_cl_key ~ '^[0-9a-f]{64}$');
comment on column public.gw_sales_proposals.enger_cl_key is
  'ENGERのCL担当識別子のSHA256。Salesで手動変更した営業担当と、ENGER側の実際のCL変更を区別する';
comment on column public.gw_sales_proposals.enger_cl_synced_at is
  '最後に処理したENGERのCL変更イベント発生時刻。イベントの後着による巻き戻し防止';

-- 他の利用者は直接呼べず、署名付きENGER受信APIのservice_roleだけが使える。
-- 担当・タスク・履歴を1トランザクションで変更するので、片方だけ変わらない。
create or replace function public.gw_sales_apply_enger_cl_owner(
  p_tenant uuid,
  p_proposal uuid,
  p_cl_key text,
  p_event_at timestamptz,
  p_new_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v public.gw_sales_proposals%rowtype;
  v_new_cl boolean;
  v_moved integer := 0;
  v_handoff boolean;
begin
  if p_tenant is null or p_proposal is null or p_cl_key is null
     or p_cl_key !~ '^[0-9a-f]{64}$'
     or p_event_at is null or p_event_at > now() + interval '5 minutes' then
    raise exception 'invalid_cl_sync_input' using errcode='23514';
  end if;
  select * into v from public.gw_sales_proposals
    where id=p_proposal and tenant_id=p_tenant and source_system='enger' for update;
  if not found then
    raise exception 'enger_proposal_not_found' using errcode='42501';
  end if;
  if p_new_owner is not null and not public.gw_sales_employee_ok(p_new_owner,p_tenant) then
    raise exception 'invalid_employee' using errcode='23503';
  end if;
  if v.enger_cl_synced_at is not null and p_event_at <= v.enger_cl_synced_at then
    return jsonb_build_object('state','stale');
  end if;

  -- 初めて更新するレガシーデータは、Salesの現担当と比較する。
  -- その後はENGER側のCLハッシュが変わったときだけ営業担当を更新。
  v_new_cl := case when v.enger_cl_key is null
    then v.sales_owner_id is distinct from p_new_owner
    else v.enger_cl_key is distinct from p_cl_key end;

  -- ENGER由来の状態だけは追跡する（正式引継ぎ後でも次のCL更新との比較に使う）。
  update public.gw_sales_proposals
     set enger_cl_key=p_cl_key, enger_cl_synced_at=p_event_at
   where id=p_proposal and tenant_id=p_tenant;

  if not v_new_cl then
    return jsonb_build_object('state','same');
  end if;
  if v.status in ('won','lost','stopped','closed_no_reply') then
    return jsonb_build_object('state','closed');
  end if;
  select exists(
    select 1 from public.gw_sales_proposal_handoffs h
    where h.proposal_id=p_proposal and h.tenant_id=p_tenant
  ) into v_handoff;
  if v_handoff then
    -- 営業担当からCS/クロージングに渡った後は、ENGERのCLが変わっても責任者を戻さない。
    return jsonb_build_object('state','protected');
  end if;
  if v.sales_owner_id is not distinct from p_new_owner then
    return jsonb_build_object('state','same');
  end if;

  update public.gw_sales_proposals
    set sales_owner_id=p_new_owner, updated_at=now()
    where id=p_proposal and tenant_id=p_tenant;
  -- 引継ぎ後ではなく「旧営業担当の未完了タスク」だけを移す。
  -- 管理者/別の社員が担当するタスクは変更せず、完了・取消済みも変更しない。
  update public.gw_sales_proposal_tasks
    set assignee_id=p_new_owner, updated_at=now()
    where tenant_id=p_tenant and proposal_id=p_proposal and status='open'
      and (assignee_id=v.sales_owner_id or assignee_id is null);
  get diagnostics v_moved=row_count;

  insert into public.gw_sales_proposal_activities(
    tenant_id,proposal_id,company_id,kind,occurred_at,employee_id,
    note,detail
  ) values (
    p_tenant,p_proposal,v.company_id,'assign',p_event_at,null,
    'ENGER CL担当の変更をSalesの営業担当へ自動反映',
    jsonb_build_object(
      'via','enger','from',v.sales_owner_id,'to',p_new_owner,
      'movedTasks',v_moved
    )
  );

  return jsonb_build_object(
    'state','changed','from',v.sales_owner_id,'to',p_new_owner,'movedTasks',v_moved
  );
end
$$;
revoke all on function public.gw_sales_apply_enger_cl_owner(uuid,uuid,text,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.gw_sales_apply_enger_cl_owner(uuid,uuid,text,timestamptz,uuid)
  to service_role;

commit;
notify pgrst, 'reload schema';

-- 動作確認（本番の値は更新しない）:
-- select proname, prosecdef from pg_proc where proname='gw_sales_apply_enger_cl_owner';
-- select count(*) from public.gw_sales_proposals where source_system='enger';
