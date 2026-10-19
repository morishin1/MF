-- db/141 の読み取り確認。Supabase SQL Editor で migration 実行後に Run。
-- ✅ がすべて揃うまでは PR を本番反映しない。
with checks(n, item, ok) as (
  select 1, '提案の段階・CS担当・クロージング担当・提案送信Slack時刻がある',
    (select count(*) = 4 from information_schema.columns
      where table_schema='public' and table_name='gw_sales_proposals'
        and column_name in ('handoff_stage','cs_owner_id','closing_owner_id','sent_shared_at'))
  union all select 2, 'チーム設定（CS・クロージング）がある',
    (select count(*) = 2 from information_schema.columns
      where table_schema='public' and table_name='gw_sales_proposal_settings'
        and column_name in ('cs_members','closing_members'))
  union all select 3, 'バトンタッチ履歴の表がある',
    to_regclass('public.gw_sales_proposal_handoffs') is not null
  union all select 4, '履歴のRLSが有効',
    exists(select 1 from pg_class where oid=to_regclass('public.gw_sales_proposal_handoffs') and relrowsecurity)
  union all select 5, '履歴のSELECTを担当・管理者に制限',
    exists(select 1 from pg_policies
      where schemaname='public' and tablename='gw_sales_proposal_handoffs'
        and policyname='gw_sales_proposal_handoffs_read')
  union all select 6, '追記は専用RPC経由で操作',
    to_regprocedure('public.gw_sales_transfer_proposal(uuid,text,uuid,text,text,text,timestamptz)') is not null
  union all select 7, '未ログインから引継ぎRPCを実行できない',
    not has_function_privilege('anon', 'public.gw_sales_transfer_proposal(uuid,text,uuid,text,text,text,timestamptz)', 'EXECUTE')
  union all select 8, '行動の履歴にhandoff・cs_decisionがある',
    exists(select 1 from pg_constraint c where c.conrelid='public.gw_sales_proposal_activities'::regclass
      and c.conname='gw_sales_proposal_activities_kind_chk'
      and pg_get_constraintdef(c.oid) like '%handoff%'
      and pg_get_constraintdef(c.oid) like '%cs_decision%')
  union all select 9, 'CS判断のSlack送信時刻がある',
    exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='gw_sales_proposal_activities' and column_name='slack_sent_at')
  union all select 10, '段階の制約がある',
    exists(select 1 from pg_constraint where conrelid='public.gw_sales_proposals'::regclass
      and conname='gw_sales_proposals_handoff_stage_chk')
)
select n as "#", item as "項目", case when ok then '✅' else '❌' end as "状態"
from checks order by n;
