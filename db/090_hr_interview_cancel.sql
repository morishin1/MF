-- =============================================================================
-- 090: 面談キャンセルの最小追加（応募者削除とは分けて扱う）
--
-- ■ 何のため
--   面談をキャンセルしても、応募者レコードは消さないし、面談履歴も
--   物理DELETEしない（採用HR応募者一覧・ドロワーUI改善指示書 §3・§6）。
--   代わりに、いつ・キャンセルされたかを1列で残す。
--
--   canceled_at … この面談がキャンセルされた日時。nullなら有効な面談
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 081_hr_recruiting.sql
-- =============================================================================

alter table public.gw_hr_interviews
  add column if not exists canceled_at timestamptz;

comment on column public.gw_hr_interviews.canceled_at is
  'この面談がキャンセルされた日時。nullなら有効な面談（履歴として残すため物理削除しない）';

notify pgrst, 'reload schema';
