-- 166: 商談候補の公開可能リストを最大30件まで共有。会社紹介だけの0件商談も許可。
begin;
alter table public.gw_sales_live_meeting_sessions
 drop constraint if exists live_session_selection_array;
alter table public.gw_sales_live_meeting_sessions
 add constraint live_session_selection_array check (
  jsonb_typeof(selected_keys)='array' and
  jsonb_array_length(selected_keys) between 0 and 30
 );
commit;
notify pgrst, 'reload schema';
