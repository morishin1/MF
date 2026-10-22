-- db/142の適用確認。Supabase gw のSQL Editorで db/142 適用後に実行。
with checks(n, item, ok) as (
  select 1, '提案にアーカイブ日時・実施者の列がある',
    (select count(*)=2 from information_schema.columns where table_schema='public'
      and table_name='gw_sales_proposals' and column_name in ('archived_at','archived_by'))
  union all select 2, '提案の全件SELECT（Sales権限のある同一テナント）が有効',
    exists(select 1 from pg_policies where schemaname='public' and tablename='gw_sales_proposals'
      and policyname='gw_sales_proposals_select'
      and qual like '%gw_sales_proposal_visible%')
  union all select 3, '更新のRLSが担当者本人に限定',
    exists(select 1 from pg_policies where schemaname='public' and tablename='gw_sales_proposals'
      and policyname='gw_sales_proposals_update'
      and qual like '%gw_sales_proposal_editable%'
      and with_check like '%gw_sales_proposal_editable%')
  union all select 4, '活動記録追加は担当者本人のみ',
    exists(select 1 from pg_policies where schemaname='public' and tablename='gw_sales_proposal_activities'
      and policyname='gw_sales_proposal_activities_insert' and with_check like '%gw_sales_proposal_editable_id%')
  union all select 5, 'タスク更新は担当者本人のみ',
    exists(select 1 from pg_policies where schemaname='public' and tablename='gw_sales_proposal_tasks'
      and policyname='gw_sales_proposal_tasks_update' and qual like '%gw_sales_proposal_editable_id%')
  union all select 6, '本人専用の安全なバトンタッチRPCがある',
    to_regprocedure('public.gw_sales_transfer_proposal_owner(uuid,text,uuid,text,text,text,timestamptz)') is not null
  union all select 7, '以前の引継ぎRPCは認証者の直呼びを禁止',
    not has_function_privilege('authenticated',
      'public.gw_sales_transfer_proposal(uuid,text,uuid,text,text,text,timestamptz)','EXECUTE')
  union all select 8, '最大50件の一括操作RPCがある',
    to_regprocedure('public.gw_sales_bulk_proposals(uuid[],text,text,text)') is not null
  union all select 9, '未ログインでは一括操作RPCを実行できない',
    not has_function_privilege('anon',
      'public.gw_sales_bulk_proposals(uuid[],text,text,text)','EXECUTE')
  union all select 10, '提案の履歴・タスクのRLSが有効',
    (select count(*)=3 from pg_class
      where oid in ('public.gw_sales_proposals'::regclass,'public.gw_sales_proposal_activities'::regclass,
                    'public.gw_sales_proposal_tasks'::regclass)
      and relrowsecurity)
  union all select 11, 'バトンタッチ履歴のRLSが有効',
    exists(select 1 from pg_class where oid='public.gw_sales_proposal_handoffs'::regclass and relrowsecurity)
)
select n as "#", item as "項目", case when ok then '✅' else '❌' end as "状態"
from checks order by n;

-- 参考：提案者と現在担当が一致していないENGERの件数（変更しない・表示するだけ）
select count(*) as "提案者メールと現在担当メールが一致しない件数"
from public.gw_sales_proposals p
left join public.gw_employees e on e.id=p.sales_owner_id
where p.source_system='enger' and p.archived_at is null
  and p.matching_owner_email is not null
  and lower(trim(p.matching_owner_email)) is distinct from lower(trim(e.email));
