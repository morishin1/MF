-- Additional data from ENGER's independent PRE-proposal verification.
-- Requires db/138 and db/140. Apply before deploying the corresponding Sales API.
begin;
do $$ begin
 if to_regclass('public.gw_sales_proposals') is null then raise exception 'Apply db/138 and db/140 before precheck state'; end if;
end $$;
alter table public.gw_sales_proposals add column if not exists precheck_status text;
alter table public.gw_sales_proposals add column if not exists precheck_observed_at timestamptz;
alter table public.gw_sales_proposals add column if not exists precheck_valid_until timestamptz;
alter table public.gw_sales_proposals drop constraint if exists gw_sales_precheck_status_chk;
alter table public.gw_sales_proposals add constraint gw_sales_precheck_status_chk
  check (precheck_status is null or precheck_status in ('verifying','ready','blocked'));
comment on column public.gw_sales_proposals.precheck_status is
 '案件側と所属元の独立した事前確認。nullは未連携、verifyingは片側のみを含む、readyは双方OK。正式提案送信済みとは別。';
commit;
notify pgrst,'reload schema';

-- After rollout, verify without changing records:
-- select source_proposal_id,precheck_status,precheck_observed_at,precheck_valid_until,sent_at from public.gw_sales_proposals where source_system='enger' order by synced_at desc limit 30;
