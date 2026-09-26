-- =============================================================================
-- 083: 面談（gw_hr_interviews）に、面談へ入るためのURLを持たせる
--
-- 081で持っているのは recording_url（面談が終わったあとの録画）だけ。
-- 面談の前に要るのは、入るためのURL（Google Meet等）で、別物。
-- 両方が同時に要る（前は入室リンク、後は録画）ので、列を分ける。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 081_hr_recruiting.sql
-- =============================================================================

alter table public.gw_hr_interviews
  add column if not exists meeting_url text;

comment on column public.gw_hr_interviews.meeting_url is
  '面談に入るためのURL（Google Meet等）。録画（recording_url）とは別に持つ';

notify pgrst, 'reload schema';
