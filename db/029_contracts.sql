-- =============================================================================
-- 029: 雇用契約書と、そこから生まれる予定・評価
--
-- 契約書のPDFを上げると、AIが期間・条件を読み取る。
-- 読み取った内容を人が確認して確定すると、そこから
--   ・試用期間の満了日
--   ・契約更新の面談日
--   ・契約の満了日
-- が予定として並び、期日が来たら日報・KGI・週次評価を集計して判断材料を出す。
--
-- ★ AIの読み取りは必ず人が確認してから確定する。
--   契約書は間違えられない書類で、読み違いがそのまま
--   「契約満了日」や「更新の有無」になると実害が出る。
--   status が 'draft' のあいだは、予定は1つも作らない。
--
-- ★ 更新するかどうかの決定も人が押す。
--   試用期間（028）と同じ考え方。集計と基準の当てはめまでが自動で、
--   決定は誰がいつ押したかを残す。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 契約書
--    実体は Storage の hr バケットに置く。ここには置き場所と、読み取った項目。
--    1人に複数（更新のたびに増える）。いま有効なものは period_to で判る。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_contracts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  -- hr バケットの中のパス。<tenant_id>/<employee_id>/contract/<uuid>.<ext>
  file_path text,
  filename  text,

  -- draft: AIが読んだだけ。確定するまで予定は作らない
  -- active: 確定済み。ここから予定が並ぶ
  -- superseded: 更新されて、新しい契約に置き換わった
  status text not null default 'draft'
         check (status in ('draft', 'active', 'superseded')),

  -- ---- 読み取った項目（人が直せる） ----
  contract_type text,          -- 正社員 / 契約社員 / パート / アルバイト / 業務委託 / その他
  -- 有期か無期か。無期なら period_to は空
  fixed_term    boolean,
  period_from   date,
  period_to     date,

  probation_months integer,    -- 試用期間の長さ（月）。無ければ null
  probation_end    date,       -- 試用期間の満了日

  renewable      boolean,      -- 更新の可能性があるか
  renewal_criteria text,       -- 更新の判断基準（契約書に書かれている文言）
  -- 更新の面談を、満了の何日前に置くか。既定30日
  renewal_notice_days integer default 30,

  work_hours   text,           -- 所定労働時間
  work_days    text,           -- 所定労働日・休日
  work_place   text,           -- 就業場所
  job_content  text,           -- 業務内容

  wage_type    text,           -- 月給 / 時給 / 日給 / 年俸 / その他
  wage_amount  numeric,        -- 金額
  wage_note    text,           -- 手当・控除など、金額だけでは足りない条件

  -- AIが読み取った生の結果。確定後に「元は何と読んだか」を追えるように残す
  extracted jsonb,
  ai_status text default 'pending'
            check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_model  text,
  ai_prompt_version text,
  ai_error  text,
  ai_confidence text,          -- high / mid / low。低いときは画面で強く注意する

  note text,

  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  uploaded_by  uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_contracts_employee
  on public.gw_contracts(employee_id, period_from desc);
create index if not exists idx_gw_contracts_tenant_status
  on public.gw_contracts(tenant_id, status);

comment on column public.gw_contracts.status is
  'draft のあいだは予定を作らない。AIの読み取りを人が確認してから active にする';
comment on column public.gw_contracts.extracted is
  'AIが読み取った生の結果。人が直したあとも、元の読み取りを残しておく';


-- -----------------------------------------------------------------------------
-- 2) 契約から生まれる予定
--    契約を確定したときに作る。日付は契約の内容から計算する。
--    契約を直したら作り直す（人が消したものは復活させない）。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_contract_milestones (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  contract_id uuid not null references public.gw_contracts(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  kind text not null check (kind in (
    'probation_end',      -- 試用期間の満了
    'review',             -- 期中の面談（1か月・3か月など）
    'renewal_decision',   -- 更新するかどうかを決める面談
    'contract_end'        -- 契約の満了
  )),
  title  text not null,
  due_on date not null,

  -- 面談で何を見るかの期間。集計はこの範囲で行う
  period_from date,
  period_to   date,

  -- 集計と基準の当てはめ（試用期間と同じ形）
  metrics jsonb,
  checks  jsonb,
  verdict text check (verdict in ('meets', 'partial', 'below')),
  computed_at timestamptz,

  -- AIの所見。可否の判断はさせない
  ai_status text default 'pending'
            check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_summary  text,
  ai_strengths jsonb,
  ai_concerns  jsonb,
  ai_questions jsonb,
  ai_model  text,
  ai_error  text,

  -- ★ 決定は人が押す
  decision      text check (decision in ('renew', 'end', 'change', 'done')),
  decision_note text,
  decided_by    uuid references auth.users(id) on delete set null,
  decided_at    timestamptz,

  -- 人が「この予定は要らない」と消したもの。作り直しのときに復活させない
  dismissed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, kind, due_on)
);

create index if not exists idx_gw_contract_milestones_due
  on public.gw_contract_milestones(tenant_id, due_on)
  where decision is null and dismissed_at is null;

comment on table public.gw_contract_milestones is
  '契約から計算した予定。期日が来たら日報・KGIを集計して判断材料を出す。決定は人が押す';


-- -----------------------------------------------------------------------------
-- 3) 誰が読めるか
--    賃金と契約条件が入っているので、本人と、管理者・人事・経営者だけ。
--    本人が自分の契約書を見られないのは不自然なので、本人には見せる。
--    ただし milestones（面談の判断材料）は本人には見せない。
--    面談で伝える前に見えると、伝え方を選ぶ余地が無くなるため。
--
--    書き込みは service_role の API だけが行う。
-- -----------------------------------------------------------------------------
alter table public.gw_contracts           enable row level security;
alter table public.gw_contract_milestones enable row level security;

drop policy if exists gw_contracts_select on public.gw_contracts;
create policy gw_contracts_select on public.gw_contracts
  for select to authenticated
  using (
    public.gw_is_internal_staff()
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_contract_milestones_select on public.gw_contract_milestones;
create policy gw_contract_milestones_select on public.gw_contract_milestones
  for select to authenticated
  using (public.gw_is_internal_staff());


-- -----------------------------------------------------------------------------
-- 4) 契約書の実体は hr バケットへ
--    入退社の手続き書類と同じ場所。人事書類がバラバラの場所に散らないようにする。
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('hr', 'hr', false)
  on conflict (id) do nothing;

notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, c.status, c.contract_type, c.period_from, c.period_to,
--          c.probation_end, c.renewable
--     from public.gw_contracts c
--     join public.gw_employees e on e.id = c.employee_id
--    order by c.created_at desc;
--
--   select e.display_name, m.kind, m.title, m.due_on, m.verdict, m.decision
--     from public.gw_contract_milestones m
--     join public.gw_employees e on e.id = m.employee_id
--    where m.decision is null and m.dismissed_at is null
--    order by m.due_on;
