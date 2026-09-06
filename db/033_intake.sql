-- =============================================================================
-- 033: 1ファイル登録（雇用・育成マスターの取り込み）
--      「1ファイル登録型 自走育成・業務運営システム」§3〜§12 §51
--
-- ■ この番号で入れるもの
--   1) gw_employees に、マスターの項目が入る列を足す
--   2) gw_import_batches / gw_import_rows … 取り込みの記録（§51）
--   3) gw_growth_kpis.template_code … どのテンプレート由来かを残す
--
-- ■ employment_profiles を新しく作らない
--   §51 は employment_profiles を別表にしているが、
--   雇用条件は 029 の gw_contracts が、氏名・入社日・所属は gw_employees が
--   既に持っている。3つ目の表を作ると、同じ人の情報が3か所に散る。
--   足りない列（社員コード・上長・職種・初期Role・勤務形態）だけを
--   gw_employees に足す。
--
-- ■ 取り込んだ行を、そのまま残す理由（§11）
--   10人ぶん取り込んで2人がエラー、というとき、
--   その2人だけを直して再取り込みしたい。
--   元データ（raw_json）を残しておけば、管理者は表を作り直さずに済む。
--
-- ■ 社員コードの自動採番（§10）
--   空欄なら自動で振るが、同時に2ファイル取り込むと衝突しうる。
--   一意制約で弾いて、その行だけエラーに落とす。
--   採番そのものはアプリ側で行い、DBは重複を許さないことだけを担保する。
--
-- 前提: 005（gw_employees）、032（gw_growth_kpis）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 社員名簿に、マスターの項目を足す
-- -----------------------------------------------------------------------------
alter table public.gw_employees add column if not exists employee_code text;
alter table public.gw_employees
  add column if not exists manager_id uuid references public.gw_employees(id) on delete set null;
alter table public.gw_employees add column if not exists job_family_code text;
alter table public.gw_employees add column if not exists initial_role text;
alter table public.gw_employees add column if not exists work_style text
  check (work_style in ('リモート', 'ハイブリッド', '出社'));
-- どの取り込みで作られた行か。取り消しややり直しの手がかりになる
alter table public.gw_employees add column if not exists import_row_id uuid;

-- 社員コードはテナントの中で一意。空欄（null）は何行あってもよい
create unique index if not exists uq_gw_employees_code
  on public.gw_employees(tenant_id, employee_code)
  where employee_code is not null;

comment on column public.gw_employees.employee_code is
  '社員コード。空欄で取り込むと自動採番。テナント内で一意';
comment on column public.gw_employees.manager_id is
  '管理責任者。マスターでは manager_email で指定し、取り込み時に引き当てる';
comment on column public.gw_employees.job_family_code is
  '職種コード。3か月計画のテンプレートを選ぶのに使う（lib/job-templates.js）';


-- -----------------------------------------------------------------------------
-- 2) 取り込みの記録（§51 import_batches / import_rows）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_import_batches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  filename    text,
  uploaded_by uuid references auth.users(id) on delete set null,

  total_rows   integer not null default 0,
  success_rows integer not null default 0,
  error_rows   integer not null default 0,

  -- checked  … 検証しただけ。まだ1件も登録していない
  -- applied  … 登録した
  -- failed   … 全行エラーで、1件も登録できなかった
  status text not null default 'checked'
         check (status in ('checked', 'applied', 'failed')),

  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists idx_gw_import_batches_tenant
  on public.gw_import_batches(tenant_id, created_at desc);

comment on table public.gw_import_batches is
  '雇用・育成マスターの取り込み単位。まず checked で検証結果を出し、'
  '管理者が確認してから applied にする（誤ったファイルでアカウントを作らないため）';


create table if not exists public.gw_import_rows (
  id       uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.gw_import_batches(id) on delete cascade,
  row_no   integer not null,

  -- 表の1行をそのまま。直して再取り込みするときに、表を作り直さずに済む
  raw_json jsonb not null,

  -- ok      … 検証を通った（まだ登録していない）
  -- created … 登録してアカウントまで作った
  -- error   … 検証で弾いた
  -- skipped … 既に同じ人がいる
  status text not null default 'ok'
         check (status in ('ok', 'created', 'error', 'skipped')),

  -- どの項目がなぜ駄目か。[{field, message}]
  error_json jsonb,

  created_employee_id uuid references public.gw_employees(id) on delete set null,
  created_user_id     uuid,
  -- 初回パスワードは保存しない。平文で残るため、取り込みの応答にだけ出す

  created_at timestamptz not null default now(),
  unique (batch_id, row_no)
);

create index if not exists idx_gw_import_rows_batch
  on public.gw_import_rows(batch_id, row_no);

comment on column public.gw_import_rows.raw_json is
  '取り込んだ1行をそのまま。エラー行だけ直して再取り込みするのに使う';
comment on column public.gw_import_rows.error_json is
  'どの項目がなぜ駄目か。管理者が表のどこを直せばよいか分かる形で入れる';


-- -----------------------------------------------------------------------------
-- 3) KPIがどこから来たか
--    テンプレート由来か、AIが足したか、人が足したかを区別する。
--    「テンプレートのどのKPIが実際には使われていないか」を後から見るのに要る
-- -----------------------------------------------------------------------------
alter table public.gw_growth_kpis add column if not exists template_code text;

comment on column public.gw_growth_kpis.template_code is
  '<職種コード>:<KPI名>。テンプレート由来のものだけ入る。'
  'AIが足したものと人が足したものは空';


-- -----------------------------------------------------------------------------
-- 4) 誰が読めるか
--    取り込みの記録は人事情報そのものなので、社内の担当者だけ。
--    本人にも見せない（他の人の行が同じバッチに入っているため）。
--    書き込みは service_role の API だけ。
-- -----------------------------------------------------------------------------
alter table public.gw_import_batches enable row level security;
alter table public.gw_import_rows    enable row level security;

drop policy if exists gw_import_batches_select on public.gw_import_batches;
create policy gw_import_batches_select on public.gw_import_batches
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

drop policy if exists gw_import_rows_select on public.gw_import_rows;
create policy gw_import_rows_select on public.gw_import_rows
  for select to authenticated
  using (exists (
    select 1 from public.gw_import_batches b
     where b.id = batch_id and public.gw_is_hr(b.tenant_id)
  ));

notify pgrst, 'reload schema';

-- 確認:
--   select filename, total_rows, success_rows, error_rows, status, created_at
--     from public.gw_import_batches order by created_at desc limit 10;
--   select row_no, status, error_json from public.gw_import_rows
--    where batch_id = '...' order by row_no;
--   select display_name, employee_code, job_family_code, initial_role
--     from public.gw_employees where employee_code is not null order by employee_code;
