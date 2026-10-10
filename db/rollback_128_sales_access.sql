-- db/128_sales_access_align.sql のやり直し（Sales の DB 判定を db/094 のロール判定に戻す）。
-- 戻すと、また「アプリ権限だけの人は DB で止まる」「manager / sales のロールだけの人は DB を通る」に戻る。
begin;

create or replace function public.gw_is_sales(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'owner')
      or public.gw_has_role(p_tenant, 'manager')
      or public.gw_has_role(p_tenant, 'sales')
$$;

comment on function public.gw_is_sales(uuid) is
  '営業アタック管理（/sales）を使える人。社内権限の owner（経営者）・manager（責任者）・sales（営業担当）だけ。'
  '会計側の管理者・IT・管理だけでは使えない（db/094。lib/gw.js canSell と同じ）';

commit;
