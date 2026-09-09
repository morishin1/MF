-- =============================================================================
-- 049: AI提案の選別と、期日から逆算した並べ替え
--
-- ■ AIの提案を、いきなり「やること」にしない
--   日報を出すたびにAIの提案がそのまま並ぶと、
--   その提案を片づけること自体が仕事になる。
--   採用するかどうかを人が決めてから、はじめて「やること」になる。
--
--   新しい表は作らない。同じ gw_action_items に proposed という状態を足す。
--   別の表にすると、採用のたびに移し替えることになり、
--   「どこにあるのが本物か」が増える。
--
--     proposed … AIが出しただけ。まだ本人は見ていない／決めていない
--     open     … 本人が採用した。ホームと「やること」に出る
--     dropped  … 却下した。消さずに残す（何を断ったかも判断の記録）
--
-- ■ ピン留め
--   期日から逆算した並びは、たいていは合っている。
--   ただし「今日は何があってもこれをやる」は本人にしか分からない。
--   pinned_at が入っているものは、並べ替えても動かさない。
--
-- ■ 見積時間
--   任意。入っていれば「期日は明日だが3時間かかるので今日から」と言える。
--   入力を必須にはしない。毎朝の見積りが仕事になると本末転倒になる。
-- =============================================================================

-- ---- 状態に proposed を足す ---------------------------------------------------
alter table public.gw_action_items
  drop constraint if exists gw_action_items_status_check;

alter table public.gw_action_items
  add constraint gw_action_items_status_check
  check (status in ('proposed', 'open', 'done', 'dropped'));

comment on column public.gw_action_items.status is
  'proposed=AIが出しただけ（本人が採用するまで画面に出さない） / open=やること / '
  'done=終わった / dropped=やらないと決めた。'
  'dropped も残す。やらないと決めたことも判断の記録';

-- ---- ピン留め -----------------------------------------------------------------
alter table public.gw_action_items
  add column if not exists pinned_at timestamptz;

comment on column public.gw_action_items.pinned_at is
  '本人が「今日はこれをやる」と固定した時刻。'
  '入っているものは、期日からの自動並べ替えでも順番を動かさない';

-- ---- 見積時間（任意） ----------------------------------------------------------
alter table public.gw_action_items
  add column if not exists estimate_min integer;

do $$
begin
  alter table public.gw_action_items
    add constraint gw_action_items_estimate_range
    check (estimate_min is null or (estimate_min > 0 and estimate_min <= 2400));
exception
  when duplicate_object then null;
end $$;

comment on column public.gw_action_items.estimate_min is
  'かかりそうな時間（分）。任意。'
  '入っていれば「期日は先だが時間がかかるので今日から」を出せる';

-- ---- 提案を引くための索引 ------------------------------------------------------
create index if not exists idx_gw_action_items_proposed
  on public.gw_action_items(user_id, status, created_at)
  where status = 'proposed';

-- 「今日の最優先は1人1日ひとつ」は open のときだけ。
-- proposed が priority=1 で複数あっても、まだ画面には出ていないので構わない。
-- （既存の索引が status='open' 前提なので、そのままで正しい）

notify pgrst, 'reload schema';

-- 確認:
--   -- 未処理の提案
--   select user_id, count(*) from public.gw_action_items
--    where status = 'proposed' group by user_id;
--
--   -- ピン留めされているもの
--   select title, due_date, pinned_at from public.gw_action_items
--    where pinned_at is not null and status = 'open' order by pinned_at desc;
