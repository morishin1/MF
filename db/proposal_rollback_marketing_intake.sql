-- PROPOSAL ONLY. Rollback refuses to destroy any real intake history.
begin;
do $$ begin
 if exists(select 1 from public.gw_marketing_intake limit 1) or exists(select 1 from public.gw_marketing_intake_events limit 1) then
  raise exception '受付・履歴が存在します。削除せず運用責任者へ確認してください';
 end if;
end $$;
drop function if exists public.gw_marketing_intake_mutate(uuid,uuid,uuid,text,uuid,uuid,integer,jsonb);
drop function if exists public.gw_marketing_intake_employee_allowed(uuid,uuid);
drop table if exists public.gw_marketing_intake_events;
drop table if exists public.gw_marketing_intake;
commit;
