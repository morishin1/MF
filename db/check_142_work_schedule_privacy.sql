-- 142 適用確認（読み取り専用）
select case
  when to_regclass('public.gw_calendar_events') is null then 'NG: 予定表がありません'
  when exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='gw_calendar_events'
      and policyname='gw_calendar_events_peer_select'
  ) then 'NG: 旧共有SELECT policy が残っています'
  when not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='gw_calendar_events'
      and policyname='gw_calendar_events_own'
  ) then 'NG: 本人用policyがありません'
  else 'OK: 本人用RLSを維持し、社員の業務予定は安全なAPIから参照'
end as check_result;
