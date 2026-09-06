-- =============================================================================
-- 036: 日報をメンバー向けに絞る／「みんなの日報」を作る
--
-- ■ 書く量を減らす
--   朝は4つ、夜は5つだけにした。
--     朝  今日の最優先 / 今日やること（最大3件） / 今日のKPI（対象者のみ）/ 困っていること
--     夜  今日できたこと / KPI実績 / 未完了と理由 / 明日やること / 相談事項
--
--   これまでの項目（3か月後の像・今日成功した状態・改善と学びのタグ・
--   顧客とチームのためにしたこと・明日変えること）は列を消さずに残す。
--   過去の日報がそのまま読めなくなるほうが困る。画面から外すだけ。
--
--   「未完了と理由」は独立した欄にせず、朝に書いた3件の中に持たせる。
--   朝の各行に result（できたこと）か undone_reason（できなかった理由）の
--   どちらかを書く形にすると、欄が増えずに両方そろう。
--   work_items は jsonb なので、この変更に DDL は要らない。
--
-- ■ 「みんなの日報」を、日報そのものとは別の表にする
--   他の人に見せるのは、AIが作った共有用サマリー（今日やったこと・成果・
--   学び・明日やること）の4つだけ。
--
--   点数・未達理由・相談事項・個人評価・管理者コメントは見せない。
--   同じ表に入れておいて「この列だけ返す」形にすると、
--   API の書き間違い1つで全部出てしまう。
--   だから公開してよい4項目しか入っていない表を別に作る。
--   この表を丸ごと返しても、出てはいけないものが出ない。
--
--   サマリーを作るAIにも、相談事項と未完了理由は渡さない（lib/nippo-share.js）。
--   渡さなければ、書きようがない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 日報。朝と夜の新しい項目
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists top_priority   text;
alter table public.tc_nippo add column if not exists morning_note   text;
alter table public.tc_nippo add column if not exists consult_note   text;

comment on column public.tc_nippo.top_priority is
  '今日の最優先。朝に1つだけ書く。今日という日を何で判断するか';
comment on column public.tc_nippo.morning_note is
  '朝の時点で困っていること（任意）。始める前から詰まっているものを拾う';
comment on column public.tc_nippo.consult_note is
  '終業時の相談事項（任意）。本人と管理者だけが見る。みんなの日報には出さない';
comment on column public.tc_nippo.work_items is
  '朝に task を書き、夜に result（できたこと）か undone_reason（できなかった理由）を書く。'
  '最大3件。未完了の欄を別に作らず、ここで両方そろえる';


-- -----------------------------------------------------------------------------
-- 2) AI評価。本人向けに返す「達成度」
--    良かった点・改善点・明日の優先事項は既にある（026 / 030 / 034）
-- -----------------------------------------------------------------------------
alter table public.gw_nippo_ai_evals add column if not exists achievement text;

comment on column public.gw_nippo_ai_evals.achievement is
  '達成度。朝に決めた最優先とやること3件に対して、実際どうだったか。1〜2文。'
  '点数ではなく言葉で返す';


-- -----------------------------------------------------------------------------
-- 3) みんなの日報（公開サマリー）
--
--    ★ この表には、公開してよい4項目しか入れない。
--      点数・未達理由・相談事項・個人評価・管理者コメントは入れない。
--      入っていないものは、間違って返すこともできない。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_nippo_shares (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- 日報1件につき1つ。作り直したら上書きする
  nippo_id  uuid not null unique,
  user_id   uuid not null references auth.users(id) on delete cascade,
  user_name text,
  work_date date not null,

  -- AIが作る4項目。どれも1〜2文
  did      text,   -- 今日やったこと
  result   text,   -- 成果
  learn    text,   -- 学び
  tomorrow text,   -- 明日やること

  -- 本人が「みんなには出さない」を選べる。
  -- 出したくない日を1日も作れないと、書く内容のほうが薄くなる
  visible boolean not null default true,

  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_nippo_shares_date
  on public.gw_nippo_shares(tenant_id, work_date desc);
create index if not exists idx_gw_nippo_shares_user
  on public.gw_nippo_shares(user_id, work_date desc);


-- -----------------------------------------------------------------------------
-- 4) 「参考になった」
--    1人1回。取り消せる。数だけを見せ、誰が押したかは名前まで出す
--    （社内なので匿名にする理由がなく、匿名だと押し合いの意味が薄れる）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_nippo_reactions (
  id       uuid primary key default gen_random_uuid(),
  share_id uuid not null references public.gw_nippo_shares(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  user_name text,
  kind     text not null default 'helpful' check (kind in ('helpful')),
  created_at timestamptz not null default now(),
  unique (share_id, user_id, kind)
);

create index if not exists idx_gw_nippo_reactions_share
  on public.gw_nippo_reactions(share_id);


-- -----------------------------------------------------------------------------
-- 5) ひとことコメント
--    長文のやり取りは社内メッセージ（gw_messages）でやる。
--    ここは「参考になった」の一歩先くらいの短いものだけ
-- -----------------------------------------------------------------------------
create table if not exists public.gw_nippo_comments (
  id       uuid primary key default gen_random_uuid(),
  share_id uuid not null references public.gw_nippo_shares(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  user_name text,
  body     text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gw_nippo_comments_share
  on public.gw_nippo_comments(share_id, created_at);


-- -----------------------------------------------------------------------------
-- 6) RLS
--    読むのは社内の人だけ。書き込みは service_role の API だけが行う
--    （本人以外の名前で押せてしまうと、リアクションの意味が無くなる）。
-- -----------------------------------------------------------------------------
alter table public.gw_nippo_shares    enable row level security;
alter table public.gw_nippo_reactions enable row level security;
alter table public.gw_nippo_comments  enable row level security;

drop policy if exists gw_nippo_shares_select on public.gw_nippo_shares;
create policy gw_nippo_shares_select on public.gw_nippo_shares
  for select to authenticated
  using (public.gw_is_internal_staff() and (visible or user_id = auth.uid()));

drop policy if exists gw_nippo_reactions_select on public.gw_nippo_reactions;
create policy gw_nippo_reactions_select on public.gw_nippo_reactions
  for select to authenticated
  using (public.gw_is_internal_staff());

drop policy if exists gw_nippo_comments_select on public.gw_nippo_comments;
create policy gw_nippo_comments_select on public.gw_nippo_comments
  for select to authenticated
  using (public.gw_is_internal_staff());


notify pgrst, 'reload schema';

-- 確認:
--   -- 朝と夜の新しい欄
--   select work_date, top_priority, jsonb_array_length(coalesce(work_items,'[]')) as やること,
--          consult_note is not null as 相談あり
--     from public.tc_nippo order by work_date desc limit 10;
--
--   -- みんなの日報。ここに点数・相談事項が入っていないことを目で確かめる
--   select work_date, user_name, did, result, learn, tomorrow, visible
--     from public.gw_nippo_shares order by work_date desc limit 10;
