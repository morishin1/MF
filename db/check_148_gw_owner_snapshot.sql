-- READ ONLY. Run before db/148_gw_owner_snapshot_sends.sql.
-- This outputs only binding IDs, minimum work identity/role and coarse source coverage.
-- It does NOT read passwords, tokens, payroll, contracts, applicant details, report bodies or private events.
-- Exactly one valid candidate is required; never choose the first of multiple candidates.
with candidate as (
  select e.id as owner_employee_id, e.tenant_id, e.user_id,
    e.display_name, e.status, e.joined_on, e.left_on,
    exists (select 1 from public.gw_role_grants g
      where g.tenant_id=e.tenant_id and g.employee_id=e.id and g.role='owner') as explicit_owner,
    exists (select 1 from public.memberships m
      where m.tenant_id=e.tenant_id and m.user_id=e.user_id and m.role in ('admin','staff')) as current_staff_membership
  from public.gw_employees e
  where lower(trim(e.email))='s_morita@gw.8grp.co.jp'
), valid as (
  select * from candidate where explicit_owner and current_staff_membership
    and user_id is not null and status in ('active','leaving')
    and (joined_on is null or joined_on <= (now() at time zone 'Asia/Tokyo')::date)
    and not (status='leaving' and left_on is not null and left_on < (now() at time zone 'Asia/Tokyo')::date)
)
select owner_employee_id, tenant_id, display_name, status, explicit_owner, current_staff_membership,
  (select count(*) from valid) as valid_candidate_count,
  case when (select count(*) from valid)=1 then 'BIND_ONLY_AFTER_OWNER_CONFIRMATION' else 'STOP_NO_UNIQUE_OWNER' end as decision
from candidate;

-- Minimal roster for one-time classification of real working members vs shared/test accounts.
-- No default test-account heuristics; excluded IDs must be verified by the owner/operator.
with valid_owner as (
  select e.tenant_id
  from public.gw_employees e
  where lower(trim(e.email))='s_morita@gw.8grp.co.jp'
    and e.user_id is not null and e.status in ('active','leaving')
    and (e.joined_on is null or e.joined_on <= (now() at time zone 'Asia/Tokyo')::date)
    and not (e.status='leaving' and e.left_on is not null and e.left_on < (now() at time zone 'Asia/Tokyo')::date)
    and exists (select 1 from public.gw_role_grants g where g.tenant_id=e.tenant_id and g.employee_id=e.id and g.role='owner')
    and exists (select 1 from public.memberships m where m.tenant_id=e.tenant_id and m.user_id=e.user_id and m.role in ('admin','staff'))
), unique_tenant as (select tenant_id from valid_owner where (select count(*) from valid_owner)=1)
select e.id as employee_id, e.display_name, e.department, e.position, e.status,
  (e.user_id is not null) as account_linked,
  (select count(*) from public.gw_nippo_shares n
    where n.tenant_id=e.tenant_id and n.user_id=e.user_id and n.visible
      and n.work_date between ((now() at time zone 'Asia/Tokyo')::date-7) and (now() at time zone 'Asia/Tokyo')::date) as visible_report_provenance_last_8_days
from public.gw_employees e join unique_tenant t on t.tenant_id=e.tenant_id
where e.status in ('active','leaving')
  and (e.joined_on is null or e.joined_on <= (now() at time zone 'Asia/Tokyo')::date)
  and not (e.status='leaving' and e.left_on is not null and e.left_on < (now() at time zone 'Asia/Tokyo')::date)
order by e.display_name, e.id;

-- Existing schema check, only object existence. This does not apply a migration.
select to_regclass('public.gw_owner_snapshot_sends') as dispatch_ledger,
  to_regclass('public.gw_nippo_shares') as report_provenance,
  to_regclass('public.gw_focus_days') as plan_confirmation,
  to_regclass('public.gw_tasks') as original_tasks;
