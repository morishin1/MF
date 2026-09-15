-- =============================================================================
-- 068: タスクに「依頼 → 受諾 → 完了（結果）」と「繰り返し」を入れる
--
-- ■ 何を移してきたのか
--
--   旧タスク管理（8grp.co.jp/8/zimu/task/）で、実際に効いていた仕組み。
--   向こうには一覧も通知もあったが、回っていた理由はこの3つだった。
--
--   ① 頼みっぱなしにしない（done_condition / accepted_at）
--
--      「自分で上げておいて」は漏れる。頼んだ人がその場で登録する。
--      ただし登録しただけでは仕事になっていない。
--      担当者が期限と完了条件を見て「受けた」と押してはじめて、
--      両者の認識が同じになる。受けていない依頼は一覧で目立たせる。
--
--   ② 終わったことを、終わったと書く（result）
--
--      完了を押すだけだと、何をしたかが残らない。
--      頼んだ人は結局チャットで「どうなりました？」と聞くことになり、
--      やりとりがタスク管理の外で起きる。
--      完了のときに結果を1行書かせる。頼んだ人はそれを読めば済む。
--
--   ③ 決まった日に必ず出る（recur / is_template / template_id / occ_key）
--
--      月次の締め・支払・提出は、覚えている人が覚えているうちは回るが、
--      その人が休むと止まる。繰り返しの「元」を1つ置いて、
--      そこから日付ぶんを自動で作る（api/cron/tasks.js）。
--
-- ■ 表は増やさない
--
--   旧は zimu_tasks という別の表だった。ここでは gw_tasks に列を足す。
--   タスクの置き場所を2つにすると、「どっちに書いたか」を人が覚えることになる。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 009_tasks.sql / 044_share_tasks_events.sql
-- =============================================================================

alter table public.gw_tasks
  -- 頼んだ人が書く。「どうなったら終わりか」
  add column if not exists done_condition text,
  -- 担当者が「受けた」と押した時刻。ここが空なら未確認の依頼
  add column if not exists accepted_at    timestamptz,
  -- 完了のときに書く、何をしたか。頼んだ人が読む
  add column if not exists result         text,

  -- 繰り返しの「元」。一覧には出さない（出すと毎日1件ずつ増えて見える）
  add column if not exists is_template    boolean not null default false,
  -- 繰り返しの決まり {type:'daily'|'weekly'|'dom'|'biz', n, adj, weekday, daily}
  add column if not exists recur          jsonb,
  -- 自動で作られたタスクが指す「元」
  add column if not exists template_id    uuid references public.gw_tasks(id) on delete set null,
  -- 二重に作らないための鍵。'<template_id>|<YYYY-MM-DD>'
  add column if not exists occ_key        text;

comment on column public.gw_tasks.done_condition is
  '頼んだ人が書く「どうなったら終わりか」。担当者はこれを見て受諾する';
comment on column public.gw_tasks.accepted_at is
  '担当者が受けた時刻。空なら未確認の依頼として一覧で目立たせる。'
  '自分で立てたタスク（依頼者＝担当者）では使わない';
comment on column public.gw_tasks.result is
  '完了のときに書く、何をしたか。依頼した人がこれを読む。'
  '書かせないと「どうなりました？」がチャットに戻る';
comment on column public.gw_tasks.occ_key is
  '繰り返しの生成を二重にしないための鍵。template_id|YYYY-MM-DD。'
  '一意制約があるので、何度生成を回しても増えない';

-- 生成の二重防止。ここが要（cron が何度走っても増えない）
create unique index if not exists gw_tasks_occ_key_uidx
  on public.gw_tasks(occ_key) where occ_key is not null;

-- 繰り返しの「元」を引くための索引。全件なめない
create index if not exists idx_gw_tasks_template
  on public.gw_tasks(tenant_id) where is_template;

-- 未確認の依頼を引くための索引。ホームと一覧が毎回ここを見る
create index if not exists idx_gw_tasks_waiting
  on public.gw_tasks(tenant_id, assignee_id)
  where accepted_at is null and status in ('todo', 'doing');

-- -----------------------------------------------------------------------------
-- 繰り返しの「元」は、一覧から外す
--
--   RLS はそのまま（見える範囲は 009 / 044 で決めてある）。
--   ここでやるのは「元は普通のタスクではない」という印だけ。
--   期限も担当も持つが、やる仕事ではないので、
--   読み出す側（api/tasks）が is_template を外して返す
-- -----------------------------------------------------------------------------

notify pgrst, 'reload schema';

-- 確認:
--   select title, is_template, recur, occ_key, accepted_at, done_condition
--     from public.gw_tasks
--    where is_template or occ_key is not null
--    order by created_at desc limit 20;
