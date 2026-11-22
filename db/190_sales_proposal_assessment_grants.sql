begin;

-- Supabase may assign all table privileges to service_role by default.
-- Keep assessment revisions append-only for the application role.
revoke all on public.gw_sales_proposal_assessments from service_role;
grant select, insert on public.gw_sales_proposal_assessments to service_role;
revoke all on public.gw_sales_proposal_latest_results from service_role;
grant select on public.gw_sales_proposal_latest_results to service_role;

commit;
