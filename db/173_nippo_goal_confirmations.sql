-- Daily goal confirmation is an employee's explicit acknowledgement, not an AI draft.
-- Live reports are in tc_nippo; this table records timing without pretending a late goal was set in the morning.
CREATE TABLE IF NOT EXISTS public.gw_nippo_goal_confirmations (
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES public.gw_employees(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  work_date date NOT NULL,
  task_title text NOT NULL CHECK (length(trim(task_title)) BETWEEN 2 AND 300),
  goal_text text NOT NULL CHECK (length(trim(goal_text)) BETWEEN 5 AND 500),
  done_when text NOT NULL CHECK (length(trim(done_when)) BETWEEN 5 AND 500),
  source text NOT NULL CHECK (source IN ('company','provisional')),
  timing text NOT NULL CHECK (timing IN ('on_time','late')),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,employee_id,work_date)
);
CREATE INDEX IF NOT EXISTS gw_nippo_goal_confirm_user_week_idx
  ON public.gw_nippo_goal_confirmations (tenant_id,user_id,work_date DESC);
ALTER TABLE public.gw_nippo_goal_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gw_nippo_goal_confirmations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.gw_nippo_goal_confirmations TO service_role;
COMMENT ON TABLE public.gw_nippo_goal_confirmations IS
 '本人が確定した日次ゴールと完了条件。後から入力した場合は timing=late。本人認証済APIのみで閲覧・変更。';
