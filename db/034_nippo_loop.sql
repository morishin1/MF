-- =============================================================================
-- 034: 日報を「先に描いてから動く」形にする
--
--   ゴール → 今日成功した状態を先に描く → 行動する → できたことを記録する
--   → AIがフィードバック → 翌日の行動を決める
--
-- ■ なぜ朝と夜に分けるのか（ここがこの番号の本体）
--   これまでの日報は、全部を終業時に書いていた。
--   その形のまま「今日は良かったと言える状態」という欄を足しても、
--   結果を見てから、その結果に合う状態を書いてしまう。
--   つまり「先に描く」が成立しない。順番が逆になる。
--
--   朝に描いたことが morning_at の時刻とともに残っていて、
--   夜にそれと突き合わせる。だから分ける。
--
--     朝  success_image（今日の成功の定義） + work_items の task（今日やる3つ）
--     夜  work_items の result（できたこと） + success_met + tomorrow_change
--
-- ■ 3か月後の像は毎日書かせない
--   goal_image は本人の言葉で書く「3か月後どうなっていたいか」。
--   毎日入力させると作業になるので、前日ぶんを引き継いで、
--   変えたいときだけ書き直す。
--   （3か月KGI は gw_growth_plans が持っている。こちらは会社が決めた文言、
--     goal_image は本人の言葉。両方を並べて出す）
--
-- ■ success_met は点数にしない
--   o / d / x の3つだけ。朝に描いた状態になれたかどうかを、本人が選ぶ。
--   点数にすると「何点だったか」を気にする話に戻ってしまう。
--   見たいのは「描いた状態と、実際の差」で、その差が明日変えることになる。
--
-- 前提: 025（tc_nippo の6項目化）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- 朝の入力を出した時刻。これが入っていることが「先に描いた」の証拠になる。
-- 空のまま夜の入力だけ出すこともできる（朝に書き忘れた日を弾かない）
alter table public.tc_nippo add column if not exists morning_at timestamptz;

-- ① 3か月後どうなっていたいか（本人の言葉）。前日ぶんを引き継ぐ
alter table public.tc_nippo add column if not exists goal_image text;

-- ② 今日の終わりに「今日は良かった」と言える状態。朝に書く
alter table public.tc_nippo add column if not exists success_image text;

-- ④ 朝に描いた状態になれたか。o=なれた / d=途中まで / x=ならなかった
alter table public.tc_nippo add column if not exists success_met text
  check (success_met in ('o', 'd', 'x'));

-- ⑤ 明日変えること。「明日の最優先（tomorrow_plan）」とは別。
--   最優先＝何をやるか、変えること＝やり方をどう変えるか
alter table public.tc_nippo add column if not exists tomorrow_change text;

comment on column public.tc_nippo.morning_at is
  '朝の入力を出した時刻。これが入っていれば「結果を見る前に描いた」と分かる';
comment on column public.tc_nippo.success_image is
  '今日の終わりに「今日は良かった」と言える状態。朝に書く。'
  '夜に書き足せてしまうと、結果に合わせた後付けになるので、画面側で朝しか出さない';
comment on column public.tc_nippo.goal_image is
  '3か月後どうなっていたいか。本人の言葉。毎日は書かせず、前日ぶんを引き継ぐ';
comment on column public.tc_nippo.success_met is
  '朝に描いた状態になれたか。o/d/x の3つだけ。点数にしない';
comment on column public.tc_nippo.tomorrow_change is
  '明日変えること。tomorrow_plan（何をやるか）とは別で、こちらはやり方をどう変えるか';

-- AIが出す「朝に描いた状態と、実際の差」。
-- 良かった点・改善点とは別に持つ。この仕組みの中心にある材料なので、
-- 他のコメントに混ぜると埋もれる
alter table public.gw_nippo_ai_evals add column if not exists gap text;

comment on column public.gw_nippo_ai_evals.gap is
  '朝に描いた状態と実際の差。届いていた場合も「なぜ届いたか」を書かせる';


-- 朝の入力だけ出ている日を探すのに使う。
-- 「描いたが、夜に結果を書いていない」は、その日のうちに気づきたい
create index if not exists idx_tc_nippo_morning
  on public.tc_nippo(user_id, work_date desc)
  where morning_at is not null;

notify pgrst, 'reload schema';

-- 確認:
--   select work_date, morning_at is not null as 朝, success_met,
--          left(success_image, 30) as 今日の成功, left(tomorrow_change, 30) as 明日変えること
--     from public.tc_nippo order by work_date desc limit 10;
