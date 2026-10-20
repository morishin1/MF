-- 142: 社員の仕事予定は /api/schedule/team で全員へ、メモは本人だけ。
-- 044 の peer_select は「公開した予定の行全体」を読めるため、
-- 画面上で本文を隠しても Supabase の直接リクエストで body が見えてしまう。
-- 017 の本人用 policy は残し、他人への公開をAPI経由の安全な列だけに限定する。
-- 本番では PR をマージする前に SQL Editor で適用してください。
begin;
  drop policy if exists gw_calendar_events_peer_select on public.gw_calendar_events;
  -- 既存の本人用 gw_calendar_events_own (for all) は変更しない。
  -- 旧 visibility private の業務予定も、本人が消すまで保存したまま。
commit;
notify pgrst, 'reload schema';

-- 実行後確認用:
-- select policyname, cmd, qual from pg_policies
-- where schemaname='public' and tablename='gw_calendar_events'
-- order by policyname;
-- 結果に gw_calendar_events_peer_select が無いこと。
