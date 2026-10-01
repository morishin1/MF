-- =============================================================================
-- 099: TimeRex連携を「カジュアル面談・社長面談」の両方へ広げる
--
-- ■ 何を足すか（gw_hr_interviews に列を足すだけ。新しい表は作らない）
--   timerex_calendar_path    … どの予約枠（TimeRex の calendar_url_path）から来た予約か。
--                              面談の種類（カジュアル／社長）の判定に使った値を残す
--   timerex_reschedule_url   … 日程変更の導線（TimeRex が発行する guest_reschedule_url）
--   timerex_guest_cancel_url … 候補者向けのキャンセル導線（guest_cancel_url）
--   timerex_host_cancel_url  … 主催者向けのキャンセル導線（host_cancel_url）
--
-- ■ TimeRex を正とする
--   timerex_event_id がある面談は、HR 画面で日時・キャンセル・Meet URL を直接書き換えない
--   （api/hr/interviews.js が 409 で止める）。日程変更・取消は上の URL から TimeRex で行い、
--   Webhook で HR に反映する。手動登録の面談（timerex_event_id が空）は今までどおり HR で直せる。
--
-- ■ URL の扱い
--   採用HR の画面（面談タブ）にだけ出す。監査ログ・通知には入れない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等。2回流してもよい）
-- 前提: 089_hr_timerex_sync.sql・090_hr_interview_cancel.sql
-- =============================================================================

begin;

alter table public.gw_hr_interviews
  add column if not exists timerex_calendar_path    text,
  add column if not exists timerex_reschedule_url   text,
  add column if not exists timerex_guest_cancel_url text,
  add column if not exists timerex_host_cancel_url  text;

comment on column public.gw_hr_interviews.timerex_calendar_path is
  'TimeRex の予約枠（calendar_url_path）。カジュアル／社長の判定に使った値（lib/hr-timerex-calendars.js）';
comment on column public.gw_hr_interviews.timerex_reschedule_url is
  'TimeRex の日程変更URL（guest_reschedule_url）。採用HRの画面だけに出し、ログには残さない';

commit;

notify pgrst, 'reload schema';

-- 確認:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'gw_hr_interviews' and column_name like 'timerex_%'
--    order by column_name;
