-- =============================================================================
-- 075: 社員マスターに BP（業務委託先企業に所属する外部要員）を足す
--
-- ■ gw_employees は拡張しない。混ぜると壊れるものが多すぎる
--
--   BPは「他社（パートナー企業）に雇用され、自社の現場に常駐する人」。
--   自社が本人と直接結ぶのは雇用契約でも、業務委託契約でもない
--   （契約の当事者は自社とパートナー企業）。
--
--   ここで gw_contracts（雇用契約書。試用期間・更新面談・賃金という
--   自社が本人に払う給与を前提にした列を持つ）を無理に当てはめると、
--   意味を持たない行が大量にでき、人事評価の画面にもBPが紛れ込む。
--
--   なので、契約・単価・稼働（現場契約マスター）は別に新設する
--   （SES現場契約マスター、次の優先順位で着手）。
--   ここで足すのは「誰が誰か」を1つの名簿で見るための、最小限の印だけ。
--
-- ■ 足すのは2つだけ
--
--   gw_partner_companies … パートナー企業（BP会社）の名簿。まずは最小構成。
--   gw_employees.employee_kind / partner_company_id … プロパーかBPかの印と、
--     BPならどの会社の人かへのリンク。employment_type は変えない
--     （既存の '業務委託' は「個人と自社が直接契約」のままで、
--     BPとは意味が違うため混同させない）。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) パートナー企業（BP会社）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_partner_companies (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  company_name  text not null,
  -- インボイス制度の登録番号（T+13桁）。無ければ空でよい
  invoice_registration_number text,
  billing_contact_name  text,
  billing_contact_email text,
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_partner_companies_tenant
  on public.gw_partner_companies(tenant_id, company_name);

comment on table public.gw_partner_companies is
  'BP（業務委託先企業）の名簿。最小構成。稼働・単価・現場契約は別テーブル（次の優先順位）で扱う';

-- -----------------------------------------------------------------------------
-- 2) gw_employees に「誰が誰か」の印だけ足す
-- -----------------------------------------------------------------------------
alter table public.gw_employees
  add column if not exists employee_kind text not null default 'proper'
    check (employee_kind in ('proper', 'bp'));
alter table public.gw_employees
  add column if not exists partner_company_id uuid
    references public.gw_partner_companies(id) on delete restrict;

-- bp は所属先が要る。proper には持たせない（プロパーがBP会社に属す、は矛盾のため）
alter table public.gw_employees drop constraint if exists gw_employees_kind_partner_chk;
alter table public.gw_employees add constraint gw_employees_kind_partner_chk
  check (
    (employee_kind = 'bp'     and partner_company_id is not null) or
    (employee_kind = 'proper' and partner_company_id is null)
  );

comment on column public.gw_employees.employee_kind is
  'proper=自社雇用（従来どおり） / bp=他社（パートナー企業）所属の外部要員';
comment on column public.gw_employees.partner_company_id is
  'bp のときだけ、所属するパートナー企業。proper では null（制約で強制）';

create index if not exists idx_gw_employees_partner
  on public.gw_employees(tenant_id, partner_company_id) where partner_company_id is not null;

-- -----------------------------------------------------------------------------
-- 3) RLS
--
--    gw_employees と同じ形。読みは社内スタッフ全員、書きは人事だけ
-- -----------------------------------------------------------------------------
alter table public.gw_partner_companies enable row level security;

drop policy if exists gw_partner_companies_select on public.gw_partner_companies;
create policy gw_partner_companies_select on public.gw_partner_companies
  for select using (public.is_tenant_staff(tenant_id));

drop policy if exists gw_partner_companies_hr_write on public.gw_partner_companies;
create policy gw_partner_companies_hr_write on public.gw_partner_companies
  for all
  using (public.gw_is_hr(tenant_id))
  with check (public.gw_is_hr(tenant_id));

notify pgrst, 'reload schema';

-- 確認:
--   select display_name, employee_kind, partner_company_id from public.gw_employees
--    where employee_kind = 'bp';
--   select * from public.gw_partner_companies order by company_name;
