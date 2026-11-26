-- 勤怠・通勤費の月締め。本人の申告、Officeの確認、締め時の給与用明細。
begin;

create table if not exists public.gw_commute_claims (
  tenant_id uuid not null references public.tenants(id),
  month_start date not null check (extract(day from month_start) = 1),
  employee_id uuid not null references public.gw_employees(id),
  method text not null check (method in ('pass', 'actual', 'none')),
  route text not null default '',
  rate integer not null check (rate >= 0),
  dates date[] not null default '{}',
  advisor_id uuid references public.gw_employees(id),
  updated_by uuid not null,
  revision uuid not null default gen_random_uuid(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  payroll jsonb, -- 締め操作でのみ保存。給与共有に必要な項目だけ。
  primary key (tenant_id, month_start, employee_id),
  check ((method = 'none' and rate = 0) or (method <> 'none' and rate > 0)),
  check (method = 'actual' or cardinality(dates) = 0),
  check (payroll is null or reviewed_at is not null)
);
create index if not exists gw_commute_latest_review on public.gw_commute_claims
  (tenant_id, employee_id, month_start desc) where reviewed_at is not null;

-- 打刻がまだない社員・日も締めるため、全員分の締めを行とは別に記録する。
create table if not exists public.gw_timecard_closed_months (
  tenant_id uuid not null references public.tenants(id),
  month_start date not null check (extract(day from month_start) = 1),
  closed_at timestamptz not null default now(),
  closed_by uuid not null,
  primary key (tenant_id, month_start)
);
alter table public.gw_commute_claims enable row level security;
alter table public.gw_timecard_closed_months enable row level security;
revoke all on public.gw_commute_claims, public.gw_timecard_closed_months from public, anon, authenticated;
grant select, insert, update, delete on public.gw_commute_claims, public.gw_timecard_closed_months to service_role;

-- 対象月の候補。過去に確認した条件、次に入社時の定期代を使う。通勤日は引き継がない。
create or replace function public.gw_commute_rows(p_tenant uuid, p_month date, p_employee uuid default null)
returns table (
  employee_id uuid, name text, code text, method text, route text, rate numeric, dates date[],
  work_dates date[], work_minutes bigint, incomplete boolean, pending_fix boolean,
  applied boolean, reviewed boolean, locked boolean, advisor_id uuid, amount numeric, version text
) language sql stable set search_path = public, pg_temp as $$
  with days as (
    select t.employee_id, t.work_date, t.locked_at,
      (t.status <> 'absent' and (t.status <> 'closed' or t.clock_in is null or t.clock_out is null
        or t.work_date > (now() at time zone 'Asia/Tokyo')::date
        or exists (select from jsonb_array_elements(t.breaks) b where b->>'start' is null or b->>'end' is null))) as incomplete,
      case when t.status = 'closed' and t.clock_out is not null and t.clock_in is not null
        then round(extract(epoch from t.clock_out - t.clock_in) / 60)::int else 0 end as stay,
      coalesce((select round(sum(greatest(0, extract(epoch from
          ((b->>'end')::timestamptz - (b->>'start')::timestamptz)))) / 60)::int
        from jsonb_array_elements(t.breaks) b where b->>'start' is not null and b->>'end' is not null), 0) as rest
    from gw_time_entries t where t.tenant_id = p_tenant
      and t.work_date >= p_month and t.work_date < p_month + interval '1 month'
      and (p_employee is null or t.employee_id = p_employee)
  ), attendance as (
    select d.employee_id, array_agg(d.work_date order by d.work_date) filter (where d.stay > 0 and not d.incomplete) as work_dates,
      sum(greatest(0, d.stay - d.rest)) as minutes, bool_or(d.incomplete) as incomplete,
      bool_or(d.locked_at is not null) as old_lock
    from days d group by d.employee_id
  ), fixes as (
    select distinct f.employee_id from gw_time_fixes f where f.tenant_id = p_tenant
      and f.status = 'pending' and f.work_date >= p_month and f.work_date < p_month + interval '1 month'
      and (p_employee is null or f.employee_id = p_employee)
  ), roster as (
    select e.id, coalesce(c.payroll->>'name', e.display_name) as display_name,
      case when c.payroll is null then e.employee_code else c.payroll->>'code' end as employee_code, coalesce(c.method, prev.method,
        case when p.commute_cost > 0 then 'pass' when p.commute_cost = 0 then 'none' end) as method,
      coalesce(c.route, prev.route, p.commute_route, p.commute_from, '') as route,
      coalesce(c.rate, prev.rate, p.commute_cost) as rate,
      coalesce(c.dates, '{}'::date[]) as dates, coalesce(a.work_dates, '{}'::date[]) as work_dates,
      coalesce(a.minutes, 0) as minutes, coalesce(a.incomplete, false) as incomplete,
      f.employee_id is not null as pending_fix,
      c.employee_id is not null as applied, c.reviewed_at is not null as reviewed,
      (whole.tenant_id is not null or c.payroll is not null or coalesce(a.old_lock, false)) as locked,
      case when c.employee_id is not null then c.advisor_id else prev.advisor_id end as advisor_id,
      c.revision
    from gw_employees e
    left join attendance a on a.employee_id = e.id
    left join fixes f on f.employee_id = e.id
    left join gw_commute_claims c on c.tenant_id = p_tenant and c.employee_id = e.id and c.month_start = p_month
    left join gw_timecard_closed_months whole on whole.tenant_id = p_tenant and whole.month_start = p_month
    left join lateral (select h.method, h.route, h.rate, h.advisor_id from gw_commute_claims h
      where h.tenant_id = p_tenant and h.employee_id = e.id and h.month_start < p_month
        and h.reviewed_at is not null order by h.month_start desc limit 1) prev on true
    left join gw_onboard_profiles p on p.employee_id = e.id and p.tenant_id = p_tenant
    where e.tenant_id = p_tenant and (p_employee is null or e.id = p_employee)
      and (whole.tenant_id is null or c.payroll is not null)
      and (c.employee_id is not null or a.employee_id is not null or f.employee_id is not null or (
        (e.joined_on is null or e.joined_on < p_month + interval '1 month')
        and (e.left_on is null or e.left_on >= p_month)
        and (e.status in ('active','leaving') or (e.status = 'left' and e.left_on is not null)
          or (e.status = 'invited' and e.joined_on is not null))
        and not exists (select from gw_role_grants g where g.tenant_id = p_tenant and g.employee_id = e.id
          and g.role in ('labor_advisor','tax_advisor'))))
  )
  select r.id, r.display_name, r.employee_code, r.method, r.route, r.rate, r.dates, r.work_dates,
    r.minutes, r.incomplete, r.pending_fix, r.applied, r.reviewed, r.locked, r.advisor_id,
    case when r.method = 'actual' then case when r.applied then r.rate * cardinality(r.dates) end
      else r.rate end, md5(p_month::text || to_jsonb(r)::text)
  from roster r order by r.display_name, r.id
$$;

-- 一覧と締め状態を同じ時点で取得する。個人画面に担当者一覧は返さない。
create or replace function public.gw_commute_overview(p_tenant uuid, p_month date, p_employee uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'closed', exists (select from gw_timecard_closed_months where tenant_id = p_tenant and month_start = p_month),
    'rows', coalesce((select jsonb_agg(case when p_employee is null then to_jsonb(r)
        else to_jsonb(r) - 'advisor_id' - 'code' end order by r.name, r.employee_id)
      from gw_commute_rows(p_tenant,p_month,p_employee) r), '[]'::jsonb),
    'advisors', case when p_employee is null then coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'name', e.display_name) order by e.display_name, e.id)
      from gw_role_grants g join gw_employees e on e.id = g.employee_id and e.tenant_id = g.tenant_id
      where g.tenant_id = p_tenant and g.role = 'labor_advisor' and e.status <> 'left'
        and (e.left_on is null or e.left_on >= (now() at time zone 'Asia/Tokyo')::date)), '[]'::jsonb)
      else '[]'::jsonb end)
$$;

-- 月の更新と新規打刻を同じ鍵で直列化する。行のロックを持っている他の打刻とは待ち合わない。
create or replace function public.gw_timecard_month_mutex(p_tenant uuid, p_month date)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('gw_timecard:' || p_tenant || ':' || to_char(p_month,'YYYY-MM'), 0)) then
    raise exception 'commute_busy';
  end if;
end $$;

create or replace function public.gw_commute_save(
  p_tenant uuid, p_month date, p_employee uuid, p_actor uuid, p_review boolean,
  p_method text, p_route text, p_rate integer, p_dates date[], p_advisor uuid, p_version text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare r record; selected date[]; assigned uuid;
begin
  if extract(day from p_month) <> 1 or p_month > (now() at time zone 'Asia/Tokyo')::date then
    raise exception 'commute_month';
  end if;
  perform gw_timecard_month_mutex(p_tenant, p_month);
  select * into r from gw_commute_rows(p_tenant, p_month, p_employee);
  if not found then raise exception 'commute_employee'; end if;
  if r.locked then raise exception 'commute_locked'; end if;
  if p_version is distinct from r.version then raise exception 'commute_stale'; end if;
  if p_method is null or p_method not in ('pass','actual','none') or p_rate is null
     or (p_method = 'none' and p_rate <> 0) or (p_method <> 'none' and p_rate <= 0)
     or char_length(p_route) > 500 then raise exception 'commute_input'; end if;
  select coalesce(array_agg(distinct d order by d), '{}'::date[]) into selected from unnest(p_dates) d;
  if cardinality(selected) <> cardinality(p_dates) or (p_method <> 'actual' and cardinality(selected) <> 0)
     or not (selected <@ r.work_dates) then raise exception 'commute_dates'; end if;
  assigned := case when p_review then p_advisor else r.advisor_id end;
  if p_review and assigned is not null and not exists (
    select from gw_role_grants g join gw_employees e on e.id = g.employee_id and e.tenant_id = g.tenant_id
    where g.tenant_id = p_tenant and g.role = 'labor_advisor' and g.employee_id = assigned
      and e.status <> 'left' and (e.left_on is null or e.left_on >= (now() at time zone 'Asia/Tokyo')::date)
  ) then raise exception 'commute_advisor'; end if;
  insert into gw_commute_claims (tenant_id, month_start, employee_id, method, route, rate, dates, advisor_id,
    updated_by, reviewed_at, reviewed_by)
  values (p_tenant, p_month, p_employee, p_method, coalesce(trim(p_route),''), p_rate, selected, assigned,
    p_actor, case when p_review then now() end, case when p_review then p_actor end)
  on conflict (tenant_id, month_start, employee_id) do update set method = excluded.method, route = excluded.route,
    rate = excluded.rate, dates = excluded.dates, advisor_id = excluded.advisor_id, updated_by = p_actor,
    reviewed_at = excluded.reviewed_at, reviewed_by = excluded.reviewed_by, revision = gen_random_uuid();
end $$;

create or replace function public.gw_commute_close(p_tenant uuid, p_month date, p_employee uuid, p_actor uuid, p_close boolean)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare r record; affected integer; n integer := 0;
begin
  if extract(day from p_month) <> 1 or p_month > (now() at time zone 'Asia/Tokyo')::date then
    raise exception 'commute_month';
  end if;
  perform gw_timecard_month_mutex(p_tenant, p_month);
  if p_close then
    for r in select * from gw_commute_rows(p_tenant, p_month, p_employee) loop
      n := n + 1;
      if not r.reviewed then raise exception 'commute_unreviewed'; end if;
      if r.incomplete or r.pending_fix or not (r.dates <@ r.work_dates) then raise exception 'commute_attendance'; end if;
      update gw_commute_claims set payroll = jsonb_build_object('employee_id', r.employee_id, 'code', r.code,
        'name', r.name, 'workDays', cardinality(r.work_dates), 'workMinutes', r.work_minutes,
        'commuteDays', case when r.method = 'actual' then cardinality(r.dates) when r.method = 'none' then 0 end,
        'method', r.method, 'amount', r.amount)
      where tenant_id = p_tenant and month_start = p_month and employee_id = r.employee_id and payroll is null;
    end loop;
    if n = 0 then raise exception 'commute_employee'; end if;
    if p_employee is null then
      insert into gw_timecard_closed_months (tenant_id, month_start, closed_by) values (p_tenant, p_month, p_actor)
      on conflict (tenant_id, month_start) do nothing;
    end if;
  else
    if p_employee is not null and not exists (select from gw_employees where tenant_id = p_tenant and id = p_employee) then
      raise exception 'commute_employee';
    end if;
    if p_employee is not null
       and exists (select from gw_timecard_closed_months where tenant_id = p_tenant and month_start = p_month)
       and not exists (select from gw_commute_claims where tenant_id = p_tenant and month_start = p_month
         and employee_id = p_employee and payroll is not null) then raise exception 'commute_employee'; end if;
    delete from gw_timecard_closed_months where tenant_id = p_tenant and month_start = p_month;
    update gw_commute_claims set payroll = null, revision = gen_random_uuid()
    where tenant_id = p_tenant and month_start = p_month and payroll is not null
      and (p_employee is null or employee_id = p_employee);
  end if;
  update gw_time_entries set locked_at = case when p_close then now() end, locked_by = case when p_close then p_actor end
  where tenant_id = p_tenant and work_date >= p_month and work_date < p_month + interval '1 month'
    and (p_employee is null or employee_id = p_employee) and (locked_at is null) = p_close;
  get diagnostics affected = row_count;
  return affected;
end $$;

create or replace function public.gw_timecard_month_locked(p_tenant uuid, p_month date, p_employee uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (select from gw_timecard_closed_months where tenant_id = p_tenant and month_start = p_month)
    or exists (select from gw_commute_claims where tenant_id = p_tenant and month_start = p_month
      and employee_id = p_employee and payroll is not null)
$$;

create or replace function public.gw_guard_payroll_attendance()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare entry record; mon date;
begin
  if tg_op = 'DELETE' then entry := old; else entry := new; end if;
  if tg_op = 'UPDATE' and (old.tenant_id, old.employee_id, old.work_date) is distinct from
      (new.tenant_id, new.employee_id, new.work_date) then raise exception 'commute_identity'; end if;
  mon := date_trunc('month', entry.work_date)::date;
  perform gw_timecard_month_mutex(entry.tenant_id, mon);
  if gw_timecard_month_locked(entry.tenant_id, mon, entry.employee_id) then raise exception 'commute_locked'; end if;
  if tg_table_name = 'gw_time_entries' then
    update gw_commute_claims set reviewed_at = null, reviewed_by = null, revision = gen_random_uuid()
      where tenant_id = entry.tenant_id and month_start = mon and employee_id = entry.employee_id and reviewed_at is not null;
  end if;
  return entry;
end $$;
drop trigger if exists gw_payroll_entry_guard on public.gw_time_entries;
create trigger gw_payroll_entry_guard before insert or delete or update of tenant_id, employee_id, work_date,
  status, clock_in, clock_out, breaks on public.gw_time_entries for each row execute function public.gw_guard_payroll_attendance();
drop trigger if exists gw_payroll_fix_guard on public.gw_time_fixes;
create trigger gw_payroll_fix_guard before insert or update of status, tenant_id, employee_id, work_date, want
  on public.gw_time_fixes for each row execute function public.gw_guard_payroll_attendance();

-- 確定スナップショットだけを返す。社労士の担当照合と締め状態の確認は同じ文で行う。
create or replace function public.gw_commute_export(p_tenant uuid, p_month date, p_advisor uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select case when exists (select from gw_timecard_closed_months where tenant_id = p_tenant and month_start = p_month)
    then coalesce((select jsonb_agg(c.payroll order by c.payroll->>'name', c.employee_id) from gw_commute_claims c
      where c.tenant_id = p_tenant and c.month_start = p_month and c.payroll is not null
        and (p_advisor is null or (c.advisor_id = p_advisor and exists (
          select from gw_role_grants g where g.tenant_id = p_tenant and g.employee_id = p_advisor and g.role = 'labor_advisor')))), '[]'::jsonb)
    else null end
$$;

revoke all on function public.gw_timecard_month_mutex(uuid,date), public.gw_timecard_month_locked(uuid,date,uuid), public.gw_guard_payroll_attendance(),
  public.gw_commute_rows(uuid,date,uuid), public.gw_commute_overview(uuid,date,uuid), public.gw_commute_save(uuid,date,uuid,uuid,boolean,text,text,integer,date[],uuid,text),
  public.gw_commute_close(uuid,date,uuid,uuid,boolean), public.gw_commute_export(uuid,date,uuid) from public, anon, authenticated;
grant execute on function public.gw_timecard_month_mutex(uuid,date), public.gw_timecard_month_locked(uuid,date,uuid), public.gw_guard_payroll_attendance(),
  public.gw_commute_rows(uuid,date,uuid), public.gw_commute_overview(uuid,date,uuid), public.gw_commute_save(uuid,date,uuid,uuid,boolean,text,text,integer,date[],uuid,text),
  public.gw_commute_close(uuid,date,uuid,uuid,boolean), public.gw_commute_export(uuid,date,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
