-- db/143: 管理者の直接変更、他メンバーの申請・承認、RLS、履歴、ENGER担当分離を検証
\set ON_ERROR_STOP 0
\ir 142_sales_team_proposals_bulk.sql
\set c143 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/143_sales_proposal_assignment_requests.sql"`
select pg_temp.try('143 apply', :'c143', 'ok');
select pg_temp.try('143 rerun idempotent', :'c143', 'ok');

insert into auth.users(id,email) values ('a1410005-0000-0000-0000-000000000000','closing2@example.com');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status) values
 ('a1410005-0000-0000-0000-000000000000','14114114-0000-0000-0000-000000000001',
  'a1410005-0000-0000-0000-000000000000','Closer 2','closing2@example.com','active');
insert into public.gw_app_grants(tenant_id,employee_id,app_key) values
 ('14114114-0000-0000-0000-000000000001','a1410005-0000-0000-0000-000000000000','sales');
update public.gw_sales_proposal_settings set closing_members=jsonb_build_array(
  'a1410004-0000-0000-0000-000000000000','a1410005-0000-0000-0000-000000000000')
 where tenant_id='14114114-0000-0000-0000-000000000001';
insert into public.gw_sales_proposal_tasks(tenant_id,proposal_id,kind,title,assignee_id,due_at)
values ('14114114-0000-0000-0000-000000000001','b1410001-0000-0000-0000-000000000000',
  'manual','期限超過タスク','a1410004-0000-0000-0000-000000000000',now()-interval '1 day');

select pg_temp.expect('ENGER owner columns exist',
 (select count(*)::int from information_schema.columns where table_schema='public' and table_name='gw_sales_proposals'
  and column_name in ('enger_cl_owner_id','enger_cl_owner_name')),2);
select pg_temp.expect('assignment history table has RLS',
 (select count(*)::int from pg_class where oid=to_regclass('public.gw_sales_proposal_assignment_requests') and relrowsecurity),1);
select pg_temp.expect('authenticated cannot directly insert assignment history',
 case when has_table_privilege('authenticated','public.gw_sales_proposal_assignment_requests','INSERT') then 0 else 1 end,1);
select pg_temp.try_as('manager can directly edit proposal','a1410001-0000-0000-0000-000000000000',
 $q$update public.gw_sales_proposals set service='管理者保存' where id='b1410001-0000-0000-0000-000000000000'$q$,'ok');
select pg_temp.expect('manager edit saved',(select count(*)::int from public.gw_sales_proposals
 where id='b1410001-0000-0000-0000-000000000000' and service='管理者保存'),1);

-- 経営者は他人の担当提案を直接変更でき、未完了タスクも同じトランザクションで移る。
select pg_temp.try_as('manager direct reassignment','a1410001-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_assign_stage_owner('b1410001-0000-0000-0000-000000000000','closing',
   'a1410005-0000-0000-0000-000000000000','期限超過のため担当を再調整')$q$,'ok');
select pg_temp.expect('manager changes closer and primary owner',(select count(*)::int from public.gw_sales_proposals
 where id='b1410001-0000-0000-0000-000000000000' and closing_owner_id='a1410005-0000-0000-0000-000000000000'
   and sales_owner_id='a1410005-0000-0000-0000-000000000000'),1);
select pg_temp.expect('open task moves to new owner',(select count(*)::int from public.gw_sales_proposal_tasks
 where proposal_id='b1410001-0000-0000-0000-000000000000' and status='open' and assignee_id='a1410005-0000-0000-0000-000000000000'),1);
select pg_temp.expect('direct change is recorded with actor and reason',(select count(*)::int from public.gw_sales_proposal_assignment_requests
 where proposal_id='b1410001-0000-0000-0000-000000000000' and change_type='direct' and status='approved'
   and requested_by_employee_id='a1410001-0000-0000-0000-000000000000' and reason='期限超過のため担当を再調整'),1);
select pg_temp.try_as('non-owner cannot directly reassign','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_assign_stage_owner('b1410001-0000-0000-0000-000000000000','closing',
   'a1410004-0000-0000-0000-000000000000','変更')$q$,'forbidden');

-- CSは他メンバーの担当変更を依頼でき、現在担当者は承認する。自己承認と担当外の承認は失敗。
select pg_temp.try_as('CS member requests closer change','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_request_assignment('b1410001-0000-0000-0000-000000000000','closing',
   'a1410004-0000-0000-0000-000000000000','担当者の休暇に備えて引継ぎたい')$q$,'ok');
select pg_temp.expect('request is pending',(select count(*)::int from public.gw_sales_proposal_assignment_requests
 where proposal_id='b1410001-0000-0000-0000-000000000000' and stage='closing' and status='pending'),1);
select pg_temp.try_as('requester cannot self-approve','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_review_assignment_request((select id from public.gw_sales_proposal_assignment_requests where status='pending'),'approve',null)$q$,
 'self_review_forbidden');
select pg_temp.try_as('former closer cannot approve','a1410004-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_review_assignment_request((select id from public.gw_sales_proposal_assignment_requests where status='pending'),'approve',null)$q$,
 'forbidden');
select pg_temp.try_as('current closer approves','a1410005-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_review_assignment_request((select id from public.gw_sales_proposal_assignment_requests where status='pending'),'approve','確認しました')$q$,
 'ok');
select pg_temp.expect('approval changes owner and records reviewer',(select count(*)::int from public.gw_sales_proposal_assignment_requests
 where status='approved' and reviewed_by_employee_id='a1410005-0000-0000-0000-000000000000' and review_note='確認しました'),1);
select pg_temp.expect('approved target is current closer',(select count(*)::int from public.gw_sales_proposals
 where id='b1410001-0000-0000-0000-000000000000' and sales_owner_id='a1410004-0000-0000-0000-000000000000'),1);

select pg_temp.try_as('CS member can submit a second request','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_request_assignment('b1410001-0000-0000-0000-000000000000','closing',
   'a1410005-0000-0000-0000-000000000000','現担当の継続を希望')$q$,'ok');
select pg_temp.try_as('manager can reject with note','a1410001-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_review_assignment_request((select id from public.gw_sales_proposal_assignment_requests where status='pending'),'reject','現担当を継続します')$q$,
 'ok');
select pg_temp.expect('rejection and note are preserved',(select count(*)::int from public.gw_sales_proposal_assignment_requests
 where status='rejected' and reviewed_by_employee_id='a1410001-0000-0000-0000-000000000000'
   and review_note='現担当を継続します'),1);
select pg_temp.try_as('CS member can submit after prior request resolved','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_request_assignment('b1410001-0000-0000-0000-000000000000','closing',
   'a1410005-0000-0000-0000-000000000000','再度、担当変更を希望')$q$,'ok');
select pg_temp.try_as('manager direct change closes pending request','a1410001-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_assign_stage_owner('b1410001-0000-0000-0000-000000000000','closing',
   'a1410005-0000-0000-0000-000000000000','管理者が直接引き継ぎを割当')$q$,'ok');
select pg_temp.expect('pending request is preserved as superseded history',(select count(*)::int from public.gw_sales_proposal_assignment_requests
 where status='superseded' and reviewed_by_employee_id='a1410001-0000-0000-0000-000000000000'
   and review_note='担当者が直接変更されたため申請を終了しました'),1);

-- 期限超過・未割当の案件を管理者が即時に割り当てできる。
insert into public.gw_sales_proposals(id,tenant_id,source_system,company_name,title,status,matched_at,handoff_stage)
values ('b1410003-0000-0000-0000-000000000000','14114114-0000-0000-0000-000000000001',
 'manual','未割当企業','期限超過の提案','proposal_wait',now()-interval '5 days','proposal');
insert into public.gw_sales_proposal_tasks(tenant_id,proposal_id,kind,title,due_at)
values ('14114114-0000-0000-0000-000000000001','b1410003-0000-0000-0000-000000000000',
 'manual','期限超過','2026-01-01T00:00:00Z');
select pg_temp.try_as('manager immediately assigns overdue unassigned proposal','a1410001-0000-0000-0000-000000000000',
 $q$select public.gw_sales_proposal_assign_stage_owner('b1410003-0000-0000-0000-000000000000','proposal',
   'a1410003-0000-0000-0000-000000000000','期限超過・未割当のため管理者が割当')$q$,'ok');
select pg_temp.expect('overdue task and proposal now have an owner',(select count(*)::int from public.gw_sales_proposals p
 join public.gw_sales_proposal_tasks t on t.proposal_id=p.id
 where p.id='b1410003-0000-0000-0000-000000000000' and p.sales_owner_id='a1410003-0000-0000-0000-000000000000'
   and t.assignee_id=p.sales_owner_id),1);

-- 他メンバーは全件見られるが履歴は直接書き換えられない。
select set_config('request.jwt.claim.sub','a1410003-0000-0000-0000-000000000000',false);
set role authenticated;
select pg_temp.expect('Sales member can read assignment history',
 (select count(*)::int from public.gw_sales_proposal_assignment_requests where proposal_id='b1410001-0000-0000-0000-000000000000'),4);
reset role;
select pg_temp.try_as('authenticated cannot delete assignment history','a1410003-0000-0000-0000-000000000000',
 $q$delete from public.gw_sales_proposal_assignment_requests where proposal_id='b1410001-0000-0000-0000-000000000000'$q$,
 'permission denied');
