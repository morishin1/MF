-- =============================================================================
-- 077: 月次請求進捗（優先5・最小構成）
--
-- ■ 請求書そのものは、まだ内製化しない
--
--   最初に作るのは、進捗の5段階だけ。
--     勤務表受領 → 稼働確認 → Board作成 → 送付 → BP請求書受領
--   実際の請求書生成・送付は、Board（既存の請求ツール）に任せる。
--   ここでは「どこまで進んだか」だけを、1行にして持つ。
--
-- ■ 対象月 × メンバー × 契約 で一意
--
--   同じ人が同じ月に複数の現場契約を持つこともあるので、
--   契約（gw_site_contracts、db/076）まで含めて1行にする。
--   cron（api/cron/task-events.js の月初チェック）が毎月1日〜5日に
--   数え直しても、同じ月・同じ契約の行が増えないように一意制約を置く。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 076_site_contracts.sql
-- =============================================================================

create table if not exists public.gw_billing_progress (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  employee_id       uuid not null references public.gw_employees(id) on delete cascade,
  site_contract_id  uuid not null references public.gw_site_contracts(id) on delete cascade,
  billing_month     text not null, -- 'YYYY-MM'

  timesheet_received    boolean not null default false,
  timesheet_received_at timestamptz,
  work_confirmed         boolean not null default false,
  work_confirmed_at      timestamptz,
  board_created           boolean not null default false,
  board_created_at        timestamptz,
  sent                     boolean not null default false,
  sent_at                  timestamptz,
  bp_invoice_received       boolean not null default false,
  bp_invoice_received_at    timestamptz,

  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (employee_id, billing_month, site_contract_id)
);

comment on table public.gw_billing_progress is
  '月次請求の進捗（勤務表受領→稼働確認→Board作成→送付→BP請求書受領）。'
  '請求書そのものはここでは作らない。対象月×メンバー×契約で1行';

create index if not exists idx_gw_billing_progress_month
  on public.gw_billing_progress(tenant_id, billing_month);
create index if not exists idx_gw_billing_progress_contract
  on public.gw_billing_progress(site_contract_id);

-- 単価そのものは持たないが、どの現場・どの契約の請求が動いているかも
-- 社外には出さない情報。db/076（gw_site_contracts）と同じ絞り方（is_tenant_staff）
alter table public.gw_billing_progress enable row level security;

drop policy if exists gw_billing_progress_staff on public.gw_billing_progress;
create policy gw_billing_progress_staff on public.gw_billing_progress
  for all
  using (public.is_tenant_staff(tenant_id))
  with check (public.is_tenant_staff(tenant_id));

notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, p.billing_month, p.timesheet_received, p.work_confirmed,
--          p.board_created, p.sent, p.bp_invoice_received
--     from public.gw_billing_progress p
--     join public.gw_employees e on e.id = p.employee_id
--    order by p.billing_month desc;
