-- =============================================================================
-- 016_expenses.sql — 経費精算（申請・承認・支払）
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--      承認された経費は CSV で書き出して会計に取り込む。自動で仕訳は作らない。
--   2. 申請は「1件のヘッダ＋複数の明細」。月まとめでも1件ずつでも出せる。
--   3. 承認経路は金額で決める。しきい値未満は管理部の1段、
--      それ以上は管理部→代表の2段。しきい値は画面から変えられる。
--   4. 他人の経費は見えない。管理部・経営者だけが全件を見る。
--      金額と使途は、人事情報と同じくらい他人に見せたくない情報として扱う。
--   5. 提出後の明細は本人でも書き換えられない。直したいときは取り消して出し直す。
--      承認の途中で金額が変わると、何を承認したのかが分からなくなるため。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) ワークフローの設定（会社ごとに1行）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_workflow_settings (
  tenant_id                uuid primary key references public.tenants(id) on delete cascade,

  -- この金額（円）以上は代表（owner）の承認も必要。0 なら常に1段だけ
  expense_owner_threshold  int not null default 100000,

  -- 申請画面に出す勘定科目の選択肢
  expense_categories       text[] not null default array[
    '旅費交通費','会議費','交際費','消耗品費','新聞図書費',
    '通信費','研修費','支払手数料','荷造運賃','雑費'
  ],

  updated_at               timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- 2) 精算申請（ヘッダ）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_expense_reports (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  employee_id    uuid not null references public.gw_employees(id) on delete cascade,

  title          text not null,
  -- 対象月 'YYYY-MM'。会計に渡すときの区分に使う
  period         text,
  -- 立替払い か 法人カード か。法人カードは支払処理が要らない
  payment_method text not null default 'personal'
                 check (payment_method in ('personal','corporate_card')),

  -- 明細の合計。API が明細から計算して入れる（画面での集計とズレないように）
  total_amount   int not null default 0,

  status         text not null default 'pending'
                 check (status in ('pending','pending_owner','approved','paid','rejected','cancelled')),

  -- 1段目（管理部）と2段目（代表）を分けて残す。誰がどこまで見たかを追えるように
  approved_by       uuid references public.gw_employees(id) on delete set null,
  approved_at       timestamptz,
  owner_approved_by uuid references public.gw_employees(id) on delete set null,
  owner_approved_at timestamptz,

  paid_on        date,
  paid_by        uuid references public.gw_employees(id) on delete set null,

  decision_note  text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_gw_expense_reports_tenant
  on public.gw_expense_reports(tenant_id, status, created_at desc);
create index if not exists idx_gw_expense_reports_employee
  on public.gw_expense_reports(employee_id, created_at desc);


-- -----------------------------------------------------------------------------
-- 3) 明細
-- -----------------------------------------------------------------------------
create table if not exists public.gw_expense_lines (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  report_id     uuid not null references public.gw_expense_reports(id) on delete cascade,

  spent_on      date not null,
  category      text not null,
  payee         text,
  description   text,
  amount        int not null check (amount > 0),

  tax_rate      int not null default 10 check (tax_rate in (0, 8, 10)),
  -- インボイス登録事業者の領収書か。仕入税額控除の可否に関わるので申請時に取る
  invoice_registered boolean not null default true,

  -- 領収書。バケット 'expenses' の中のパス
  receipt_path  text,
  receipt_name  text,

  created_at    timestamptz not null default now()
);

create index if not exists idx_gw_expense_lines_report
  on public.gw_expense_lines(report_id, spent_on);


-- -----------------------------------------------------------------------------
-- 4) 判定用のヘルパ
--    RLS のポリシーから呼ぶので SECURITY DEFINER。
--    search_path を固定しないと、同名の関数を作られて乗っ取られる余地が残る。
-- -----------------------------------------------------------------------------

-- その申請が自分のものか
create or replace function public.gw_expense_is_mine(p_report uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_expense_reports r
     where r.id = p_report
       and r.employee_id = public.gw_employee_id(r.tenant_id)
  );
$$;

-- 自分の申請で、まだ1段目の承認が付いていないか（明細を入れてよい状態か）
create or replace function public.gw_expense_editable(p_report uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_expense_reports r
     where r.id = p_report
       and r.employee_id = public.gw_employee_id(r.tenant_id)
       and r.status = 'pending'
  );
$$;

-- 経費を承認・閲覧できる立場か（管理部＝管理者/人事、または経営者）
create or replace function public.gw_expense_can_review(p_tenant uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_tenant_staff(p_tenant)
      or public.gw_is_hr(p_tenant)
      or public.gw_has_role(p_tenant, 'owner');
$$;


-- -----------------------------------------------------------------------------
-- 5) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_workflow_settings enable row level security;
alter table public.gw_expense_reports   enable row level security;
alter table public.gw_expense_lines     enable row level security;

-- 設定: 社員は読める（しきい値と科目一覧が申請画面に要る）。書き換えは管理部だけ
drop policy if exists gw_workflow_settings_select on public.gw_workflow_settings;
create policy gw_workflow_settings_select on public.gw_workflow_settings
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_employee_id(tenant_id) is not null
  );

drop policy if exists gw_workflow_settings_write on public.gw_workflow_settings;
create policy gw_workflow_settings_write on public.gw_workflow_settings
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 申請の参照: 本人と、承認できる立場の人だけ。同僚には見せない
drop policy if exists gw_expense_reports_select on public.gw_expense_reports;
create policy gw_expense_reports_select on public.gw_expense_reports
  for select
  using (
    public.gw_expense_can_review(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

-- 申請の作成: 本人名義で、承認待ちの状態でのみ
drop policy if exists gw_expense_reports_insert on public.gw_expense_reports;
create policy gw_expense_reports_insert on public.gw_expense_reports
  for insert
  with check (
    employee_id = public.gw_employee_id(tenant_id)
    and status = 'pending'
  );

-- 承認・却下・支払記録は承認できる立場の人だけ。
-- 本人の取り下げは /api/expenses/decide（service_role）が行う。
-- RLS は列を絞れないので、本人に UPDATE を許すと自分で approved にできてしまう
drop policy if exists gw_expense_reports_update on public.gw_expense_reports;
create policy gw_expense_reports_update on public.gw_expense_reports
  for update
  using (public.gw_expense_can_review(tenant_id))
  with check (public.gw_expense_can_review(tenant_id));

drop policy if exists gw_expense_reports_delete on public.gw_expense_reports;
create policy gw_expense_reports_delete on public.gw_expense_reports
  for delete
  using (public.gw_expense_can_review(tenant_id));

-- 明細の参照: ヘッダと同じ範囲
drop policy if exists gw_expense_lines_select on public.gw_expense_lines;
create policy gw_expense_lines_select on public.gw_expense_lines
  for select
  using (
    public.gw_expense_can_review(tenant_id)
    or public.gw_expense_is_mine(report_id)
  );

-- 明細の作成: 自分の、まだ承認されていない申請にだけ足せる
drop policy if exists gw_expense_lines_insert on public.gw_expense_lines;
create policy gw_expense_lines_insert on public.gw_expense_lines
  for insert
  with check (public.gw_expense_editable(report_id) or public.gw_expense_can_review(tenant_id));

drop policy if exists gw_expense_lines_delete on public.gw_expense_lines;
create policy gw_expense_lines_delete on public.gw_expense_lines
  for delete
  using (public.gw_expense_editable(report_id) or public.gw_expense_can_review(tenant_id));

-- 明細の更新は誰にも許さない。金額を後から動かせないようにするため、
-- 直すときは取り消して出し直す（更新ポリシーを置かない ＝ 全員拒否）


-- -----------------------------------------------------------------------------
-- 6) 領収書の置き場
--    パス規約: <tenant_id>/<employee_id>/<uuid>.<ext>
--    申請を作る前にアップロードするので、申請IDではなく社員IDで区切る。
--    safe_uuid を通すのは、UUID でないパスが混じるとキャストで
--    クエリ全体が落ちるため（006 と同じ理由）。
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('expenses', 'expenses', false)
on conflict (id) do nothing;

drop policy if exists expense_files_rw on storage.objects;
create policy expense_files_rw on storage.objects
  for all
  using (
    bucket_id = 'expenses'
    and (
      public.gw_expense_can_review(public.safe_uuid(split_part(name, '/', 1)))
      or public.safe_uuid(split_part(name, '/', 2))
         = public.gw_employee_id(public.safe_uuid(split_part(name, '/', 1)))
    )
  )
  with check (
    bucket_id = 'expenses'
    and (
      public.gw_expense_can_review(public.safe_uuid(split_part(name, '/', 1)))
      or public.safe_uuid(split_part(name, '/', 2))
         = public.gw_employee_id(public.safe_uuid(split_part(name, '/', 1)))
    )
  );


-- -----------------------------------------------------------------------------
-- 7) 通知の種別に 'expense' を足す
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_notifications') is not null then
    alter table public.gw_notifications
      drop constraint if exists gw_notifications_kind_check;
    alter table public.gw_notifications
      add constraint gw_notifications_kind_check
      check (kind in ('general','task_overdue','task_assigned','notice','message','booking','expense'));
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 8) 設定の初期行
--    社員名簿に行がある会社（グループウェアを使っている会社）にだけ入れる。
-- -----------------------------------------------------------------------------
insert into public.gw_workflow_settings (tenant_id)
select t.id from public.tenants t
where exists (select 1 from public.gw_employees e where e.tenant_id = t.id)
on conflict (tenant_id) do nothing;
