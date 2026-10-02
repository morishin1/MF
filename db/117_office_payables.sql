-- =============================================================================
-- 117: 仕入請求（BP請求書）・支払・月次完了 — Office Phase 6〜8 の最小形
--
--   gw_vendor_invoices       … BP・外注から届いた請求書（ヘッダ）。1枚に複数の要員を載せられる
--   gw_vendor_invoice_lines  … 請求書の明細（要員×現場契約×対象月）。契約条件の仕入単価と照合する
--   gw_office_payments       … 支払（請求書ヘッダに対して1件）。支払予定 → 支払済
--   gw_office_month_closes   … Office の月次完了（gw_month_closings とは別。打刻ロックの副作用を持ち込まない）
--
-- ■ 設計（docs/office-migration-plan.md §5）
--   ・請求書は「1請求書＝1要員」にしない（ヘッダ＋明細）。発注 1通 ↔ 請求書 1枚 も 1対1 にしない
--   ・二重計上の防止は明細側：同じ現場契約×対象月が、有効な（取り消していない）明細に載るのは1回だけ
--   ・発注額・契約額と請求額の差は保存しない。API が明細ごと・請求書ごとに計算して出す（自動で否認・修正しない）
--   ・差があるまま承認するときは、理由（mismatch_note）を残す
--   ・BP 会社の振込口座は持たない（機微。入れるときに別途設計）
--   ・発注書（gw_purchase_orders）は、まだ作らない。照合の相手は契約条件（gw_site_contract_terms.purchase_unit_price）
--
-- ■ RLS：読み取りだけを Office 権限（gw_is_office）に。書き込みのポリシーは置かない
--   API が権限を確かめたあと、service_role で書く（照合・承認・支払の順番と履歴を、ブラウザから飛ばせない）。
--
-- ■ 既存の表は変えない
--   gw_billing_progress の列はそのまま。BP請求書の受領（bp_invoice_received）は、API が明細を登録したときに立てる。
--
-- ■ 適用の順番
--   105 → 106 → 107（Phase 3）→ この 117 → アプリのデプロイ。
--   117 が無くても /office は動く（支払の欄が「未管理」のまま。仕入請求の API は 503 と SQL の案内を返す）。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 076_site_contracts.sql、077_billing_progress.sql、080_billing_submission.sql、099_access_hr_office.sql（gw_is_office）
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 仕入請求書（ヘッダ）
-- ---------------------------------------------------------------------------
create table if not exists public.gw_vendor_invoices (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  partner_company_id  uuid references public.gw_partner_companies(id) on delete set null,
  billing_month       text not null check (billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  invoice_no          text check (invoice_no is null or char_length(invoice_no) <= 100),
  received_on         date not null,
  submission_id       uuid references public.gw_submissions(id) on delete set null,
  subtotal_amount     numeric(14, 2) not null check (subtotal_amount >= 0),
  tax_amount          numeric(14, 2) not null default 0 check (tax_amount >= 0),
  total_amount        numeric(14, 2) not null check (total_amount >= 0),
  status              text not null default 'received'
    check (status in ('received', 'approved', 'void')),
  mismatch_note       text check (mismatch_note is null or char_length(mismatch_note) <= 500),
  approved_at         timestamptz,
  approved_by         uuid references auth.users(id) on delete set null,
  void_reason         text check (void_reason is null or char_length(void_reason) <= 500),
  voided_at           timestamptz,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.gw_vendor_invoices is
  'BP・外注から届いた請求書（ヘッダ）。明細は gw_vendor_invoice_lines。照合の差は保存せず API が計算する（db/117）';

create index if not exists idx_gw_vendor_invoices_month on public.gw_vendor_invoices(tenant_id, billing_month);

-- ---------------------------------------------------------------------------
-- 仕入請求書（明細）：要員×現場契約×対象月
-- ---------------------------------------------------------------------------
create table if not exists public.gw_vendor_invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  invoice_id          uuid not null references public.gw_vendor_invoices(id) on delete cascade,
  site_contract_id    uuid references public.gw_site_contracts(id) on delete set null,
  employee_id         uuid references public.gw_employees(id) on delete set null,
  billing_month       text not null check (billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount              numeric(14, 2) not null check (amount >= 0),
  work_minutes        integer check (work_minutes is null or work_minutes >= 0),
  note                text check (note is null or char_length(note) <= 500),
  voided_at           timestamptz,
  created_at          timestamptz not null default now()
);

comment on table public.gw_vendor_invoice_lines is
  '仕入請求書の明細（税抜）。同じ現場契約×対象月は、取り消していない明細に1回だけ（二重計上の防止）';

-- 二重計上の防止（取り消した明細は数えない）
create unique index if not exists uq_gw_vendor_invoice_lines_active
  on public.gw_vendor_invoice_lines(site_contract_id, billing_month)
  where voided_at is null and site_contract_id is not null;
create index if not exists idx_gw_vendor_invoice_lines_invoice on public.gw_vendor_invoice_lines(invoice_id);
create index if not exists idx_gw_vendor_invoice_lines_month on public.gw_vendor_invoice_lines(tenant_id, billing_month);

-- ---------------------------------------------------------------------------
-- 支払（請求書ヘッダに1件）
-- ---------------------------------------------------------------------------
create table if not exists public.gw_office_payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  vendor_invoice_id   uuid not null references public.gw_vendor_invoices(id) on delete cascade,
  billing_month       text not null check (billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount              numeric(14, 2) not null check (amount >= 0),
  scheduled_on        date not null,
  status              text not null default 'scheduled'
    check (status in ('scheduled', 'paid', 'void')),
  paid_on             date,
  paid_by             uuid references auth.users(id) on delete set null,
  check (status <> 'paid' or paid_on is not null),
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.gw_office_payments is
  'BP・外注への支払の記録（支払予定 → 支払済）。振込そのものは行わない。口座は持たない（db/117）';

create unique index if not exists uq_gw_office_payments_active
  on public.gw_office_payments(vendor_invoice_id) where status <> 'void';
create index if not exists idx_gw_office_payments_month on public.gw_office_payments(tenant_id, billing_month);

-- ---------------------------------------------------------------------------
-- 月次完了（Office）
-- ---------------------------------------------------------------------------
create table if not exists public.gw_office_month_closes (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  billing_month       text not null check (billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  closed_at           timestamptz not null default now(),
  closed_by           uuid references auth.users(id) on delete set null,
  closed_by_name      text,
  rows_total          integer not null default 0 check (rows_total >= 0),
  rows_checked        integer not null default 0 check (rows_checked >= 0),
  check_note          text check (check_note is null or char_length(check_note) <= 500),
  reopened_at         timestamptz,
  reopened_by         uuid references auth.users(id) on delete set null,
  reopen_reason       text check (reopen_reason is null or char_length(reopen_reason) <= 500)
);

comment on table public.gw_office_month_closes is
  'Office の月次完了。gw_month_closings（打刻ロック）とは別。取り消した行は残す（履歴）（db/117）';

create unique index if not exists uq_gw_office_month_closes_active
  on public.gw_office_month_closes(tenant_id, billing_month) where reopened_at is null;

-- ---------------------------------------------------------------------------
-- RLS：Office 権限の読み取りだけ
-- ---------------------------------------------------------------------------
alter table public.gw_vendor_invoices enable row level security;
alter table public.gw_vendor_invoice_lines enable row level security;
alter table public.gw_office_payments enable row level security;
alter table public.gw_office_month_closes enable row level security;

drop policy if exists gw_vendor_invoices_office_select on public.gw_vendor_invoices;
create policy gw_vendor_invoices_office_select on public.gw_vendor_invoices
  for select using (public.gw_is_office(tenant_id));
drop policy if exists gw_vendor_invoice_lines_office_select on public.gw_vendor_invoice_lines;
create policy gw_vendor_invoice_lines_office_select on public.gw_vendor_invoice_lines
  for select using (public.gw_is_office(tenant_id));
drop policy if exists gw_office_payments_office_select on public.gw_office_payments;
create policy gw_office_payments_office_select on public.gw_office_payments
  for select using (public.gw_is_office(tenant_id));
drop policy if exists gw_office_month_closes_office_select on public.gw_office_month_closes;
create policy gw_office_month_closes_office_select on public.gw_office_month_closes
  for select using (public.gw_is_office(tenant_id));

commit;

notify pgrst, 'reload schema';

-- 確認1（適用後）: 4表のポリシーが「読み取りだけ・Office 権限」か（4行・cmd はすべて SELECT）
--
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public'
--      and tablename in ('gw_vendor_invoices', 'gw_vendor_invoice_lines', 'gw_office_payments', 'gw_office_month_closes')
--    order by tablename;
--
-- 確認2（適用後）: 二重計上・二重支払・二重完了の部分ユニーク（3行）
--
--   select indexname from pg_indexes
--    where schemaname = 'public'
--      and indexname in ('uq_gw_vendor_invoice_lines_active', 'uq_gw_office_payments_active', 'uq_gw_office_month_closes_active');
--
-- 戻す（データごと消える。本番で流す前に必ず確認）:
--   drop table if exists public.gw_office_month_closes, public.gw_office_payments,
--                        public.gw_vendor_invoice_lines, public.gw_vendor_invoices;
