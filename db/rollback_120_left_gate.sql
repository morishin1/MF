-- db/120_left_gate.sql のやり直し（退職者を DB で止める変更を元に戻す）。
-- 元の定義は db/005・db/007・db/026・db/119・db/schema.sql にある同名の関数と同じ。
-- 戻すと、退職者の権限の行が残っていれば、また DB の権限関数が「入れる」と答える（lib/auth.js の API ゲートは残る）。
begin;

drop trigger if exists gw_employees_self_guard_trg on public.gw_employees;
drop function if exists public.gw_employees_self_guard();

create or replace function public.gw_employee_id(p_tenant uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.gw_employees where tenant_id = p_tenant and user_id = auth.uid() limit 1
$$;

create or replace function public.gw_has_role(p_tenant uuid, p_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.gw_role_grants g join public.gw_employees e on e.id = g.employee_id
     where g.tenant_id = p_tenant and g.role = p_role and e.user_id = auth.uid())
$$;

create or replace function public.gw_has_app(p_tenant uuid, p_app text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.gw_app_grants g join public.gw_employees e on e.id = g.employee_id
     where g.tenant_id = p_tenant and g.app_key = p_app and e.user_id = auth.uid())
$$;

create or replace function public.gw_my_department(p_tenant uuid)
returns text language sql stable security definer set search_path = public as $$
  select department from public.gw_employees where tenant_id = p_tenant and user_id = auth.uid() limit 1
$$;

create or replace function public.gw_is_internal_staff()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.role in ('admin', 'staff'))
      or exists (
        select 1 from public.gw_role_grants g join public.gw_employees e on e.id = g.employee_id
         where e.user_id = auth.uid() and g.role in ('owner', 'hr', 'manager'));
$$;

create or replace function public.is_tenant_staff(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships
     where user_id = auth.uid() and tenant_id = p_tenant and role in ('admin','staff'));
$$;

drop function if exists public.gw_me_is_left();
drop function if exists public.gw_employee_is_left(text, date);

notify pgrst, 'reload schema';
commit;
