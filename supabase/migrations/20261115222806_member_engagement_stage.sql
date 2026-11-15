-- Classification for HR/Office roster display only; no access/auth changes.
-- NULL keeps the existing HR/contract-derived classification. No existing row is rewritten.
alter table public.gw_employees add column if not exists engagement_stage text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.gw_employees'::regclass and conname='gw_employees_engagement_stage_check') then
    alter table public.gw_employees add constraint gw_employees_engagement_stage_check
      check (engagement_stage is null or engagement_stage in ('trial','probation','regular'));
  end if;
end $$;
comment on column public.gw_employees.engagement_stage is
  'Administrative stage override: trial/probation/regular. NULL derives from HR and contract records. Never an authorization or employment-type field.';

create or replace function public.gw_guard_engagement_stage()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if old.engagement_stage is distinct from new.engagement_stage
     and current_user not in ('postgres','service_role')
     and not coalesce(public.gw_is_hr(old.tenant_id) and public.gw_is_hr(new.tenant_id), false) then
    raise exception 'Only HR managers may change engagement_stage' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.gw_guard_engagement_stage() from public,anon,authenticated;
grant execute on function public.gw_guard_engagement_stage() to service_role;
drop trigger if exists gw_guard_engagement_stage on public.gw_employees;
create trigger gw_guard_engagement_stage before update of engagement_stage on public.gw_employees
for each row execute function public.gw_guard_engagement_stage();
