-- db/142: db/141 の完了状態からチーム全員閲覧と本人だけ更新・一括アーカイブを検証
\set ON_ERROR_STOP 0
\ir 141_sales_cs_closing_handoff.sql
\set c142 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/142_sales_team_proposals_bulk.sql"`
select pg_temp.try('142 apply', :'c142', 'ok');
select pg_temp.try('142 rerun idempotent', :'c142', 'ok');

select pg_temp.expect('archive columns exist',
  (select count(*)::int from information_schema.columns
    where table_schema='public' and table_name='gw_sales_proposals' and column_name in ('archived_at','archived_by')),2);
select pg_temp.expect('old transfer RPC inaccessible to authenticated',
  case when has_function_privilege('authenticated',
    'public.gw_sales_transfer_proposal(uuid,text,uuid,text,text,text,timestamptz)','EXECUTE') then 0 else 1 end,1);
select pg_temp.expect('anon cannot execute bulk',
  case when has_function_privilege('anon','public.gw_sales_bulk_proposals(uuid[],text,text,text)','EXECUTE') then 0 else 1 end,1);

-- 前の担当 E3 が他人の提案 P を読める（handoff 後も閲覧だけ）。
select set_config('request.jwt.claim.sub','a1410003-0000-0000-0000-000000000000',false);
set role authenticated;
select pg_temp.expect('former CS reads closer proposal',
  (select count(*)::int from public.gw_sales_proposals where id='b1410001-0000-0000-0000-000000000000'),1);
select pg_temp.expect('former CS reads handoff history',
  (select count(*)::int from public.gw_sales_proposal_handoffs where proposal_id='b1410001-0000-0000-0000-000000000000'),2);
reset role;
select pg_temp.try_as('former CS cannot bulk-edit','a1410003-0000-0000-0000-000000000000',
  $q$select public.gw_sales_bulk_proposals(array['b1410001-0000-0000-0000-000000000000']::uuid[],'edit','テスト変更',null)$q$,
  'forbidden');
select pg_temp.try_as('former CS cannot call owner transfer','a1410003-0000-0000-0000-000000000000',
  $q$select public.gw_sales_transfer_proposal_owner('b1410001-0000-0000-0000-000000000000','closing','a1410004-0000-0000-0000-000000000000','試行','advance','次の対応',null)$q$,
  'forbidden');

-- 現担当のE4は編集・アーカイブ・復元できる。
select pg_temp.try_as('closer can edit own proposal','a1410004-0000-0000-0000-000000000000',
  $q$select public.gw_sales_bulk_proposals(array['b1410001-0000-0000-0000-000000000000']::uuid[],'edit','ENGERサービス',null)$q$,
  'ok');
select pg_temp.expect('edit is applied',
  (select count(*)::int from public.gw_sales_proposals
    where id='b1410001-0000-0000-0000-000000000000' and service='ENGERサービス'),1);
select pg_temp.try_as('closer archive own proposal','a1410004-0000-0000-0000-000000000000',
  $q$select public.gw_sales_bulk_proposals(array['b1410001-0000-0000-0000-000000000000']::uuid[],'archive',null,null)$q$,
  'ok');
select pg_temp.expect('proposal archived',
  (select count(*)::int from public.gw_sales_proposals
    where id='b1410001-0000-0000-0000-000000000000' and archived_at is not null),1);
select pg_temp.expect('handoff history not deleted',
  (select count(*)::int from public.gw_sales_proposal_handoffs where proposal_id='b1410001-0000-0000-0000-000000000000'),2);
select pg_temp.expect('activity history preserved',
  (select count(*)::int from public.gw_sales_proposal_activities where proposal_id='b1410001-0000-0000-0000-000000000000' and kind='handoff'),2);
select pg_temp.try_as('closer cannot edit archived','a1410004-0000-0000-0000-000000000000',
  $q$select public.gw_sales_bulk_proposals(array['b1410001-0000-0000-0000-000000000000']::uuid[],'edit','NG',null)$q$,
  'cannot_edit_archived');
select pg_temp.try_as('closer restore own proposal','a1410004-0000-0000-0000-000000000000',
  $q$select public.gw_sales_bulk_proposals(array['b1410001-0000-0000-0000-000000000000']::uuid[],'restore',null,null)$q$,
  'ok');
select pg_temp.expect('proposal restored',
  (select count(*)::int from public.gw_sales_proposals
    where id='b1410001-0000-0000-0000-000000000000' and archived_at is null),1);

-- 1件でも別担当のIDを混ぜたらトランザクション全体が不成立。
insert into public.gw_sales_proposals(id,tenant_id,source_system,source_proposal_id,
    company_name,title,sales_owner_id,sent_at,status)
values('b1410002-0000-0000-0000-000000000000','14114114-0000-0000-0000-000000000001',
  'manual',null,'別の担当の企業','営業テスト','a1410003-0000-0000-0000-000000000000',now(),'call_wait');
select pg_temp.try_as('mixed-owners bulk rejected','a1410004-0000-0000-0000-000000000000',
  $q$select public.gw_sales_bulk_proposals(array['b1410001-0000-0000-0000-000000000000',
    'b1410002-0000-0000-0000-000000000000']::uuid[],'archive',null,null)$q$,'forbidden');
select pg_temp.expect('no partial archive',
 (select count(*)::int from public.gw_sales_proposals where id in ('b1410001-0000-0000-0000-000000000000',
   'b1410002-0000-0000-0000-000000000000') and archived_at is null),2);
