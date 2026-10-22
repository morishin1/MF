-- db/145 の適用確認（読み取りのみ）。0 NGが完了条件。
with checks as (
  select 'proposal_owner_id' as item,
    exists (select 1 from information_schema.columns where table_schema='public'
      and table_name='gw_sales_proposals' and column_name='proposal_owner_id') as ok
  union all
  select 'owner_rpc',to_regprocedure('public.gw_sales_set_proposal_stage_owner(uuid,text,uuid,uuid)') is not null
  union all
  select 'bulk_rpc',to_regprocedure('public.gw_sales_bulk_proposals(uuid[],text,text,text)') is not null
  union all
  select 'owner_capture_trigger',exists (
    select 1 from pg_trigger where tgrelid='public.gw_sales_proposals'::regclass
      and tgname='gw_sales_keep_proposal_owner_tr' and not tgisinternal)
  union all
  select 'member_execute',
    has_function_privilege('authenticated','public.gw_sales_set_proposal_stage_owner(uuid,text,uuid,uuid)','EXECUTE')
  union all
  select 'anonymous_no_execute',
    not has_function_privilege('anon','public.gw_sales_set_proposal_stage_owner(uuid,text,uuid,uuid)','EXECUTE')
)
select item,case when ok then 'OK' else 'NG' end as status from checks order by item;
