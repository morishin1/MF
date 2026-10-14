-- =============================================================================
-- 134: Office「請求・支払」を一般経費に広げる
--      請求書アップロード → 内容確認 → 仕訳 → 支払予定 → 支払済み → MFクラウド用CSV を、1画面で
--
-- ■ 何をするか（足すだけ。既存の列・制約・データは変えない／消さない）
--   新しい表（5つ。RLS を有効にし、ポリシーは置かない。読み書きは API だけ＝db/125 と同じ）
--     gw_office_vendors           … 支払先マスタ（BP 以外も含む。標準の締め日・支払条件・標準仕訳・前回使った仕訳）
--     gw_office_invoice_journals  … 請求書ごとの仕訳明細（複合仕訳は複数行。借方合計＝貸方合計は API が確かめる）
--     gw_office_mf_exports        … MFクラウド用CSVの出力バッチ（誰が・いつ・何を）
--     gw_office_mf_export_items   … バッチに入れた請求書・支払（「CSV出力済み」の根拠。MF 登録済みの意味ではない）
--     gw_office_payables_settings … 休日調整・既定の科目・候補リスト（会社ごと1行）
--   既存の表に列を足す（すべて nullable か default 付き）
--     gw_vendor_invoices … 一般請求書のための列（vendor_id・invoice_kind・請求日・締め日・支払条件・支払期日・ファイル・仕訳状況・MF出力日時）
--     gw_office_payments … 支払方法・支払元口座・実支払額・振込手数料・メモ・取消理由・MF出力日時
--   新しい保存先（バケット office-invoices。非公開。署名付きURLでだけ見る）
--
-- ■ 変えないもの（db/117 のまま）
--   ・partner_company_id は、もともと nullable。NOT NULL の解除は要らない
--   ・「partner_company_id または vendor_id が必須」という CHECK は足さない（既存の BP 請求で partner 未設定があり得る）。
--     新しい一般請求書で vendor_id を必須にするのは API の役目
--   ・gw_submissions は触らない（employee_id・site_contract_id が NOT NULL のため、一般請求書のファイルは使わない）
--   ・既存の BP 請求書・明細・支払・月次完了は、そのまま動く。invoice_kind は default 'bp'
--
-- ■ 権限
--   新しい5表は RLS 有効・ポリシー無し（ログインした人が直接は読めない・書けない）。
--   API が Office の権限（閲覧・確認＝経営者／責任者／経理、支払・MF CSV・仕訳の確定＝経営者／経理）を確かめてから service role で読み書きする。
--
-- ■ 適用の順番
--   この SQL → アプリのデプロイ。デプロイが先でも、新しい「支払管理」だけ「SQL を流してください」と出て、ほかは止まらない
--   （既存の月次・案件別の請求／支払は、この SQL が無くても動く）。
--
-- 実行方法: Supabase の SQL Editor に、このファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 117（gw_vendor_invoices・gw_office_payments）、075（gw_partner_companies）、schema.sql（tenants）
-- 確認: db/check_134_office_payables_general.sql  ／  戻す: db/rollback_134_office_payables_general.sql
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_vendor_invoices') is null or to_regclass('public.gw_office_payments') is null then
    raise exception 'gw_vendor_invoices / gw_office_payments がありません。先に db/117_office_payables.sql を流してください';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1) 支払先マスタ
--    closing_day：1〜30＝その日締め、31＝月末締め
--    payment_month_offset：締め月から何か月後に払うか（0＝当月、1＝翌月、2＝翌々月…）／payment_day：1〜30＝その日、31＝月末
--    std_*：標準仕訳（請求書の仕訳の初期値）。last_journal：前回確定した仕訳（次回から初期値に使う）
-- ---------------------------------------------------------------------------
create table if not exists public.gw_office_vendors (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  name                  text not null check (char_length(name) between 1 and 200),
  short_name            text check (short_name is null or char_length(short_name) <= 100),
  partner_company_id    uuid references public.gw_partner_companies(id) on delete set null,
  invoice_reg_no        text check (invoice_reg_no is null or invoice_reg_no ~ '^T\d{13}$'),
  closing_day           smallint check (closing_day is null or closing_day between 1 and 31),
  payment_month_offset  smallint check (payment_month_offset is null or payment_month_offset between 0 and 6),
  payment_day           smallint check (payment_day is null or payment_day between 1 and 31),
  std_debit_account     text check (std_debit_account is null or char_length(std_debit_account) <= 100),
  std_debit_sub_account text check (std_debit_sub_account is null or char_length(std_debit_sub_account) <= 100),
  std_department        text check (std_department is null or char_length(std_department) <= 100),
  std_tax_class         text check (std_tax_class is null or char_length(std_tax_class) <= 100),
  std_invoice_class     text check (std_invoice_class is null or char_length(std_invoice_class) <= 20),
  std_credit_account    text check (std_credit_account is null or char_length(std_credit_account) <= 100),
  std_credit_sub_account text check (std_credit_sub_account is null or char_length(std_credit_sub_account) <= 100),
  std_payment_method    text check (std_payment_method is null or std_payment_method in ('transfer', 'debit', 'card', 'cash', 'other')),
  std_source_account    text check (std_source_account is null or char_length(std_source_account) <= 100),
  last_journal          jsonb,
  last_journal_at       timestamptz,
  memo                  text check (memo is null or char_length(memo) <= 2000),
  is_active             boolean not null default true,
  created_by            uuid references auth.users(id) on delete set null,
  updated_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint gw_office_vendors_terms_pair check ((payment_month_offset is null) = (payment_day is null))
);

comment on table public.gw_office_vendors is
  '支払先マスタ（BP 以外も含む）。標準の締め日・支払条件・標準仕訳・前回使った仕訳。無効にしても消さない（請求書から参照されるため）。db/134';

create unique index if not exists uq_gw_office_vendors_name on public.gw_office_vendors(tenant_id, name);
create index if not exists idx_gw_office_vendors_tenant on public.gw_office_vendors(tenant_id, is_active);

-- ---------------------------------------------------------------------------
-- 2) 請求書（gw_vendor_invoices）に列を足す
--    invoice_kind：'bp'（従来の BP 請求書。明細あり）／'general'（一般経費。支払先マスタ vendor_id を使う）
--    payment_method／source_account：登録時に決めた支払方法・支払元口座（支払予定を入れるときの初期値）
--    due_source：payment_due_on をどう決めたか（invoice＝請求書に明記／manual＝経理が入力／master＝支払先マスタから計算）。NULL＝未設定
--    journal_status：none（未仕訳）／draft（下書き）／confirmed（確定）
--    mf_purchase_*：仕入計上の CSV を出した日時。出しただけで、MF に登録済みの意味ではない
-- ---------------------------------------------------------------------------
alter table public.gw_vendor_invoices
  add column if not exists vendor_id           uuid references public.gw_office_vendors(id) on delete set null,
  add column if not exists invoice_kind        text not null default 'bp',
  add column if not exists invoice_date        date,
  add column if not exists closing_day         smallint,
  add column if not exists payment_terms       text,
  add column if not exists payment_due_on      date,
  add column if not exists due_source          text,
  add column if not exists registration_no     text,
  add column if not exists description         text,
  add column if not exists payment_method      text,
  add column if not exists source_account      text,
  add column if not exists source_sub_account  text,
  add column if not exists file_path           text,
  add column if not exists file_name           text,
  add column if not exists file_mime           text,
  add column if not exists file_size           integer,
  add column if not exists file_sha256         text,
  add column if not exists journal_status      text not null default 'none',
  add column if not exists journal_date        date,
  add column if not exists journal_confirmed_at timestamptz,
  add column if not exists journal_confirmed_by uuid references auth.users(id) on delete set null,
  add column if not exists mf_purchase_first_exported_at timestamptz,
  add column if not exists mf_purchase_last_exported_at  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_vendor_invoices_kind_chk') then
    alter table public.gw_vendor_invoices add constraint gw_vendor_invoices_kind_chk
      check (invoice_kind in ('bp', 'general'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_vendor_invoices_due_source_chk') then
    alter table public.gw_vendor_invoices add constraint gw_vendor_invoices_due_source_chk
      check (due_source is null or due_source in ('invoice', 'manual', 'master'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_vendor_invoices_journal_status_chk') then
    alter table public.gw_vendor_invoices add constraint gw_vendor_invoices_journal_status_chk
      check (journal_status in ('none', 'draft', 'confirmed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_vendor_invoices_closing_day_chk') then
    alter table public.gw_vendor_invoices add constraint gw_vendor_invoices_closing_day_chk
      check (closing_day is null or closing_day between 1 and 31);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_vendor_invoices_text_len_chk') then
    alter table public.gw_vendor_invoices add constraint gw_vendor_invoices_text_len_chk
      check ((payment_terms is null or char_length(payment_terms) <= 100)
         and (description is null or char_length(description) <= 200)
         and (registration_no is null or char_length(registration_no) <= 20)
         and (file_name is null or char_length(file_name) <= 200)
         and (source_account is null or char_length(source_account) <= 100)
         and (source_sub_account is null or char_length(source_sub_account) <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_vendor_invoices_method_chk') then
    alter table public.gw_vendor_invoices add constraint gw_vendor_invoices_method_chk
      check (payment_method is null or payment_method in ('transfer', 'debit', 'card', 'cash', 'other'));
  end if;
end $$;

-- 同じ支払先・同じ請求書番号の二重登録を防ぐ（取り消した請求書は数えない）
create unique index if not exists uq_gw_vendor_invoices_vendor_no
  on public.gw_vendor_invoices(tenant_id, vendor_id, invoice_no)
  where vendor_id is not null and invoice_no is not null and status <> 'void';
create index if not exists idx_gw_vendor_invoices_vendor on public.gw_vendor_invoices(tenant_id, vendor_id);
create index if not exists idx_gw_vendor_invoices_sha on public.gw_vendor_invoices(tenant_id, file_sha256) where file_sha256 is not null;

-- ---------------------------------------------------------------------------
-- 3) 支払（gw_office_payments）に列を足す
--    cancel_*：取り消した理由・日時・人（物理削除しない。status='void' のまま残す）
--    paid_amount／fee_amount：実際に払った額／振込手数料（こちら負担の分）
-- ---------------------------------------------------------------------------
alter table public.gw_office_payments
  add column if not exists method             text,
  add column if not exists source_account     text,
  add column if not exists source_sub_account text,
  add column if not exists paid_amount        numeric(14, 2),
  add column if not exists fee_amount         numeric(14, 2),
  add column if not exists memo               text,
  add column if not exists cancel_reason      text,
  add column if not exists cancelled_at       timestamptz,
  add column if not exists cancelled_by       uuid references auth.users(id) on delete set null,
  add column if not exists mf_payment_first_exported_at timestamptz,
  add column if not exists mf_payment_last_exported_at  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_office_payments_method_chk') then
    alter table public.gw_office_payments add constraint gw_office_payments_method_chk
      check (method is null or method in ('transfer', 'debit', 'card', 'cash', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_office_payments_amounts_chk') then
    alter table public.gw_office_payments add constraint gw_office_payments_amounts_chk
      check ((paid_amount is null or paid_amount >= 0) and (fee_amount is null or fee_amount >= 0));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_office_payments_text_len_chk') then
    alter table public.gw_office_payments add constraint gw_office_payments_text_len_chk
      check ((memo is null or char_length(memo) <= 500) and (cancel_reason is null or char_length(cancel_reason) <= 500)
         and (source_account is null or char_length(source_account) <= 100)
         and (source_sub_account is null or char_length(source_sub_account) <= 100));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4) 仕訳明細（請求書ごと。複合仕訳は複数行）
--    side：debit（借方）／credit（貸方）。account 以下は MFクラウドの正式名称と同じ文字で持つ（自由入力＋候補リスト）
--    summary・memo・tags は仕訳（請求書）単位の値を、全行に同じ値で持つ
-- ---------------------------------------------------------------------------
create table if not exists public.gw_office_invoice_journals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  invoice_id     uuid not null references public.gw_vendor_invoices(id) on delete cascade,
  line_no        integer not null check (line_no >= 1),
  side           text not null check (side in ('debit', 'credit')),
  account        text not null check (char_length(account) between 1 and 100),
  sub_account    text check (sub_account is null or char_length(sub_account) <= 100),
  department     text check (department is null or char_length(department) <= 100),
  partner        text check (partner is null or char_length(partner) <= 200),
  tax_class      text check (tax_class is null or char_length(tax_class) <= 100),
  invoice_class  text check (invoice_class is null or char_length(invoice_class) <= 20),
  amount         numeric(14, 2) not null check (amount >= 0),
  tax_amount     numeric(14, 2) check (tax_amount is null or tax_amount >= 0),
  summary        text check (summary is null or char_length(summary) <= 200),
  memo           text check (memo is null or char_length(memo) <= 500),
  tags           text[] not null default '{}',
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.gw_office_invoice_journals is
  '請求書ごとの仕訳明細（仕入計上の仕訳。複合仕訳は複数行）。支払の仕訳は、ここと支払の記録から CSV 出力時に組み立てる。db/134';

create unique index if not exists uq_gw_office_invoice_journals_line on public.gw_office_invoice_journals(invoice_id, side, line_no);
create index if not exists idx_gw_office_invoice_journals_invoice on public.gw_office_invoice_journals(tenant_id, invoice_id);

-- ---------------------------------------------------------------------------
-- 5) MFクラウド用CSVの出力バッチ
--    「CSV を出した」記録であって、「MF に登録された」記録ではない（画面でも分けて見せる）
-- ---------------------------------------------------------------------------
create table if not exists public.gw_office_mf_exports (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  batch_code      text not null check (char_length(batch_code) between 4 and 40),
  billing_month   text not null check (billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind            text not null check (kind in ('purchase', 'payment', 'both')),
  mode            text not null check (mode in ('unexported', 'all')),
  invoice_count   integer not null default 0 check (invoice_count >= 0),
  row_count       integer not null default 0 check (row_count >= 0),
  file_name       text,
  exported_by     uuid references auth.users(id) on delete set null,
  exported_by_name text,
  exported_at     timestamptz not null default now()
);

create unique index if not exists uq_gw_office_mf_exports_code on public.gw_office_mf_exports(tenant_id, batch_code);
create index if not exists idx_gw_office_mf_exports_month on public.gw_office_mf_exports(tenant_id, billing_month, exported_at desc);

create table if not exists public.gw_office_mf_export_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  export_id    uuid not null references public.gw_office_mf_exports(id) on delete cascade,
  invoice_id   uuid not null references public.gw_vendor_invoices(id) on delete cascade,
  payment_id   uuid references public.gw_office_payments(id) on delete set null,
  kind         text not null check (kind in ('purchase', 'payment')),
  txn_no       integer not null check (txn_no >= 1),
  exported_at  timestamptz not null default now()
);

create index if not exists idx_gw_office_mf_export_items_invoice on public.gw_office_mf_export_items(tenant_id, invoice_id);
create index if not exists idx_gw_office_mf_export_items_export on public.gw_office_mf_export_items(export_id);

-- ---------------------------------------------------------------------------
-- 6) 設定（会社ごと1行）
--    holiday_adjust：支払期日が休日のとき prev（前営業日）／next（翌営業日）／none（調整しない）
--    candidates：勘定科目・補助科目・部門・税区分の候補リスト（{"accounts":[],"sub_accounts":[],"departments":[],"tax_classes":[]}）
-- ---------------------------------------------------------------------------
create table if not exists public.gw_office_payables_settings (
  tenant_id            uuid primary key references public.tenants(id) on delete cascade,
  holiday_adjust       text not null default 'prev' check (holiday_adjust in ('prev', 'next', 'none')),
  default_credit_account text check (default_credit_account is null or char_length(default_credit_account) <= 100),
  default_source_account text check (default_source_account is null or char_length(default_source_account) <= 100),
  default_payment_method text check (default_payment_method is null or default_payment_method in ('transfer', 'debit', 'card', 'cash', 'other')),
  fee_account          text check (fee_account is null or char_length(fee_account) <= 100),
  fee_tax_class        text check (fee_tax_class is null or char_length(fee_tax_class) <= 100),
  candidates           jsonb not null default '{}'::jsonb,
  updated_by           uuid references auth.users(id) on delete set null,
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7) RLS：新しい5表はポリシーを置かない（API が権限を確かめてから service role で読み書き）
-- ---------------------------------------------------------------------------
alter table public.gw_office_vendors enable row level security;
alter table public.gw_office_invoice_journals enable row level security;
alter table public.gw_office_mf_exports enable row level security;
alter table public.gw_office_mf_export_items enable row level security;
alter table public.gw_office_payables_settings enable row level security;

-- ---------------------------------------------------------------------------
-- 8) 請求書ファイルの保存先（非公開。ポリシー無し＝service role の署名付きURLでだけ読み書き）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('office-invoices', 'office-invoices', false)
on conflict (id) do nothing;

notify pgrst, 'reload schema';

commit;
