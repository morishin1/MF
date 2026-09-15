-- =============================================================================
-- 070: 入社手続きを「いまどこか」で回す
--
-- ■ 何を足すのか
--
--   1. gw_procedures.stage / stage_at
--        5段階（作成依頼 → 社労士確認 → 締結 → 情報入力・提出 → 完了）。
--        正は5つの表の事実で、段階は lib/onboard-stage.js が計算する。
--        ここに書くのは、前回と比べて「進んだ」を検知して次の担当者へ
--        知らせるため（lib/onboard-advance.js）。手で書き換える列ではない。
--
--   2. gw_sensitive_access_log
--        機密情報（届出の住所・口座、提出書類、契約書）を
--        誰が・いつ・誰のぶんを・どうした（見た／落とした／変えた／消した）。
--        gw_activity_log は「操作」の記録で、閲覧は残していなかった。
--        閲覧の記録が無い仕組みは、本人から見れば監視ではなく放置に見える。
--
--   3. 役割 mynumber_handler（予約）
--        マイナンバー取扱担当。番号そのものはまだ持たない（db/037 の冒頭）。
--        持つと決めたときに、この役割だけが触れる別の表を作る。
--        役割の名前だけ先に確保して、人事・管理者と分けておく。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 008 → 037 → 046 → 056 → 066
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 段階
-- -----------------------------------------------------------------------------
alter table public.gw_procedures
  add column if not exists stage    text,
  add column if not exists stage_at timestamptz;

alter table public.gw_procedures drop constraint if exists gw_procedures_stage_check;
alter table public.gw_procedures add constraint gw_procedures_stage_check
  check (stage is null or stage in
    ('conditions', 'advisor_review', 'signing', 'intake', 'complete'))
  not valid;

comment on column public.gw_procedures.stage is
  '入社手続きの段階。conditions→advisor_review→signing→intake→complete。'
  '正は事実（作成依頼・署名・届出・同意・チェックリスト）で、ここは lib/onboard-stage.js の写し。'
  '前回と比べて進んだことを検知し、次の担当者へ知らせるために置く';

create index if not exists idx_gw_procedures_stage
  on public.gw_procedures(tenant_id, kind, stage);

-- -----------------------------------------------------------------------------
-- 2) 機密情報へのアクセス記録
--
--    ・本人のぶんを本人が見たときは残さない（自分の届出を自分で見るのは当然）
--    ・残すのは、他人のぶんを見た・落とした・変えた・消したとき
--    ・消さない。行を消す権限は service_role にも持たせない（RLS で全部止める）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sensitive_access_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  tenant_id   uuid not null,
  actor_id    uuid,                 -- auth.users.id。消えても記録は残すので FK は張らない
  actor_name  text,
  subject_id  uuid,                 -- 誰のぶんか（gw_employees.id）
  kind        text not null         -- 何を
              check (kind in ('profile', 'bank', 'file', 'contract', 'mynumber', 'export')),
  action      text not null         -- どうした
              check (action in ('view', 'download', 'update', 'delete', 'export')),
  target      text,                 -- 'file:<uuid>' など
  detail      jsonb,
  ip          text,
  user_agent  text
);

comment on table public.gw_sensitive_access_log is
  '機密個人情報（届出・口座・提出書類・契約書・マイナンバー）へのアクセス記録。'
  '誰が・いつ・誰のぶんを・どうしたか。閲覧も残す。消さない';

create index if not exists idx_gw_sensitive_log_subject
  on public.gw_sensitive_access_log(tenant_id, subject_id, at desc);
create index if not exists idx_gw_sensitive_log_actor
  on public.gw_sensitive_access_log(tenant_id, actor_id, at desc);

-- 読めるのは人事・管理者と、自分が対象の本人。書き込みは service_role だけ。
-- 削除の policy は作らない（誰も消せない）
alter table public.gw_sensitive_access_log enable row level security;

drop policy if exists gw_sensitive_log_select on public.gw_sensitive_access_log;
create policy gw_sensitive_log_select on public.gw_sensitive_access_log
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or subject_id = public.gw_employee_id(tenant_id)
  );

-- -----------------------------------------------------------------------------
-- 3) 役割の予約
-- -----------------------------------------------------------------------------
alter table public.gw_role_grants drop constraint if exists gw_role_grants_role_check;
alter table public.gw_role_grants add constraint gw_role_grants_role_check
  check (role in ('owner', 'hr', 'manager', 'labor_advisor', 'it', 'finance',
                  'mynumber_handler'));

notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, p.stage, p.stage_at, p.target_on
--     from public.gw_procedures p
--     join public.gw_employees e on e.id = p.employee_id
--    where p.kind = 'onboarding'
--    order by p.target_on nulls last;
