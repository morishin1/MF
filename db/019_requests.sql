-- =============================================================================
-- 019_requests.sql — 有給休暇と稟議の申請・承認
--
-- 前提: db/016_expenses.sql（gw_workflow_settings）が適用済みであること。
--
-- 経費精算と分けた理由
--   経費は「明細が複数あって合計が意味を持つ」形、こちらは「1件で完結する」形。
--   同じ表に入れると、使わない列だらけになって何が必須なのか分からなくなる。
--
-- 種別をまとめて1表にした理由
--   有給と稟議は入力する項目が違うが、申請→承認→通知の骨格は同じ。
--   あとで慶弔休暇や出張申請を足すとき、kind を増やすだけで済むようにした。
--   種別ごとに使う列が違うのは承知のうえで、JSONB にはしていない
--   （日付や金額で絞り込む場面が必ず来るので、列のままのほうが扱いやすい）。
--
-- 承認の道すじ（設定で変えない。迷いどころを作らないため）
--   有給 … 管理部（管理者・人事）の1段。承認されると共有カレンダーに入る
--   稟議 … 管理部 → 代表（経営者権限）の2段。金額に関わらず必ず2段
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 申請
-- -----------------------------------------------------------------------------
create table if not exists public.gw_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,

  kind          text not null check (kind in ('leave','ringi')),
  title         text not null,
  body          text,

  -- 有給用。時間単位の取得は扱わない（半日までにする）
  leave_type    text check (leave_type in ('paid','am','pm','special','absence')),
  starts_on     date,
  ends_on       date,
  -- 消化日数。半休は 0.5。土日を除いた日数を画面が計算し、申請者が直せる
  days          numeric(4,1),

  -- 稟議用。金額の無い稟議（方針の決裁など）もあるので必須にしない
  amount        int,

  status        text not null default 'pending'
                check (status in ('pending','pending_owner','approved','rejected','cancelled')),

  approved_by       uuid references public.gw_employees(id) on delete set null,
  approved_at       timestamptz,
  owner_approved_by uuid references public.gw_employees(id) on delete set null,
  owner_approved_at timestamptz,
  decision_note     text,

  -- 承認された有給を共有カレンダーへ入れた控え。
  -- 反映に失敗しても申請は成立させ、理由を残して管理画面で気づけるようにする
  gcal_calendar_id text,
  gcal_event_id    text,
  gcal_link        text,
  gcal_error       text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- 種別ごとに、無いと意味を成さない項目を必須にする
  constraint gw_requests_leave_shape check (
    kind <> 'leave' or (leave_type is not null and starts_on is not null and ends_on is not null and days is not null)
  ),
  constraint gw_requests_leave_order check (ends_on is null or starts_on is null or ends_on >= starts_on),
  constraint gw_requests_days_range check (days is null or (days > 0 and days <= 365))
);

create index if not exists idx_gw_requests_tenant
  on public.gw_requests(tenant_id, kind, status, created_at desc);
create index if not exists idx_gw_requests_employee
  on public.gw_requests(employee_id, created_at desc);
create index if not exists idx_gw_requests_leave_period
  on public.gw_requests(employee_id, starts_on)
  where kind = 'leave';


-- -----------------------------------------------------------------------------
-- 2) 有給の付与日数
--    残日数を出すのに要る。付与のルール（勤続年数に応じた日数、繰越の上限）は
--    労務側の判断なので、計算はせず、管理部が入れた数をそのまま使う。
--    年度は会計期間に合わせて4月始まり。fiscal_year は開始年（2026-04〜2027-03 なら 2026）。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_leave_grants (
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  fiscal_year  int not null,

  granted_days numeric(4,1) not null default 0,   -- その年度に付与した日数
  carried_days numeric(4,1) not null default 0,   -- 前年度からの繰越
  note         text,
  updated_at   timestamptz not null default now(),

  primary key (employee_id, fiscal_year)
);

create index if not exists idx_gw_leave_grants_tenant
  on public.gw_leave_grants(tenant_id, fiscal_year);


-- -----------------------------------------------------------------------------
-- 3) RLS
--    申請の中身（休む理由、稟議の内容）は本人と承認者だけ。同僚には見せない。
--    「誰が休むか」は承認後に共有カレンダーへ出るので、そちらで分かる。
-- -----------------------------------------------------------------------------
alter table public.gw_requests     enable row level security;
alter table public.gw_leave_grants enable row level security;

drop policy if exists gw_requests_select on public.gw_requests;
create policy gw_requests_select on public.gw_requests
  for select
  using (
    public.gw_expense_can_review(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_requests_insert on public.gw_requests;
create policy gw_requests_insert on public.gw_requests
  for insert
  with check (
    employee_id = public.gw_employee_id(tenant_id)
    and status = 'pending'
  );

-- 承認・却下は承認できる立場の人だけ。
-- 本人の取り下げは /api/requests/decide（service_role）が行う。
-- RLS は列を絞れないので、本人に UPDATE を許すと自分で approved にできてしまう
drop policy if exists gw_requests_update on public.gw_requests;
create policy gw_requests_update on public.gw_requests
  for update
  using (public.gw_expense_can_review(tenant_id))
  with check (public.gw_expense_can_review(tenant_id));

drop policy if exists gw_requests_delete on public.gw_requests;
create policy gw_requests_delete on public.gw_requests
  for delete
  using (public.gw_expense_can_review(tenant_id));

-- 付与日数: 本人は自分の分を読める（残日数の表示に要る）。書き換えは管理部だけ
drop policy if exists gw_leave_grants_select on public.gw_leave_grants;
create policy gw_leave_grants_select on public.gw_leave_grants
  for select
  using (
    public.gw_expense_can_review(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_leave_grants_write on public.gw_leave_grants;
create policy gw_leave_grants_write on public.gw_leave_grants
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- -----------------------------------------------------------------------------
-- 4) 通知の種別に 'request' を足す
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_notifications') is not null then
    alter table public.gw_notifications
      drop constraint if exists gw_notifications_kind_check;
    alter table public.gw_notifications
      add constraint gw_notifications_kind_check
      check (kind in ('general','task_overdue','task_assigned','notice','message','booking','expense','request'));
  end if;
end $$;
