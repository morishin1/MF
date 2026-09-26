-- =============================================================================
-- 084: CEO REVIEW（社長は「会う」「判断する」だけに集中する）
--
-- ■ 表は増やさない。gw_hr_applicants に、判断まわりの短い文だけ足す
--
--   recommend_note … 人事が「社長推薦する」を押すときに書く、短い推薦理由。
--                     社長が応募書類を最初から読まなくても、
--                     「なぜ自分が会う必要があるのか」が分かるようにするためのもの
--   decision_note   … 内定・見送りを確定するときの、任意の一言コメント
--   hold_reason     … 保留にした理由
--   hold_next_step  … 保留のとき、次に確認すること
--
--   「良かった点」「気になる点」は新しい列を作らない。既存の面談評価
--   （gw_hr_interviews.recommend_reason / notes、072ではなく081で追加済み）
--   をそのままCEO REVIEWのカードにも出す（二重に持たない）。
--
--   再判断期限は、既存の gw_hr_applicants.decision_due_on をそのまま使う
--   （対応期限という同じ意味の列を2つ持たない）。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 081_hr_recruiting.sql
-- =============================================================================

alter table public.gw_hr_applicants
  add column if not exists recommend_note text,
  add column if not exists decision_note  text,
  add column if not exists hold_reason    text,
  add column if not exists hold_next_step text;

comment on column public.gw_hr_applicants.recommend_note is
  '社長推薦時の短い推薦理由。社長が30秒で「会う理由」が分かるようにするためのもの';
comment on column public.gw_hr_applicants.decision_note is
  '内定・見送りを確定するときの、任意の一言コメント';
comment on column public.gw_hr_applicants.hold_reason is
  '保留にした理由';
comment on column public.gw_hr_applicants.hold_next_step is
  '保留のとき、次に確認すること（NEXT ACTIONにそのまま出す）';

notify pgrst, 'reload schema';
