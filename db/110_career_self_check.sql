-- =============================================================================
-- 110: キャリア基準の本人自己チェック（GW キャリア基準「10件表示・本人自己チェック」改善）
--
-- ■ 何をするものか
--   career.html の確認カードが「あと必要なこと 0 / 10」と出しながら、実際は
--   （表示側の slice(0, 6) のせいで）6件しか見えなかった。あわせて、本人が
--   自分の認識を入力できる場所も無かった（□は表示だけで押せない）。
--
--   ここでは gw_employee_careers に、本人の自己チェックだけを持たせる。
--     self_check_results      … [{criterionId, checked, checkedAt}]
--     self_check_updated_at   … 本人が最後にチェックを変えた日時
--
-- ■ 本人自己チェック ≠ 正式評価（最重要）
--   本人がチェックしても gw_career_reviews.criterion_results（確定済み評価）は
--   いっさい変えない。自己チェックは「自分ではできるようになったと思う」という
--   自己申告であり、正式なLevel判定は今までどおり評価面談で上長・評価者が確定する。
--   書き込みは api/career/me.js（本人・自分の分だけ）。上長・管理者は閲覧のみ
--   （api/career/index.js の detail に self_check_results を混ぜて返す。正式評価とは別の列のまま渡す）。
--
-- ■ 新しい大きな表は作らない
--   既存の gw_employee_careers に、JSONB列を1つ足すだけ。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 092_career.sql
-- =============================================================================

begin;

alter table public.gw_employee_careers
  add column if not exists self_check_results jsonb not null default '[]'::jsonb;
alter table public.gw_employee_careers
  add column if not exists self_check_updated_at timestamptz;

comment on column public.gw_employee_careers.self_check_results is
  '本人の自己チェック（[{criterionId, checked, checkedAt}]）。'
  '正式評価（gw_career_reviews.criterion_results）とは別。本人がチェックしても正式評価は変わらない';

commit;

notify pgrst, 'reload schema';

-- 確認:
--   select employee_id, jsonb_array_length(self_check_results) as checked_items, self_check_updated_at
--     from public.gw_employee_careers where jsonb_array_length(self_check_results) > 0
--    order by self_check_updated_at desc nulls last limit 20;
