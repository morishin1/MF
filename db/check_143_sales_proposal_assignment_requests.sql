-- db/143 の読み取り確認。Supabase SQL Editor で migration 実行後に Run。
-- ❌ が残る場合は本番反映しない。
with checks(n, item, ok) as (
  select 1, 'ENGER CL担当をSales担当と分けて保存する列がある',
    (select count(*) = 2 from information_schema.columns where table_schema='public'
      and table_name='gw_sales_proposals' and column_name in ('enger_cl_owner_id','enger_cl_owner_name'))
  union all select 2, '担当変更履歴と申請を保存する表がある',
    to_regclass('public.gw_sales_proposal_assignment_requests') is not null
  union all select 3, '担当変更履歴でRLSが有効',
    exists(select 1 from pg_class where oid=to_regclass('public.gw_sales_proposal_assignment_requests') and relrowsecurity)
  union all select 4, '履歴はSales提案閲覧者だけがSELECTできる',
    exists(select 1 from pg_policies where schemaname='public' and tablename='gw_sales_proposal_assignment_requests'
      and policyname='gw_sales_proposal_assignment_requests_read')
  union all select 5, '履歴テーブルの直接DMLを認証ユーザーから取り上げた',
    not has_table_privilege('authenticated','public.gw_sales_proposal_assignment_requests','INSERT,UPDATE,DELETE')
  union all select 6, '担当変更RPCが3つある',
    to_regprocedure('public.gw_sales_proposal_assign_stage_owner(uuid,text,uuid,text)') is not null
    and to_regprocedure('public.gw_sales_proposal_request_assignment(uuid,text,uuid,text)') is not null
    and to_regprocedure('public.gw_sales_proposal_review_assignment_request(uuid,text,text)') is not null
  union all select 7, '担当変更RPCをanonから実行できない',
    not has_function_privilege('anon','public.gw_sales_proposal_assign_stage_owner(uuid,text,uuid,text)','EXECUTE')
    and not has_function_privilege('anon','public.gw_sales_proposal_request_assignment(uuid,text,uuid,text)','EXECUTE')
    and not has_function_privilege('anon','public.gw_sales_proposal_review_assignment_request(uuid,text,text)','EXECUTE')
  union all select 8, '編集関数で管理者を含むSales担当者を判定する',
    exists(select 1 from pg_proc where oid='public.gw_sales_proposal_editable(uuid,uuid)'::regprocedure
      and prosrc like '%gw_sales_is_manager%')
)
select n as "#", item as "項目", case when ok then '✅' else '❌' end as "状態"
from checks order by n;
