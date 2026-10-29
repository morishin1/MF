-- DRAFT / NOT APPLIED. Operator review and explicit approval required before use.
-- Adds optional plan numbers only. No RLS, grants, roles or existing values change.
-- Calendar plan quantities are not execution evidence and must not feed HR scores.
begin;
-- Fail closed even for a previous partial/successful application. Never silently
-- accept existing columns or same-named constraints with unknown definitions.
do $$
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gw_calendar_events'
      and column_name in ('planned_quantity', 'planned_quantity_unit'))
    or exists (select 1 from pg_constraint
      where conrelid = 'public.gw_calendar_events'::regclass
        and conname in ('gw_calendar_events_planned_quantity_range', 'gw_calendar_events_planned_quantity_unit_length')) then
    raise exception 'Calendar quantity schema already exists or is partially applied; stop and inspect columns/constraints before any change.';
  end if;
end $$;
alter table public.gw_calendar_events
  add column planned_quantity numeric,
  add column planned_quantity_unit text;
alter table public.gw_calendar_events add constraint gw_calendar_events_planned_quantity_range
  check (planned_quantity is null or (planned_quantity >= 0 and planned_quantity <= 1000000000)) not valid;
alter table public.gw_calendar_events add constraint gw_calendar_events_planned_quantity_unit_length
  check (planned_quantity_unit is null or char_length(planned_quantity_unit) <= 10) not valid;
alter table public.gw_calendar_events validate constraint gw_calendar_events_planned_quantity_range;
alter table public.gw_calendar_events validate constraint gw_calendar_events_planned_quantity_unit_length;
comment on column public.gw_calendar_events.planned_quantity is 'Optional planned output quantity; not actual completion or verified evidence.';
comment on column public.gw_calendar_events.planned_quantity_unit is 'Optional unit for the planned output quantity (up to 10 characters).';
commit;
notify pgrst, 'reload schema';
