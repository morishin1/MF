-- =============================================================================
-- 040: 1日3回の声かけ（デスクトップ通知）
--
-- ■ 何を解決するのか
--   朝1分・14時30秒・終業3〜5分、という流れは、
--   「思い出したときにやる」ものにすると続かない。
--   画面を開いた人にしか出せない案内では、開かない日は何も起きない。
--   ブラウザのプッシュ通知なら、mf のタブを閉じていても届く。
--
-- ■ 3つの時刻
--   09:00 今日のゴールを決める（朝）
--   14:00 30秒チェック（見るだけ。入力は要らない）
--   17:45 日報（3〜5分）
--   時刻は人ごとに変えられる。短時間勤務やパートは9時始まりではない。
--
-- ■ 済んでいる人には送らない
--   朝の入力が終わっていれば9時の通知は出さない。
--   日報を出していれば17:45の通知も出さない。
--   終わったことを催促されるのが、いちばん通知を切りたくなる。
--
-- ■ 端末ごとに1行（gw_push_subs）
--   同じ人が会社のPCと自宅のPCから許可すれば2行になる。
--   endpoint がブラウザの発行する宛先で、これが一意。
--   ブラウザ側で許可を取り消されると、送信時に 404/410 が返る。
--   そのときは行を消す（api/cron/reminders.js）。
--
-- ■ 送った記録（gw_reminder_log）
--   (社員, 日付, どの時刻) で一意。cron が二重に走っても2回送らない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 通知の宛先。ブラウザが発行する購読情報
-- -----------------------------------------------------------------------------
create table if not exists public.gw_push_subs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,

  -- ブラウザが発行する宛先。これが端末の識別子になる
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,

  -- 「Chrome / Windows」のような見分け。どの端末を切るか選べるように
  label       text,

  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  fail_count  integer not null default 0
);

create index if not exists idx_gw_push_subs_emp on public.gw_push_subs(employee_id);

comment on table public.gw_push_subs is
  '通知の宛先。1端末1行。許可を取り消されたら送信時に消える';


-- -----------------------------------------------------------------------------
-- 2) いつ声をかけるか。人ごと
-- -----------------------------------------------------------------------------
create table if not exists public.gw_reminder_prefs (
  employee_id uuid primary key references public.gw_employees(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  enabled     boolean not null default true,

  -- HH:MM。null なら勤務時間から自動で決める（lib/reminders.js）
  --   始業 → 朝のゴール
  --   勤務のまんなか → KPI確認
  --   終業15分前 → 日報
  -- 勤務時間は gw_contracts.work_hours（「9:00〜18:00」など）を読む。
  -- 時刻を直接入れると、そちらが優先される。
  -- 15分刻みで見るので :00 :15 :30 :45 のいずれかにそろえる
  morning_at  text,
  midday_at   text,
  evening_at  text,

  morning_on  boolean not null default true,
  midday_on   boolean not null default true,
  evening_on  boolean not null default true,

  -- 送る曜日。1=月 … 7=日。既定は平日
  workdays    smallint[] not null default '{1,2,3,4,5}',

  updated_at  timestamptz not null default now()
);

comment on column public.gw_reminder_prefs.workdays is
  '送る曜日。1=月〜7=日。週3勤務の人は {1,3,5} のように置く';


-- -----------------------------------------------------------------------------
-- 3) 送った記録。二重送信を止める
-- -----------------------------------------------------------------------------
create table if not exists public.gw_reminder_log (
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  on_date     date not null,
  slot        text not null check (slot in ('morning','midday','evening')),
  sent_at     timestamptz not null default now(),
  devices     integer not null default 0,
  primary key (employee_id, on_date, slot)
);


-- -----------------------------------------------------------------------------
-- 4) 通知の種類を足す
--    blocker … 止まっていること
--    meeting … 面談・研修
--    この2つと task_overdue・message だけが、プッシュ通知にもなる。
--    申請（expense / request / booking）はベルに出すだけ。
--    通知が多いと、全部読まなくなる
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_notifications') is not null then
    alter table public.gw_notifications
      drop constraint if exists gw_notifications_kind_check;
    alter table public.gw_notifications
      add constraint gw_notifications_kind_check
      check (kind in ('general','task_overdue','task_assigned','notice','message',
                      'booking','expense','request','blocker','meeting'));
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 5) RLS
--    読めるのは自分の行だけ。書き込みは service_role の API（api/push/*）だけ。
--    宛先（endpoint）は、それ自体が「その端末に通知を送れる鍵」なので、
--    他人の行を読ませない
-- -----------------------------------------------------------------------------
alter table public.gw_push_subs      enable row level security;
alter table public.gw_reminder_prefs enable row level security;
alter table public.gw_reminder_log   enable row level security;

drop policy if exists gw_push_subs_own on public.gw_push_subs;
create policy gw_push_subs_own on public.gw_push_subs
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists gw_reminder_prefs_own on public.gw_reminder_prefs;
create policy gw_reminder_prefs_own on public.gw_reminder_prefs
  for select to authenticated
  using (employee_id = public.gw_employee_id(tenant_id));

drop policy if exists gw_reminder_log_own on public.gw_reminder_log;
create policy gw_reminder_log_own on public.gw_reminder_log
  for select to authenticated
  using (employee_id in (
    select id from public.gw_employees where user_id = auth.uid()));


notify pgrst, 'reload schema';

-- 確認:
--   -- 誰が通知を許可しているか
--   select e.display_name, s.label, s.created_at, s.last_ok_at, s.fail_count
--     from public.gw_push_subs s
--     join public.gw_employees e on e.id = s.employee_id
--    order by s.created_at desc;
--
--   -- 送った記録（今日）
--   select * from public.gw_reminder_log where on_date = current_date order by sent_at;
