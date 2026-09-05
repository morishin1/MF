-- =============================================================================
-- 028: 試用期間の判定（AI日報評価API 要件 Phase 5）
--
-- 入社日から一定期間の日報・KGI・週次評価を集計し、
-- あらかじめ決めた基準を満たしているかを機械的に判定する。
--
-- ★ ここが自動化するのは「材料集めと基準の当てはめ」まで。
--   本採用・延長・不採用の決定そのものは人が押す。
--
--   理由: これは雇用に関わる決定で、取り消しがきかない。
--   日報の提出率が低い理由（長期の外出、体調、担当の性質）は日報に書かれない。
--   数字が基準を割ったことは機械が正確に出せるが、それが本採用の可否かは
--   数字の外にある事情まで見ないと決められない。
--   システムは「何が基準を満たし、何を割ったか」を漏れなく出すところまでを担い、
--   決定は decided_by に誰が押したかを残す形にしている。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 判定の基準（テナントごと）
--    gw_workflow_settings は既にある社内の運用設定。ここに1列足す。
--
--    {
--      "months": 3,                       試用期間の長さ
--      "checkpoints": ["1m", "3m"],       どこで見るか
--      "thresholds": {
--        "submitRate": 90,                日報の提出率（%）
--        "kgiRate": 70,                   KGIの達成率（%）
--        "weeklyAvg": 70,                 週次評価の平均（100点満点）
--        "consultRate": 50,               困りごとのうち相談まで書いた割合（%）
--        "resultRate": 80                 やったことのうち結果まで書いた割合（%）
--      }
--    }
--
--    既定値は「これを割ったら必ず見直す」ではなく「ここを下回ったら
--    理由を確認する」の線として置いている。運用しながら直す前提。
-- -----------------------------------------------------------------------------
alter table public.gw_workflow_settings
  add column if not exists probation jsonb not null default '{
    "months": 3,
    "checkpoints": ["1m", "3m"],
    "thresholds": {
      "submitRate": 90,
      "kgiRate": 70,
      "weeklyAvg": 70,
      "consultRate": 50,
      "resultRate": 80
    }
  }'::jsonb;

comment on column public.gw_workflow_settings.probation is
  '試用期間の判定基準。しきい値は運用しながら直す前提の初期値';


-- -----------------------------------------------------------------------------
-- 2) チェックポイントごとの記録
--    試用期間そのものは gw_employees.joined_on と上の設定から出せるので、
--    別の台帳は作らない。台帳を持つと入社日を直したときに食い違う。
--    ここには「その時点で集計した結果」と「人が押した決定」だけを残す。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_probation_reviews (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  -- auth.users.id。日報（tc_nippo.user_id）と突き合わせるために持つ
  user_id     uuid,

  checkpoint  text not null check (checkpoint in ('1m', '3m', '6m', 'final')),
  period_from date not null,
  period_to   date not null,

  -- 集計した数字（提出率・KGI達成率・週次平均・項目別平均など）
  metrics jsonb,
  -- 基準に当てはめた結果 {"submitRate":{"value":92,"threshold":90,"pass":true}, …}
  checks  jsonb,
  -- checks から機械的に決まる。meets（全部満たす）/ partial / below
  verdict text check (verdict in ('meets', 'partial', 'below')),
  computed_at timestamptz,

  -- AIの所見。点は付けさせない。事実の要約と、確認したほうがよい点まで
  ai_status   text default 'pending'
              check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_summary  text,
  ai_strengths jsonb,
  ai_concerns  jsonb,
  ai_questions jsonb,     -- 面談で本人に確認するとよいこと
  ai_model    text,
  ai_prompt_version text,
  ai_error    text,
  ai_generated_at timestamptz,

  -- ★ 決定は人が押す。AIも、上の verdict も、ここには何も書かない
  decision      text check (decision in ('pass', 'extend', 'fail')),
  decision_note text,
  decided_by    uuid references auth.users(id) on delete set null,
  decided_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, checkpoint)
);

create index if not exists idx_gw_probation_reviews_tenant
  on public.gw_probation_reviews(tenant_id, period_to);
create index if not exists idx_gw_probation_reviews_employee
  on public.gw_probation_reviews(employee_id);

comment on table public.gw_probation_reviews is
  '試用期間のチェックポイント。集計と基準の当てはめは自動、決定は人が押す';
comment on column public.gw_probation_reviews.verdict is
  '基準を満たしたかの機械判定。本採用の可否ではない';
comment on column public.gw_probation_reviews.decision is
  '人が押した決定。ここが空なら、まだ誰も決めていない';


-- -----------------------------------------------------------------------------
-- 3) 誰が読めるか
--    人事に関わる記録なので、本人には見せない。
--    管理者・人事・経営者だけ。書き込みは service_role の API だけが行う。
--
--    本人に見せないのは、面談で伝える前に画面で先に見えてしまうと、
--    伝え方を選ぶ余地が無くなるため。面談の内容は別途 1on1 で残す。
-- -----------------------------------------------------------------------------
alter table public.gw_probation_reviews enable row level security;

drop policy if exists gw_probation_reviews_select on public.gw_probation_reviews;
create policy gw_probation_reviews_select on public.gw_probation_reviews
  for select to authenticated
  using (public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, r.checkpoint, r.verdict, r.decision, r.period_to
--     from public.gw_probation_reviews r
--     join public.gw_employees e on e.id = r.employee_id
--    order by r.period_to desc;
