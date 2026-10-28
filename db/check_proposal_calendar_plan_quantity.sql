-- DRAFT / NOT EXECUTED. Read-only schema checks; no employee/event data is read.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'gw_calendar_events'
  and column_name in ('planned_quantity', 'planned_quantity_unit')
order by column_name;
-- Expect numeric/text, nullable YES, no default. Missing rows mean NOT available.

select conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.gw_calendar_events'::regclass
  and conname in ('gw_calendar_events_planned_quantity_range', 'gw_calendar_events_planned_quantity_unit_length')
order by conname;
-- Expect both constraints validated; range 0..1000000000 / unit <=10 characters.

select relrowsecurity from pg_class where oid = 'public.gw_calendar_events'::regclass;
select policyname, cmd, qual, with_check from pg_policies
where schemaname = 'public' and tablename = 'gw_calendar_events' order by policyname;
-- Compare to pre-change baseline. Existing own-only RLS must be unchanged.
