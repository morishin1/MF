-- =============================================================================
-- 081: 採用HR（/hr） — 応募 → 面接 → 評価 → 社長推薦 → 社長面談 → 採用判断 →
--       合格通知 → 本人承諾 まで。本採用決定後は既存GW（gw_employees・
--       onboarding・契約書作成依頼・電子署名）へそのままつなぐ。
--
-- ■ 新しい人材マスターは作らない
--   候補者は gw_employees にも gw_guests にも登録しない。
--   本採用が決まってはじめて gw_employees ができる（既存の
--   api/employees/onboard.js をそのまま使う。作り直さない）。
--
-- ■ 採用条件は1箇所（gw_hr_applicants）が正
--   合格通知（gw_hr_offers）は「送った時点の条件のスナップショット」を持つ。
--   これは重複保存ではなく、本人に提示した内容を後から変えないための版管理。
--   条件が変わっても、送付済みの通知の中身は変わらない。
--   最新の条件を知りたければ gw_hr_applicants、
--   本人へ実際に送った内容を知りたければ gw_hr_offers。
--
-- ■ 選考ステージと対応ステータスは別軸
--   stage（新規応募〜入社予定、6段階）＝いまどこにいるか。
--   status（面談結果入力待ち・社長判断待ち等）＝いま誰が何をすべきか。
--   同じ列にしない（意味が違う）。
--
-- ■ トークンは、外部メンバー招待（gw_guest_invites・db/078）と同じ考え方
--   SHA-256ハッシュのみ保存・期限付き・再発行で旧URL失効・本人専用。
--   候補者は gw_guests に登録しない（まだ社員でも外部メンバーでもないため）。
--
-- ■ 「本採用へ進める」の二重生成対策
--   gw_hr_applicants.employee_id は一意（1応募者につき1回だけ埋まる）。
--   それだけに頼らず、claim（advance_claimed_at）で「いま処理中」を
--   先に確保してから api/employees/onboard.js の作成へ進む
--   （api/hr/applicants/advance.js）。失敗したら claim を戻し、やり直せるようにする。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 005_groupware_core.sql（gw_employees・gw_role_grants・gw_is_hr）・
--       013_notifications.sql（gw_notifications）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) recruiter ロールを追加
--    人事の全権限は渡さず、採用機能だけを許可する。給与台帳・入退社の機微・
--    会計・他の人事機密は canManageHr / gw_is_hr の対象のままで、
--    recruiter 単体では届かない（gw_is_recruiting は gw_is_hr の上位互換）
-- -----------------------------------------------------------------------------
alter table public.gw_role_grants drop constraint if exists gw_role_grants_role_check;
alter table public.gw_role_grants add constraint gw_role_grants_role_check
  check (role in ('owner', 'hr', 'manager', 'labor_advisor', 'it', 'finance', 'recruiter'));

comment on column public.gw_role_grants.role is
  'owner=経営者 / hr=人事 / manager=マネージャー / labor_advisor=社労士 / '
  'it=IT担当 / finance=経理 / recruiter=採用担当（採用HR機能だけを許可。'
  '給与・入退社機微・会計・他の人事機密は見えない）';

-- 採用（/hr）を使える人。管理者・経営者・人事・採用担当。
-- gw_is_hr（管理者・経営者・人事）の上位互換にしておくことで、
-- 「人事なら採用も見える／採用担当は採用だけ」の両方を1関数で表せる
create or replace function public.gw_is_recruiting(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_is_hr(p_tenant) or public.gw_has_role(p_tenant, 'recruiter')
$$;

comment on function public.gw_is_recruiting(uuid) is
  '採用HR（/hr）を使える人。管理者・経営者・人事・採用担当。'
  'CEO REVIEW（社長判断）は別途 owner ロール・管理者のみに絞る（API層）';

-- -----------------------------------------------------------------------------
-- 2) 応募者。採用条件のSingle Source of Truthはここ
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_applicants (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  name          text not null,
  email         text,
  phone         text,
  profile_url   text,          -- 本人のポートフォリオ・SNS等（任意）
  source        text,          -- 応募媒体（自由記述。既存の値を選ぶ／新しく足す、はUI側の候補表示で行う）
  job_title     text,          -- 応募職種

  stage  text not null default 'applied'
    check (stage in ('applied', 'casual_interview', 'ceo_recommend', 'ceo_interview', 'offer', 'joining_scheduled')),
  status text not null default 'todo'
    check (status in (
      'todo',                    -- 未対応
      'scheduling',               -- 日程調整中
      'interview_scheduled',      -- 面談予定
      'eval_pending',              -- 評価入力待ち
      'ceo_recommend_pending',     -- 社長推薦待ち
      'ceo_interview_pending',     -- 社長面談設定待ち
      'ceo_decision_pending',      -- 社長判断待ち
      'next_scheduling_pending',   -- 次回調整待ち
      'offer_draft_pending',       -- 合格通知作成待ち
      'offer_review_pending',      -- 社内確認待ち
      'offer_send_pending',        -- 本人送付待ち
      'offer_response_pending',    -- 承諾待ち
      'accepted',                  -- 承諾済み
      'declined',                  -- 辞退
      'done',                      -- 完了
      'passed'                     -- 見送り
    )),
  rank text check (rank in ('A', 'B', 'C', 'D')),

  recruiter_id  uuid references public.gw_employees(id) on delete set null,   -- 担当
  decision      text check (decision in ('hired', 'hold', 'rejected')),
  decision_due_on date,       -- 対応期限（期限超過はこの列から算出。専用の列は持たない）

  -- 採用条件（正）。admin-onboard.html（api/employees/onboard.js）の
  -- フォーム項目と同じ名前・同じ形にしておくと、事前入力のときに
  -- 変換なしで渡せる（advance.js 参照）
  employment_type    text,   -- 雇用形態（正社員・契約社員・業務委託 等、自由記述）
  contract_type       text,   -- admin-onboard 側の「無期／有期」に対応
  contract_end_date   date,
  join_date            date,   -- 入社予定日
  probation_months     integer,
  wage_type             text,
  wage_amount           numeric(12, 2),
  weekly_hours          numeric(5, 2),
  work_location         text,

  -- 本採用後の紐付け。1応募者につき1回だけ埋まる
  employee_id          uuid references public.gw_employees(id) on delete set null,
  advance_claimed_at   timestamptz,   -- 「本採用へ進める」処理中の一時ロック（advance.js）

  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (employee_id)
);

create index if not exists idx_gw_hr_applicants_tenant
  on public.gw_hr_applicants(tenant_id, stage, status);
create index if not exists idx_gw_hr_applicants_recruiter
  on public.gw_hr_applicants(recruiter_id);

comment on table public.gw_hr_applicants is
  '採用候補者。gw_employees / gw_guests には登録しない。本採用が決まったら '
  'employee_id が埋まる（api/hr/applicants/advance.js）';
comment on column public.gw_hr_applicants.stage is
  '選考ステージ（いまどこにいるか）。対応ステータス（status）とは別軸';
comment on column public.gw_hr_applicants.status is
  '対応ステータス（いま誰が何をすべきか）。選考ステージ（stage）とは別軸';

-- -----------------------------------------------------------------------------
-- 3) 面談・評価
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_interviews (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  applicant_id  uuid not null references public.gw_hr_applicants(id) on delete cascade,

  kind          text not null default 'casual' check (kind in ('casual', 'ceo')),
  scheduled_at  timestamptz,
  conducted_at  timestamptz,
  interviewer_id uuid references public.gw_employees(id) on delete set null,
  recording_url text,   -- 録画（Google Drive等への外部リンク。このアプリでは保存しない）

  -- 評価項目は固定の列にしない。負担を増やさないため必須にしない
  -- （例: {"personality":"◎","initiative":"○","track_record":"○","direction_fit":"△"}）
  scores jsonb not null default '{}'::jsonb,
  rank text check (rank in ('A', 'B', 'C', 'D')),
  recommend_reason text,
  notes text,
  next_due_on date,   -- この面談のあとの対応期限

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gw_hr_interviews_applicant
  on public.gw_hr_interviews(applicant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 4) 選考タイムライン（本人向け・社内向け、両方の「いま」の表示に使う）
--    gw_activity_log とは役割が違う。あちらは監査、こちらは選考の経過表示
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_timeline (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  applicant_id  uuid not null references public.gw_hr_applicants(id) on delete cascade,

  event_key   text not null,   -- 'applied' / 'casual_interview_done' / 'ceo_recommend' / …
  label       text not null,   -- 画面に出す短い文（例: 「カジュアル面談」）
  detail      text,            -- 補足（例: 「ランクA」）
  occurred_at timestamptz not null default now(),

  created_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_gw_hr_timeline_applicant
  on public.gw_hr_timeline(applicant_id, occurred_at);

-- -----------------------------------------------------------------------------
-- 5) 合格通知（版管理）。1応募者に複数行。最新の有効な1件が「いま送っているもの」
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_offers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  applicant_id  uuid not null references public.gw_hr_applicants(id) on delete cascade,

  version integer not null,

  -- 発行時点のスナップショット（gw_hr_applicants の該当列と同じ形）
  job_title           text,
  employment_type     text,
  contract_type        text,
  contract_end_date    date,
  join_date             date,
  probation_months      integer,
  wage_type              text,
  wage_amount            numeric(12, 2),
  weekly_hours           numeric(5, 2),
  work_location           text,
  message_to_candidate    text,   -- 本人向けメッセージ
  respond_by              date,   -- 回答期限

  token_hash    text not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,   -- 再発行・無効化で立つ（旧URLは以後使えない）

  sent_at       timestamptz,
  viewed_at     timestamptz,
  accepted_at   timestamptz,
  declined_at   timestamptz,
  decline_reason text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  unique (applicant_id, version)
);

create unique index if not exists uq_gw_hr_offers_token on public.gw_hr_offers(token_hash);
create index if not exists idx_gw_hr_offers_applicant
  on public.gw_hr_offers(applicant_id, version desc);

comment on table public.gw_hr_offers is
  '合格通知。1応募者に複数行（版）。条件変更・再発行のたびに新しい行を足し、'
  '古い行は revoked_at で無効化する（上書きしない＝送付済みの内容を後から変えない）';

-- -----------------------------------------------------------------------------
-- 6) 通知の種類に 'hr' を追加（既存 gw_notifications を再利用）
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_notifications') is not null then
    alter table public.gw_notifications drop constraint if exists gw_notifications_kind_check;
    alter table public.gw_notifications add constraint gw_notifications_kind_check
      check (kind in ('general','task_overdue','task_assigned','notice','message',
                      'booking','expense','request','blocker','meeting','hr'));
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 7) RLS：採用HRを使える人（gw_is_recruiting）だけが読み書きできる。
--    候補者向け公開ページは service_role（API）経由でのみ触るので、
--    ここに公開用のポリシーは置かない（billing-submissionsと同じ考え方）
-- -----------------------------------------------------------------------------
alter table public.gw_hr_applicants enable row level security;
alter table public.gw_hr_interviews enable row level security;
alter table public.gw_hr_timeline   enable row level security;
alter table public.gw_hr_offers     enable row level security;

drop policy if exists gw_hr_applicants_staff on public.gw_hr_applicants;
create policy gw_hr_applicants_staff on public.gw_hr_applicants
  for all using (public.gw_is_recruiting(tenant_id)) with check (public.gw_is_recruiting(tenant_id));

drop policy if exists gw_hr_interviews_staff on public.gw_hr_interviews;
create policy gw_hr_interviews_staff on public.gw_hr_interviews
  for all using (public.gw_is_recruiting(tenant_id)) with check (public.gw_is_recruiting(tenant_id));

drop policy if exists gw_hr_timeline_staff on public.gw_hr_timeline;
create policy gw_hr_timeline_staff on public.gw_hr_timeline
  for all using (public.gw_is_recruiting(tenant_id)) with check (public.gw_is_recruiting(tenant_id));

drop policy if exists gw_hr_offers_staff on public.gw_hr_offers;
create policy gw_hr_offers_staff on public.gw_hr_offers
  for all using (public.gw_is_recruiting(tenant_id)) with check (public.gw_is_recruiting(tenant_id));

notify pgrst, 'reload schema';

-- 確認:
--   -- 自分が採用HRを使えるか（ログインした状態で）
--   select public.gw_is_recruiting(tenant_id) as 採用HR可, display_name
--     from public.gw_employees where user_id = auth.uid();
--
--   -- 応募者の、いまの状態
--   select name, stage, status, rank, decision, employee_id
--     from public.gw_hr_applicants order by created_at desc;
