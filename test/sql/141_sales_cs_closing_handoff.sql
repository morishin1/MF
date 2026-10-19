-- db/141: 実PostgreSQLでCS→クロージングの安全な引継ぎとRLSを検証
\set ON_ERROR_STOP 0
\set c088 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/088_sales.sql"`
\set c094 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/094_recruit_sales_roles.sql"`
\set c096 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/096_sales_channels.sql"`
\set c119 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/119_app_grants.sql"`
\set c120 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/120_left_gate.sql"`
\set c130 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/130_sales_access_align.sql"`
\set c138 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/138_sales_proposals.sql"`
\set c140 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/140_sales_proposal_matching.sql"`
\set c141 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/141_sales_cs_closing_handoff.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got=want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' expected ' || want; end $$;
create or replace function pg_temp.try(label text, stmt text, expected text) returns void language plpgsql as $$
declare msg text; worked boolean:=false;
begin begin execute stmt; worked:=true; exception when others then msg:=sqlerrm; end;
  raise notice '% : %', case when (expected='ok' and worked) or (expected<>'ok' and not worked and msg like '%'||expected||'%') then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
end $$;
create or replace function pg_temp.try_as(label text, uid uuid, stmt text, expected text) returns void language plpgsql as $$
declare msg text; worked boolean:=false;
begin
  perform set_config('request.jwt.claim.sub',uid::text,false);
  execute 'set local role authenticated';
  begin execute stmt; worked:=true; exception when others then msg:=sqlerrm; end;
  execute 'reset role';
  raise notice '% : %', case when (expected='ok' and worked) or (expected<>'ok' and not worked and msg like '%'||expected||'%') then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
end $$;

do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
grant usage on schema public,auth to anon;
select pg_temp.try('141 requires db/138 + 140', :'c141', 'db/141 requires db/138');
select pg_temp.try('088',:'c088','ok');
select pg_temp.try('094',:'c094','ok');
select pg_temp.try('096',:'c096','ok');
select pg_temp.try('119',:'c119','ok');
select pg_temp.try('120',:'c120','ok');
select pg_temp.try('130',:'c130','ok');
select pg_temp.try('138',:'c138','ok');
select pg_temp.try('140',:'c140','ok');
grant all on all tables in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

insert into public.tenants(id,name) values('14114114-0000-0000-0000-000000000001','T141');
insert into auth.users(id,email) values
('a1410001-0000-0000-0000-000000000000','owner@example.com'),
('a1410003-0000-0000-0000-000000000000','cs@example.com'),
('a1410004-0000-0000-0000-000000000000','closing@example.com');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status) values
('a1410001-0000-0000-0000-000000000000','14114114-0000-0000-0000-000000000001','a1410001-0000-0000-0000-000000000000','Owner','owner@example.com','active'),
('a1410003-0000-0000-0000-000000000000','14114114-0000-0000-0000-000000000001','a1410003-0000-0000-0000-000000000000','CS','cs@example.com','active'),
('a1410004-0000-0000-0000-000000000000','14114114-0000-0000-0000-000000000001','a1410004-0000-0000-0000-000000000000','Closer','closing@example.com','active');
insert into public.gw_role_grants(tenant_id,employee_id,role) values
('14114114-0000-0000-0000-000000000001','a1410001-0000-0000-0000-000000000000','owner');
insert into public.gw_app_grants(tenant_id,employee_id,app_key) values
('14114114-0000-0000-0000-000000000001','a1410003-0000-0000-0000-000000000000','sales'),
('14114114-0000-0000-0000-000000000001','a1410004-0000-0000-0000-000000000000','sales');
insert into public.gw_sales_proposals(id,tenant_id,source_system,source_proposal_id,company_name,title,sales_owner_id,sent_at) values
('b1410001-0000-0000-0000-000000000000','14114114-0000-0000-0000-000000000001','enger','m-141','T141社','案件X','a1410003-0000-0000-0000-000000000000',now());
select pg_temp.try('141 applies',:'c141','ok');
select pg_temp.try('141 rerun idempotent',:'c141','ok');
select pg_temp.expect('existing sent stage CS', (select count(*)::int from public.gw_sales_proposals
 where id='b1410001-0000-0000-0000-000000000000' and handoff_stage='cs'),1);

update public.gw_sales_proposal_settings set cs_members='["a1410003-0000-0000-0000-000000000000"]'::jsonb,
 closing_members='["a1410004-0000-0000-0000-000000000000"]'::jsonb
 where tenant_id='14114114-0000-0000-0000-000000000001';
insert into public.gw_sales_proposal_settings(tenant_id,cs_members,closing_members)
 select '14114114-0000-0000-0000-000000000001',
 '["a1410003-0000-0000-0000-000000000000"]'::jsonb,
 '["a1410004-0000-0000-0000-000000000000"]'::jsonb
 where not exists (select 1 from public.gw_sales_proposal_settings where tenant_id='14114114-0000-0000-0000-000000000001');

select pg_temp.try_as('cannot handoff without reason','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_transfer_proposal('b1410001-0000-0000-0000-000000000000','cs','a1410003-0000-0000-0000-000000000000',null,'advance','電話する',null)$q$,
 'reason_decision_next_action_required');
select pg_temp.try_as('formal CS handoff','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_transfer_proposal('b1410001-0000-0000-0000-000000000000','cs','a1410003-0000-0000-0000-000000000000','提案送信','advance','連絡する',null)$q$,'ok');
select pg_temp.expect('CS handoff exists',(select count(*)::int from public.gw_sales_proposal_handoffs where to_stage='cs'),1);
select pg_temp.try_as('no connection no closer','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_transfer_proposal('b1410001-0000-0000-0000-000000000000','closing','a1410004-0000-0000-0000-000000000000','検討希望','advance','詳細ヒアリング',null)$q$,'cs_contact_required');

insert into public.gw_sales_proposal_activities(tenant_id,proposal_id,kind,result,outcome,employee_id)
values ('14114114-0000-0000-0000-000000000001','b1410001-0000-0000-0000-000000000000','call','connected','considering','a1410003-0000-0000-0000-000000000000');
select pg_temp.try_as('no CS decision no closer','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_transfer_proposal('b1410001-0000-0000-0000-000000000000','closing','a1410004-0000-0000-0000-000000000000','検討希望','advance','詳細ヒアリング',null)$q$,'cs_approval_required');
insert into public.gw_sales_proposal_activities(tenant_id,proposal_id,kind,result,employee_id,note)
values ('14114114-0000-0000-0000-000000000001','b1410001-0000-0000-0000-000000000000','cs_decision','advance','a1410003-0000-0000-0000-000000000000','進行');
select pg_temp.try_as('CS→closer after decision','a1410003-0000-0000-0000-000000000000',
 $q$select public.gw_sales_transfer_proposal('b1410001-0000-0000-0000-000000000000','closing','a1410004-0000-0000-0000-000000000000','条件詳細確認','needs_detail','日程を決める',null)$q$,'ok');
select pg_temp.expect('stage closing and owner switched',(select count(*)::int from public.gw_sales_proposals
 where id='b1410001-0000-0000-0000-000000000000' and handoff_stage='closing'
 and sales_owner_id='a1410004-0000-0000-0000-000000000000'),1);
select pg_temp.expect('two handoffs and activity history',(select count(*)::int from public.gw_sales_proposal_handoffs),2);
select pg_temp.expect('handoff in activity history',(select count(*)::int from public.gw_sales_proposal_activities where kind='handoff'),2);
select pg_temp.try_as('cannot close twice','a1410004-0000-0000-0000-000000000000',
 $q$select public.gw_sales_transfer_proposal('b1410001-0000-0000-0000-000000000000','closing','a1410004-0000-0000-0000-000000000000','もう一度','advance','動く',null)$q$,'invalid_handoff_transition');
