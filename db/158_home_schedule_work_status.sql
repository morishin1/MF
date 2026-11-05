-- 158: ホーム「自分の予定」の対応状況
-- 対象 Supabase: lms (htglvascsuqkixpmclwr)
-- 既存の gw_calendar_events_own RLS を維持する。新しい公開範囲は増やさない。
alter table public.gw_calendar_events
  add column if not exists work_status text not null default 'todo';
alter table public.gw_calendar_events
  add column if not exists completed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.gw_calendar_events'::regclass
      and conname='gw_calendar_events_work_status_check'
  ) then
    alter table public.gw_calendar_events
      add constraint gw_calendar_events_work_status_check
      check (work_status in ('todo','doing','done'));
  end if;
end $$;
