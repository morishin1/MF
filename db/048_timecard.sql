-- =============================================================================
-- 048: タイムカード（打刻）
--
-- ■ 何を残すものか
--   出勤・休憩・退勤の時刻。労働時間は、給与の根拠であり、
--   法律上「客観的な記録により把握する」ことが求められているもの。
--   だから、あとから静かに書き換えられない作りにする。
--
-- ■ 打刻は本人。直すのは申請を通してから
--   本人が押した時刻は、本人には書き換えられない。
--   間違えた・押し忘れたときは、理由を書いて修正を申請し、
--   管理者が承認して初めて変わる（gw_time_fixes）。
--   本人が自由に直せると、それは打刻ではなく自己申告になる。
--
--   管理者は直接直せる。ただし「誰が・いつ・なぜ直したか」が必ず残る。
--   直せないほうが困る場面（本人が休みで打刻できない等）が実際にあるため、
--   止めるのではなく、記録に残す形にした。
--
-- ■ 月を締めたら動かさない
--   給与を計算したあとに数字が動くと、支給額と記録が合わなくなる。
--   locked_at が入った行は、管理者でも締めを解くまで変えられない。
--
-- ■ 割増の計算はしない
--   mf が出すのは「実労働時間」まで。
--   法定内・法定外の区別、深夜・休日の割増、みなし残業との相殺は、
--   就業規則と給与規定によって決まるもので、打刻だけでは決まらない。
--   ここで中途半端に計算すると、給与計算がその数字を信じてしまう。
--
-- ■ 1日1行
--   employee_id と work_date で一意。夜勤で日をまたぐ場合は、
--   出勤した日の行に、翌日の退勤時刻が入る（timestamptz で持つ）。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 打刻
-- -----------------------------------------------------------------------------
create table if not exists public.gw_time_entries (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  -- 出勤した日（日本時間）。夜勤で日をまたいでも、この日の行に入れる
  work_date   date not null,

  clock_in    timestamptz,
  clock_out   timestamptz,

  -- 休憩。[{ "start": "...", "end": "..." }] の配列。
  -- 別表にしなかったのは、休憩が1日の打刻の一部でしかなく、
  -- 単独で検索する相手ではないため。行が消えれば一緒に消えるのが正しい
  breaks      jsonb not null default '[]'::jsonb,

  -- 出勤中 / 退勤済 / 欠勤・休暇（打刻が無い日を明示するため）
  status      text not null default 'open'
              check (status in ('open', 'closed', 'absent')),

  -- 本人が押したのか、会社が入れたのか。
  -- 自己申告と客観的記録は、扱いが違う。混ぜずに分かるようにしておく
  source      text not null default 'self'
              check (source in ('self', 'admin')),

  note        text,

  -- 直した記録。直したことを消せないように、行の中に持つ
  edited_by   uuid references auth.users(id) on delete set null,
  edited_at   timestamptz,
  edit_reason text,

  -- 月を締めた印。入っていると、解くまで変えられない
  locked_at   timestamptz,
  locked_by   uuid references auth.users(id) on delete set null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint gw_time_entries_one_per_day unique (employee_id, work_date),
  -- 退勤が出勤より前にはならない。日をまたぐ夜勤は「後」なので通る
  constraint gw_time_entries_order check (clock_out is null or clock_in is null or clock_out >= clock_in),
  constraint gw_time_entries_breaks_is_array check (jsonb_typeof(breaks) = 'array')
);

create index if not exists idx_gw_time_entries_emp
  on public.gw_time_entries(employee_id, work_date desc);
create index if not exists idx_gw_time_entries_tenant
  on public.gw_time_entries(tenant_id, work_date desc);

comment on table public.gw_time_entries is
  '打刻。1人1日1行。本人は当日ぶんを押すだけで、直すには修正の申請が要る';
comment on column public.gw_time_entries.breaks is
  '休憩。[{start, end}] の配列。end が無いものは休憩中';
comment on column public.gw_time_entries.locked_at is
  '月を締めた印。入っていると、締めを解くまで誰も変えられない';


-- -----------------------------------------------------------------------------
-- 2) 修正の申請
--
--    押し忘れ・押し間違いは必ず起きる。起きたときに本人が黙って直せると、
--    打刻の意味が無くなる。理由を書いて出し、会社が承認して初めて変わる
-- -----------------------------------------------------------------------------
create table if not exists public.gw_time_fixes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  work_date   date not null,

  -- こう直してほしい、という中身。{ clockIn, clockOut, breaks, status }
  want        jsonb not null default '{}'::jsonb,
  -- 申請した時点の記録。あとから「元は何だったか」を追えるように控える
  before      jsonb,

  reason      text not null,

  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'rejected')),
  decided_by  uuid references auth.users(id) on delete set null,
  decided_at  timestamptz,
  decided_note text,

  created_at  timestamptz not null default now()
);

create index if not exists idx_gw_time_fixes_emp
  on public.gw_time_fixes(employee_id, status, work_date desc);
create index if not exists idx_gw_time_fixes_tenant
  on public.gw_time_fixes(tenant_id, status, created_at desc);


-- -----------------------------------------------------------------------------
-- 3) RLS
--
--    本人は自分の打刻と自分の申請を読める。人事・管理者は全件。
--    書き込みは api/timecard/*（service_role）だけ。
--    本人に update を許すと、RLS では列を絞れないので
--    clock_in も locked_at も書き換えられてしまう
-- -----------------------------------------------------------------------------
alter table public.gw_time_entries enable row level security;
alter table public.gw_time_fixes   enable row level security;

drop policy if exists gw_time_entries_read on public.gw_time_entries;
create policy gw_time_entries_read on public.gw_time_entries
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_time_fixes_read on public.gw_time_fixes;
create policy gw_time_fixes_read on public.gw_time_fixes
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );


notify pgrst, 'reload schema';

-- 確認:
--   -- 今日の出勤状況
--   select e.display_name, t.status, t.clock_in, t.clock_out
--     from public.gw_time_entries t
--     join public.gw_employees e on e.id = t.employee_id
--    where t.work_date = (now() at time zone 'Asia/Tokyo')::date
--    order by t.clock_in;
--
--   -- 承認待ちの修正
--   select e.display_name, f.work_date, f.reason
--     from public.gw_time_fixes f
--     join public.gw_employees e on e.id = f.employee_id
--    where f.status = 'pending' order by f.created_at;
