-- =============================================================================
-- 038: 社員名簿に「備考」を足す
--
-- 新規メンバー登録フォームに備考の欄があるのに、
-- gw_employees には入れる場所が無かった。
-- そのため登録が「名簿への登録」の段でエラーになっていた
--   Could not find the 'note' column of 'gw_employees' in the schema cache
--
-- 備考は、その人についてのメモ（前職・紹介元・配慮事項など）。
-- 契約（gw_contracts.note）は「その契約書についてのメモ」で別のものなので、
-- そちらに相乗りさせない。契約は更新のたびに行が増えるが、
-- 人についてのメモは1つでよい。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

alter table public.gw_employees
  add column if not exists note text;

comment on column public.gw_employees.note is
  'その人についてのメモ。契約書についてのメモ（gw_contracts.note）とは別';


notify pgrst, 'reload schema';

-- 確認:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'gw_employees'
--      and column_name = 'note';
