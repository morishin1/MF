-- =============================================================================
-- 082: 明日の3タスクを、3人一組の対話で深掘りする（ペアコーチング）
--
-- ■ 何のための仕組みか
--
--   目的は承認ではない。「候補者を10名探す」のような作業だけの書き方を、
--   聞き役との対話で「何を得たいか」「なぜ明日やるか」「どこまでできたら
--   完了か」まで深掘りする。決めるのは常に本人（聞き役は質問するだけ）。
--
-- ■ 表は増やさず、gw_tasks に列を足すだけ
--
--   目的（purpose）・完了条件（done_condition）は 072 で既にある。
--   ここで足すのは「得たい結果」「なぜ明日やるか」と、
--   コーチングを終えた記録（いつ・誰と）だけ。
--
-- ■ 3人一組の相手は、その場で本人が選ぶ
--
--   固定チームは作らない。coached_with に、そのとき組んだ2人の
--   employee_id・名前をそのまま残す（あとで「誰と組んだか」を見返せれば十分）。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 072_focus_tasks.sql
-- =============================================================================

alter table public.gw_tasks
  -- それができると何が前に進むか（成果）。目的（purpose）は「なぜ」、
  -- こちらは「何が得られたら成功か」を言葉にしたもの
  add column if not exists outcome         text,
  -- なぜ明日やる必要があるか
  add column if not exists tomorrow_reason text,

  -- コーチングを終えた時刻。null なら未実施
  add column if not exists coached_at      timestamptz,
  -- そのとき組んだ相手（本人以外の2人）。[{employeeId, name}, ...]
  add column if not exists coached_with    jsonb;

comment on column public.gw_tasks.outcome is
  '得たい結果（成果）。目的（purpose）だけでは「作業になっている」ため、対話で深掘りする';
comment on column public.gw_tasks.tomorrow_reason is
  'なぜ明日やる必要があるか。ペアコーチングの対話で確認する';
comment on column public.gw_tasks.coached_at is
  'ペアコーチング（聞き方ガイドに沿った対話）を終えた時刻。承認ではなく本人が決める';
comment on column public.gw_tasks.coached_with is
  '組んだ相手2人（本人以外）。固定チームではなく、その場で本人が選ぶ';

notify pgrst, 'reload schema';
