-- =============================================================================
-- 047: 1日のリズムに合わせて、日報の項目をそろえる
--
-- ■ 決まった1日の流れ
--     9:00  朝1分   … 今日のゴールイメージ → 今日やること
--    14:00  30秒     … KPIの進み・予定との差・午後の最優先（見るだけ）
--    17:45  日報     … KPI実績／今日の成果／朝のゴールは達成できたか／
--                       今日のデキタ3つ／困ったこと／改善したこと／明日の最優先
--            → AIフィードバック → 翌日のNEXT ACTION
--
-- ■ 036 で外したものを、2つ戻す
--   success_met（朝に描いた状態になれたか）と improve_tags（改善したこと）は、
--   036 で「項目が多い」として日報から外した。列は残してある。
--   ただ、朝にゴールを描かせておいて夜に照らし合わせないと、
--   朝の1分が「書いて終わり」になる。照らし合わせるところまでが1日の輪。
--   同じ理由で、改善も戻す。
--
-- ■ 足すのは2つだけ
--   wins          … 今日の「デキタ」3つ
--   improved_note … 改善したことの一言
--
--   デキタは成果とは別もの。
--   成果は「何が終わったか」、デキタは「何ができるようになったか」。
--   成果が出ない日でもデキタはあるし、それを書き留める日が続かないと、
--   伸びている実感が本人に残らない。
--
--   3つに限ったのは、多いほうがよいものではないから。
--   欄が5つあると、埋めるために薄いものを足すことになる。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- 今日の「デキタ」3つ。["先方の質問に自分で答えられた", ...]
alter table public.tc_nippo
  add column if not exists wins jsonb not null default '[]'::jsonb;

-- 改善したこと。improve_tags（選択）に添える一言
alter table public.tc_nippo
  add column if not exists improved_note text;

comment on column public.tc_nippo.wins is
  '今日の「デキタ」3つ。文字列の配列（最大3件）。'
  '成果（work_items の result）とは別で、できるようになったことを書く';
comment on column public.tc_nippo.improved_note is
  '改善したことの一言。分類は improve_tags（034）を使う';

-- 配列以外が入らないようにしておく。
-- jsonb は何でも入るので、文字列やオブジェクトが紛れると画面の map が落ちる
do $$
begin
  alter table public.tc_nippo
    add constraint tc_nippo_wins_is_array
    check (jsonb_typeof(wins) = 'array');
exception
  when duplicate_object then null;
end $$;


notify pgrst, 'reload schema';

-- 確認:
--   select work_date,
--          morning_at is not null as 朝,
--          success_met            as ゴール,
--          jsonb_array_length(wins) as デキタ,
--          improved_note is not null as 改善,
--          submitted_at is not null as 提出
--     from public.tc_nippo
--    where user_id = auth.uid()
--    order by work_date desc limit 14;
