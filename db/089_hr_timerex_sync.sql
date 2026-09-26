-- =============================================================================
-- 089: TimeRex連携（カジュアル面談の日程調整・Google Meet自動連携）の最小追加
--
-- ■ 何のため
--   TimeRex Webhookから予約確定を受け取ったとき、同じ予約Webhookが再送されても
--   gw_hr_interviews を2重に作らないための「重複防止キー」だけを先に用意する。
--
--   timerex_event_id  … TimeRexの日程調整（予約）ごとの一意なID。Webhookが
--                        再送されても、これで「もう反映済みか」を判定する
--   timerex_synced_at … Webhookから最後に反映した日時（手動設定の面談はnullのまま）
--
-- ■ Webhook受信そのものはここでは実装しない
--   TimeRex公式の実event名・payload構造・認証方式を、実際の予約1件で確認して
--   からでないと、受信側のparserを正しく書けないため（推測実装をしない）。
--   この089は、その前に必要な「保存先」だけを先に用意しておくもの。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 081_hr_recruiting.sql, 083_hr_interview_meeting_url.sql
-- =============================================================================

alter table public.gw_hr_interviews
  add column if not exists timerex_event_id  text,
  add column if not exists timerex_synced_at timestamptz;

comment on column public.gw_hr_interviews.timerex_event_id is
  'TimeRexの日程調整（予約）ごとの一意なID。Webhook再送時の重複作成を防ぐためのキー';
comment on column public.gw_hr_interviews.timerex_synced_at is
  'TimeRex Webhookからこの行を最後に反映した日時。手動で設定した面談ではnull';

-- 同じ予約（tenant内で同じevent_id）から2行できないようにする。
-- timerex_event_id が無い（＝手動設定の）行同士は対象外にする
create unique index if not exists gw_hr_interviews_timerex_event_uidx
  on public.gw_hr_interviews (tenant_id, timerex_event_id)
  where timerex_event_id is not null;

notify pgrst, 'reload schema';
