-- =============================================================================
-- 074: とりあえずメモ
--
-- ■ 何のための表か
--
--   日中に発生した業務を、その場で1秒で吐き出す場所。
--   期日・担当者・完了条件は要らない。1行だけでよい。
--
--   gw_tasks に混ぜない。混ぜると「明日の3タスク」「今日やる3つ」の集計や
--   一覧・KPIに、まだ何も決まっていない書きかけの行が紛れ込む。
--   分けておけば、タスク側のロジックには一切手を入れずに済む。
--
-- ■ 昇格は、退勤時にAIが見てから人が決める
--
--   AIが提案するのは4つだけ（lib/quick-memo.js の DECISION_CHOICES）。
--     task … 正式タスク化（gw_tasks の行を作る）
--     self … もう自分で片付けた。タスク化は要らない
--     hand … 他の人に頼む（gw_tasks の行を、その人の担当で作る）
--     drop … 不要だった
--
--   決めるのは人。AIは案と理由を返すだけ（lib/task-ai.js reviewMemos）。
--   task/hand を選んだときだけ gw_tasks に1行作り、promoted_task_id に残す。
--   promoted_task_id が付いたメモは、以後この画面には出さない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

create table if not exists public.gw_quick_memos (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  -- 1行だけ。長い説明はここに書かせない（タスク化するときに初めて書く）
  body text not null,

  -- open … まだ決めていない（一覧・退勤時の提案に出る）
  -- decided … 決めた（task/self/hand/drop のいずれか）。以後出さない
  status text not null default 'open'
         check (status in ('open', 'decided')),

  decision text check (decision in ('task', 'self', 'hand', 'drop')),
  decision_note text,     -- hand で渡した相手の名前など、決めたときの補足
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,

  -- task/hand で作った先。ここに値があれば、そのタスクへ飛べる
  promoted_task_id uuid references public.gw_tasks(id) on delete set null,

  -- AIの提案（decision と同じ4値）。人が決めるまでの参考表示用
  ai_decision text check (ai_decision in ('task', 'self', 'hand', 'drop')),
  ai_reason   text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_quick_memos_open
  on public.gw_quick_memos(tenant_id, employee_id, created_at)
  where status = 'open';

comment on table public.gw_quick_memos is
  '期日・担当者なしで1行だけ残す、業務発生時のメモ。退勤時にAIが見て、人が正式タスク化するかを決める';

-- -----------------------------------------------------------------------------
-- RLS
--
-- 読めるのは本人と人事・管理者。書き込みはAPI（service_role）だけ
-- -----------------------------------------------------------------------------
alter table public.gw_quick_memos enable row level security;

drop policy if exists gw_quick_memos_read on public.gw_quick_memos;
create policy gw_quick_memos_read on public.gw_quick_memos
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or exists (
      select 1 from public.gw_employees e
      where e.id = employee_id and e.user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, m.body, m.status, m.decision, m.created_at
--     from public.gw_quick_memos m
--     join public.gw_employees e on e.id = m.employee_id
--    where m.status = 'open'
--    order by m.created_at desc;
