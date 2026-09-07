-- =============================================================================
-- 045: 扶養家族を、書ける形にする
--
-- ■ いままで
--   dependents_note という自由記入の1行だった。
--   「妻・エイト ハナコ・1995-04-01」のように書いてもらう前提だったが、
--   実際には書き方が人それぞれになり、子どもが2人いる人の生年月日を
--   管理画面から拾えなかった。
--
-- ■ これから
--   dependents（jsonb の配列）に、1人ずつ入れる。
--     { name, kana, relation, birth_date, live_together, income, note }
--   別表にしなかったのは、扶養家族が本人の届出の一部でしかなく、
--   単独で検索したり集計したりする相手ではないため。
--   本人の行が消えれば一緒に消えるのが正しい。
--
--   dependents_note は消さない。すでに書いてもらった文章が入っている。
--   画面では「備考」として残す。
--
-- ■ マイナンバーはここにも入れない
--   扶養家族のマイナンバーも、番号法でいう特定個人情報。
--   1人ぶんでも列に置いた時点で、その表は特定個人情報ファイルになり、
--   取扱区域・アクセス記録・確実な廃棄まで求められる。
--   番号そのものは扶養控除等申告書（doc_dependents）とマイナンバー確認書類
--   （doc_mynumber）の画像で受け取り、Drive の「機微情報」フォルダに置く。
--   置き場所が個人フォルダの外なので、見られる人がいちばん少ない。
--   給与計算や年末調整で番号が要るときは、そのフォルダを見る。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

alter table public.gw_onboard_profiles
  add column if not exists dependents jsonb not null default '[]'::jsonb;

comment on column public.gw_onboard_profiles.dependents is
  '扶養家族。[{name, kana, relation, birth_date, live_together, income, note}] の配列。'
  'マイナンバーは入れない（番号法。書類の画像で受け取り、機微情報フォルダに置く）';

-- 配列以外が入らないようにしておく。
-- jsonb は何でも入るので、オブジェクト1個や文字列が紛れると
-- 画面側の map が落ちる
do $$
begin
  alter table public.gw_onboard_profiles
    add constraint gw_onboard_profiles_dependents_is_array
    check (jsonb_typeof(dependents) = 'array');
exception
  when duplicate_object then null;
end $$;


notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name,
--          p.birth_date, p.address, p.phone,
--          jsonb_array_length(p.dependents) as 扶養人数
--     from public.gw_onboard_profiles p
--     join public.gw_employees e on e.id = p.employee_id
--    order by e.display_name;
