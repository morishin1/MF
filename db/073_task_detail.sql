-- =============================================================================
-- 073: タスクを「探す場所」と「処理する場所」に分ける
--
-- ■ 何のための変更か
--
--   一覧は、たくさん並んでいるほうがよい（探す場所）。
--   ただし、1件の中身を見るたびに別の画面へ飛ぶと、
--   「確認 → 戻る → また探す」で毎回行き先を見失う。
--
--   一覧はそのまま残して、右から出る引き出しの中で片付ける（処理する場所）。
--   引き出しの中で コメント と 履歴 を見るために、この2つの表を足す。
--
-- ■ 履歴を別の表にした理由
--
--   gw_activity_log は会社全体の操作ログで、社員には見せない。
--   タスクの履歴は、担当者と頼んだ人が読むもの。混ぜると、
--   「見せてよいもの」と「見せてはいけないもの」が同じ表に並ぶ。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 009_tasks.sql → 044 → 066 → 068 → 072
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 一覧と引き出しで使う列
-- -----------------------------------------------------------------------------
alter table public.gw_tasks
  -- 関連サービス・事業。「ENGER」「無限道場」など。
  -- category（分類）とは別。分類は仕事の種類、こちらはどの事業のためか
  add column if not exists service text;

comment on column public.gw_tasks.service is
  '関連サービス・事業。category（分類）とは別。一覧の絞り込みに使う';


-- -----------------------------------------------------------------------------
-- 2) コメント
--
--    担当者・頼んだ人・管理者が書く。消さない（言った言わないを残すため）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_task_comments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  task_id     uuid not null references public.gw_tasks(id) on delete cascade,

  author_id   uuid references auth.users(id) on delete set null,
  author_name text,
  body        text not null,

  created_at  timestamptz not null default now()
);

create index if not exists idx_gw_task_comments_task
  on public.gw_task_comments(task_id, created_at);


-- -----------------------------------------------------------------------------
-- 3) 履歴
--
--    作成・担当変更・期限変更・優先度変更・AI提案・完了・持ち越し。
--    追記だけ。更新も削除もしない
-- -----------------------------------------------------------------------------
create table if not exists public.gw_task_events (
  id          bigserial primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  task_id     uuid not null references public.gw_tasks(id) on delete cascade,

  kind        text not null
              check (kind in ('created', 'assigned', 'due', 'priority', 'status',
                              'focus', 'ai', 'carry', 'comment', 'edited')),
  actor_id    uuid references auth.users(id) on delete set null,
  actor_name  text,
  -- 何から何へ。{from, to, note} のような形。中身は kind ごとに決める
  detail      jsonb,

  created_at  timestamptz not null default now()
);

create index if not exists idx_gw_task_events_task
  on public.gw_task_events(task_id, created_at);


-- -----------------------------------------------------------------------------
-- 4) RLS
--
--    読めるのは、そのタスクに関係する人（担当・頼んだ人）と、人事・管理者。
--    書き込みは API（service_role）だけ
-- -----------------------------------------------------------------------------
alter table public.gw_task_comments enable row level security;
alter table public.gw_task_events   enable row level security;

drop policy if exists gw_task_comments_read on public.gw_task_comments;
create policy gw_task_comments_read on public.gw_task_comments
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or exists (
      select 1 from public.gw_tasks t
      left join public.gw_employees e on e.id = t.assignee_id
      where t.id = task_id
        and (e.user_id = auth.uid() or t.created_by = auth.uid())
    )
  );

drop policy if exists gw_task_events_read on public.gw_task_events;
create policy gw_task_events_read on public.gw_task_events
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or exists (
      select 1 from public.gw_tasks t
      left join public.gw_employees e on e.id = t.assignee_id
      where t.id = task_id
        and (e.user_id = auth.uid() or t.created_by = auth.uid())
    )
  );

notify pgrst, 'reload schema';
