-- =============================================================================
-- 143: 採用HR → Office の早期引き渡し（社長合格の確定記録・条件ヒアリング・Office への業務の引き渡し）
--
-- ■ 運用の正本（docs/hr-office-handoff.md「早期引き渡し（新フロー）」）
--   社長面談 → 社長が合格を判断（判断者・日時・応募者IDつきで確定）→ 採用担当が条件ヒアリング（候補者の希望）を記録
--   → 人事担当が内容を確認 → ［Officeへ引き渡す］（一度だけ）→ HR では「Officeへ移動済み」、Office で条件手続き
--   「社長合格」は社内の採用判断。候補者の承諾・雇用契約の成立ではない。早期の引き渡しは承諾・正式契約・社員登録ではない。
--
-- ■ 作るもの（新しい表5つ・関数・応募者の安全装置の trigger 1つ。既存の表・列・制約・trigger は変えない）
--   1) gw_hr_ceo_decisions          … 社長判断の確定記録（合格／保留／見送り）。追記だけ（取り消し・変更は新しい行）
--   2) gw_hr_hearings               … 条件ヒアリング（候補者の希望。給与以外）。引き渡しで固定（以後は変えられない）
--   3) gw_hr_hearing_pay            … ヒアリングの給与（候補者希望／社内承認済み）。給与を見られる人だけが読める
--   4) gw_hr_office_intakes         … Office への早期引き渡し（1人に有効なものは1つだけ）
--   5) gw_hr_office_intake_events   … 引き渡しの監査・やりとりの履歴。追記だけ
--
-- ■ 既存の意味は変えない（禁止事項）
--   gw_hr_offers.handoff_at（db/133：承諾・正式契約のあとの引き渡し）・accepted_at・formal_signed_at・
--   db/133 の CHECK と trigger・社員登録のガード（api/hr/applicants/advance.js）には触らない。
--   早期の引き渡しは、ここで作る別の表の事実（gw_hr_office_intakes.handed_at）として持つ。
--
-- ■ 新フローの対象（backfill しない）
--   この SQL は既存の行を1行も作らない・変えない。過去の合格・既存の内定者（offer の版がある人）を新フローへ移さない。
--   新フローの対象は「gw_hr_ceo_decisions に合格（pass）の確定記録があり、gw_hr_offers の版が1つも無い応募者」だけ
--   （アプリの lib/hr-office-intake.js と、下の引き渡しの trigger が同じ条件で判定する）。
--
-- ■ 安全装置（API の確かめに加えて DB でも止める。service role でも同じ）
--   ・社長判断を記録できるのは、その会社の経営者（owner）・管理者（memberships の admin / staff）だけ
--   ・社長判断・引き渡しの履歴は書き換えも削除もできない（追記だけ）
--   ・有効な引き渡しは1人に1つ（部分一意索引）。同時に押しても2つ目は一意違反で入らない
--   ・引き渡せるのは：同じ会社・社員登録前・無限道場リード以外・最新の社長判断が合格・offer の版が無い・
--     ヒアリングが確認済みで必須項目がそろっている（未確定の項目があるときは、管理者の承認と理由が要る）・育成枠以外
--   ・引き渡した内容（誰が・いつ・どのヒアリング・未確定項目・例外の承認）は変えられない
--   ・応募者は、社長判断・ヒアリング・引き渡しの記録がある限り削除できない（on delete restrict）
--     オファーの版・社労士への依頼・正式PDF（既存の表。on delete cascade）がある応募者も削除できない（gw_hr_applicants_guard）
--   ・画面から直接（authenticated）は、承諾済み・完了・社員の結びつけ・（社長・管理者以外の）合格・引き渡し済みの人の状態を書けない
--
-- ■ 見える範囲（RLS）
--   採用HRの人（gw_is_recruiting）と、人事・労務（gw_is_hr）が読むだけ。給与（gw_hr_hearing_pay）は gw_can_see_salary だけ。
--   書くのはサーバ（service role）だけ。API が権限（社長判断は社長・管理者、引き渡しは採用HR）と状態を確かめてから書く。
--
-- ■ 適用の順番
--   db/check_133・check_139 で ❌ が無いこと → この SQL → db/check_143_hr_office_intake.sql で ❌ が無いこと → アプリ。
--   アプリ側は環境変数 HR_OFFICE_INTAKE=1 のときだけ新フローを使う（既定は OFF。Office 側＝PR B が動くまで ON にしない）。
--   戻すときは db/rollback_143_hr_office_intake.sql（有効な引き渡しがあると止まる）。
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 0) 前提が無ければ止まる（何も変えない）
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_hr_applicants') is null or to_regclass('public.gw_hr_offers') is null then
    raise exception 'db/143: gw_hr_applicants・gw_hr_offers がありません（先に db/081_hr_recruiting.sql）。何も変更していません';
  end if;
  if to_regprocedure('public.gw_is_recruiting(uuid)') is null or to_regprocedure('public.gw_is_hr(uuid)') is null then
    raise exception 'db/143: gw_is_recruiting・gw_is_hr がありません（先に db/081_hr_recruiting.sql）。何も変更していません';
  end if;
  if to_regprocedure('public.gw_can_see_salary(uuid)') is null then
    raise exception 'db/143: gw_can_see_salary がありません（先に db/100_hr_pay.sql）。何も変更していません';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_applicants' and column_name = 'offer_type') then
    raise exception 'db/143: gw_hr_applicants.offer_type がありません（先に db/129_hr_offer_type.sql）。何も変更していません';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'handoff_at') then
    raise exception 'db/143: gw_hr_offers.handoff_at がありません（先に db/133_hr_offer_handoff.sql）。何も変更していません';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'offer_pdf_path') then
    raise exception 'db/143: gw_hr_offers.offer_pdf_path がありません（先に db/137_hr_finish.sql）。何も変更していません';
  end if;
  if to_regclass('public.gw_hr_attorney_requests') is null then
    raise exception 'db/143: gw_hr_attorney_requests がありません（先に db/139_hr_contract_procedure.sql）。何も変更していません';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 共通：社長判断ができる人か（経営者 owner・会計側の管理者 admin / staff。lib/gw.js canDecideHire と同じ並び）
--   service role で書くとき auth.uid() は空なので、記録する人（user id）を渡して確かめる
-- -----------------------------------------------------------------------------
create or replace function public.gw_hr_is_hire_decider(p_tenant uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user is not null and (
    exists (select 1 from public.gw_role_grants g join public.gw_employees e on e.id = g.employee_id
             where g.tenant_id = p_tenant and g.role = 'owner' and e.user_id = p_user)
    or exists (select 1 from public.memberships m
                where m.tenant_id = p_tenant and m.user_id = p_user and m.role in ('admin', 'staff'))
  )
$$;

comment on function public.gw_hr_is_hire_decider(uuid, uuid) is
  '採用HR：社長判断（合格・保留・見送り）・未確定項目の例外承認ができる人か（経営者・管理者。db/143）';

-- 追記だけの表で使う：書き換え・削除を止める
create or replace function public.gw_hr_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception '% は書き換え・削除できません（db/143）', tg_table_name
    using errcode = '55000', hint = '記録は足すだけです（取り消し・変更は新しい行で記録します）';
end $$;

comment on function public.gw_hr_append_only() is
  '採用HR：社長判断・引き渡しの履歴を書き換え・削除させない（db/143）';

-- -----------------------------------------------------------------------------
-- 1) 社長判断の確定記録（追記だけ）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_ceo_decisions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  applicant_id           uuid not null references public.gw_hr_applicants(id) on delete restrict,
  -- pass＝合格（条件ヒアリングへ）／hold＝保留／reject＝見送り
  decision               text not null,
  decided_by             uuid not null references auth.users(id) on delete restrict,
  decided_by_employee_id uuid,
  decided_at             timestamptz not null default now(),
  note                   text,
  created_at             timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_ceo_decisions_decision_chk') then
    alter table public.gw_hr_ceo_decisions add constraint gw_hr_ceo_decisions_decision_chk
      check (decision in ('pass', 'hold', 'reject'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_ceo_decisions_note_chk') then
    alter table public.gw_hr_ceo_decisions add constraint gw_hr_ceo_decisions_note_chk
      check (note is null or char_length(note) <= 1000);
  end if;
end $$;

create index if not exists idx_gw_hr_ceo_decisions_applicant
  on public.gw_hr_ceo_decisions(tenant_id, applicant_id, decided_at desc);

-- 記録する前：同じ会社の応募者・判断できる人だけ
create or replace function public.gw_hr_ceo_decisions_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.gw_hr_applicants a where a.id = new.applicant_id and a.tenant_id = new.tenant_id) then
    raise exception 'gw_hr_ceo_decisions: 応募者が同じ会社にありません（db/143）' using errcode = '23514';
  end if;
  if not public.gw_hr_is_hire_decider(new.tenant_id, new.decided_by) then
    raise exception 'gw_hr_ceo_decisions: 社長判断を記録できるのは社長・管理者だけです（db/143）'
      using errcode = '42501', hint = '採用担当・人事のランク評価だけでは合格にできません';
  end if;
  return new;
end $$;

comment on function public.gw_hr_ceo_decisions_check() is
  '採用HR：社長判断は同じ会社の応募者に、社長・管理者だけが記録できる（db/143）';

drop trigger if exists gw_hr_ceo_decisions_check on public.gw_hr_ceo_decisions;
create trigger gw_hr_ceo_decisions_check
  before insert on public.gw_hr_ceo_decisions
  for each row execute function public.gw_hr_ceo_decisions_check();

drop trigger if exists gw_hr_ceo_decisions_guard on public.gw_hr_ceo_decisions;
create trigger gw_hr_ceo_decisions_guard
  before update or delete on public.gw_hr_ceo_decisions
  for each row execute function public.gw_hr_append_only();

-- -----------------------------------------------------------------------------
-- 2) 条件ヒアリング（候補者の希望。給与以外）。引き渡しで固定する
--    各項目は「値がある」か「未確定／Officeで確認（unresolved に項目名）」のどちらか。推測値は入れない（API で確かめる）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_hearings (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  applicant_id          uuid not null references public.gw_hr_applicants(id) on delete restrict,
  offer_type            text,
  job_title             text,
  duties                text,
  desired_join_date     date,
  work_location         text,
  remote_policy         text,
  weekly_days           numeric(3, 1),
  weekly_hours          numeric(5, 1),
  contract_period       text,
  allowances_note       text,
  other_note            text,
  -- 未確定／Officeで確認 の項目名（["desired_join_date", "desired_pay", …]）
  unresolved            jsonb not null default '[]'::jsonb,
  -- 未確定のまま引き渡す例外（管理者の承認と理由）
  exception_reason      text,
  exception_approved_by uuid references auth.users(id) on delete restrict,
  exception_approved_at timestamptz,
  recorded_by           uuid not null references auth.users(id) on delete restrict,
  recorded_at           timestamptz not null default now(),
  updated_by            uuid references auth.users(id) on delete restrict,
  updated_at            timestamptz not null default now(),
  -- 人事担当が内容を確認した
  confirmed_by          uuid references auth.users(id) on delete restrict,
  confirmed_at          timestamptz,
  -- 引き渡しで固定（以後は変えられない）
  locked_at             timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_hearings_offer_type_chk') then
    alter table public.gw_hr_hearings add constraint gw_hr_hearings_offer_type_chk
      check (offer_type is null or offer_type in ('executive_employee', 'training', 'contractor', 'part_time', 'spot'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_hearings_unresolved_chk') then
    alter table public.gw_hr_hearings add constraint gw_hr_hearings_unresolved_chk
      check (jsonb_typeof(unresolved) = 'array' and jsonb_array_length(unresolved) <= 30);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_hearings_text_chk') then
    alter table public.gw_hr_hearings add constraint gw_hr_hearings_text_chk
      check (coalesce(char_length(job_title), 0) <= 200 and coalesce(char_length(duties), 0) <= 2000
         and coalesce(char_length(work_location), 0) <= 200 and coalesce(char_length(remote_policy), 0) <= 200
         and coalesce(char_length(contract_period), 0) <= 200 and coalesce(char_length(allowances_note), 0) <= 1000
         and coalesce(char_length(other_note), 0) <= 2000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_hearings_range_chk') then
    alter table public.gw_hr_hearings add constraint gw_hr_hearings_range_chk
      check ((weekly_days is null or (weekly_days > 0 and weekly_days <= 7))
         and (weekly_hours is null or (weekly_hours > 0 and weekly_hours <= 80)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_hearings_exception_chk') then
    alter table public.gw_hr_hearings add constraint gw_hr_hearings_exception_chk
      check ((exception_approved_by is null and exception_approved_at is null)
          or (exception_approved_by is not null and exception_approved_at is not null
              and char_length(btrim(coalesce(exception_reason, ''))) between 1 and 1000));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_hearings_confirm_chk') then
    alter table public.gw_hr_hearings add constraint gw_hr_hearings_confirm_chk
      check ((confirmed_by is null) = (confirmed_at is null));
  end if;
end $$;

-- 編集中（固定前）のヒアリングは1人に1つ
create unique index if not exists uq_gw_hr_hearings_open
  on public.gw_hr_hearings(tenant_id, applicant_id) where locked_at is null;
create index if not exists idx_gw_hr_hearings_applicant
  on public.gw_hr_hearings(tenant_id, applicant_id, recorded_at desc);

create or replace function public.gw_hr_hearings_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'gw_hr_hearings は削除できません（db/143）' using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.gw_hr_applicants a where a.id = new.applicant_id and a.tenant_id = new.tenant_id) then
      raise exception 'gw_hr_hearings: 応募者が同じ会社にありません（db/143）' using errcode = '23514';
    end if;
    if new.locked_at is not null then
      raise exception 'gw_hr_hearings: 固定したヒアリングは足せません（引き渡しで固定します）（db/143）' using errcode = '23514';
    end if;
    -- ヒアリングは社長の合格のあとだけ（最新の社長判断が合格）
    if coalesce((select d.decision from public.gw_hr_ceo_decisions d
                  where d.tenant_id = new.tenant_id and d.applicant_id = new.applicant_id
                  order by d.decided_at desc, d.created_at desc limit 1), '') <> 'pass' then
      raise exception 'gw_hr_hearings: 社長の合格判断が確定していない応募者にはヒアリングを記録できません（db/143）' using errcode = '23514';
    end if;
  else
    if old.locked_at is not null then
      raise exception 'gw_hr_hearings は Office へ引き渡したあと変更できません（db/143）'
        using errcode = '55000', hint = '引き渡した内容の修正は、Office での確認・差し戻しで扱います';
    end if;
    if new.tenant_id is distinct from old.tenant_id or new.applicant_id is distinct from old.applicant_id
       or new.recorded_by is distinct from old.recorded_by or new.recorded_at is distinct from old.recorded_at then
      raise exception 'gw_hr_hearings: 応募者・記録した人と日時は変更できません（db/143）' using errcode = '55000';
    end if;
  end if;
  if new.exception_approved_by is not null
     and (tg_op = 'INSERT' or new.exception_approved_by is distinct from old.exception_approved_by)
     and not public.gw_hr_is_hire_decider(new.tenant_id, new.exception_approved_by) then
    raise exception 'gw_hr_hearings: 未確定のまま引き渡す例外を承認できるのは社長・管理者だけです（db/143）' using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.gw_hr_hearings_guard() is
  '採用HR：条件ヒアリングは同じ会社の応募者に。引き渡しで固定したら変えられない。例外の承認は社長・管理者だけ（db/143）';

drop trigger if exists gw_hr_hearings_guard on public.gw_hr_hearings;
create trigger gw_hr_hearings_guard
  before insert or update or delete on public.gw_hr_hearings
  for each row execute function public.gw_hr_hearings_guard();

-- -----------------------------------------------------------------------------
-- 3) ヒアリングの給与（候補者希望／社内承認済み）。給与を見られる人だけが読む
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_hearing_pay (
  hearing_id          uuid primary key references public.gw_hr_hearings(id) on delete restrict,
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  applicant_id        uuid not null references public.gw_hr_applicants(id) on delete restrict,
  -- 候補者希望（「候補者希望」と表示。会社の決定ではない）
  desired_wage_type   text,
  desired_amount      integer,
  desired_note        text,
  -- 社内承認済み（経営者が決めた額。決まっていなければ空＝未確定／Officeで確認）
  approved_wage_type  text,
  approved_amount     integer,
  approved_by         uuid references auth.users(id) on delete restrict,
  approved_at         timestamptz,
  updated_by          uuid references auth.users(id) on delete restrict,
  updated_at          timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_hearing_pay_amount_chk') then
    alter table public.gw_hr_hearing_pay add constraint gw_hr_hearing_pay_amount_chk
      check ((desired_amount is null or desired_amount between 0 and 100000000)
         and (approved_amount is null or approved_amount between 0 and 100000000)
         and coalesce(char_length(desired_wage_type), 0) <= 20 and coalesce(char_length(approved_wage_type), 0) <= 20
         and coalesce(char_length(desired_note), 0) <= 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_hearing_pay_approved_chk') then
    alter table public.gw_hr_hearing_pay add constraint gw_hr_hearing_pay_approved_chk
      check ((approved_amount is null and approved_by is null and approved_at is null)
          or (approved_amount is not null and approved_by is not null and approved_at is not null));
  end if;
end $$;

create or replace function public.gw_hr_hearing_pay_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare h record;
begin
  if tg_op = 'DELETE' then
    raise exception 'gw_hr_hearing_pay は削除できません（db/143）' using errcode = '55000';
  end if;
  select tenant_id, applicant_id, locked_at into h from public.gw_hr_hearings where id = new.hearing_id;
  if h.tenant_id is distinct from new.tenant_id or h.applicant_id is distinct from new.applicant_id then
    raise exception 'gw_hr_hearing_pay: ヒアリングと会社・応募者が違います（db/143）' using errcode = '23514';
  end if;
  if h.locked_at is not null then
    raise exception 'gw_hr_hearing_pay は Office へ引き渡したあと変更できません（db/143）' using errcode = '55000';
  end if;
  return new;
end $$;

drop trigger if exists gw_hr_hearing_pay_guard on public.gw_hr_hearing_pay;
create trigger gw_hr_hearing_pay_guard
  before insert or update or delete on public.gw_hr_hearing_pay
  for each row execute function public.gw_hr_hearing_pay_guard();

-- -----------------------------------------------------------------------------
-- 4) Office への早期引き渡し（handoff_at〔db/133〕とは別の事実）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_office_intakes (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  applicant_id          uuid not null references public.gw_hr_applicants(id) on delete restrict,
  ceo_decision_id       uuid not null references public.gw_hr_ceo_decisions(id) on delete restrict,
  hearing_id            uuid not null references public.gw_hr_hearings(id) on delete restrict,
  -- 引き渡したときのヒアリングの写し（給与は入れない）
  hearing_snapshot      jsonb not null default '{}'::jsonb,
  unresolved_items      jsonb not null default '[]'::jsonb,
  exception_reason      text,
  exception_approved_by uuid references auth.users(id) on delete restrict,
  exception_approved_at timestamptz,
  handed_by             uuid not null references auth.users(id) on delete restrict,
  handed_by_employee_id uuid,
  handed_at             timestamptz not null default now(),
  -- 同じ操作の送り直し（画面の二度押し・通信のやり直し）を1件にまとめるための任意の鍵
  client_request_id     text,
  -- Office 側（PR B で使う）。office_status は導出できない手動段階の補助（表示は lib/hr-office-intake.js が導出）
  office_assignee_id    uuid,
  office_status         text not null default 'not_started',
  received_by           uuid references auth.users(id) on delete restrict,
  received_at           timestamptz,
  offer_id              uuid references public.gw_hr_offers(id) on delete restrict,
  closed_reason         text,
  closed_by             uuid references auth.users(id) on delete restrict,
  closed_at             timestamptz,
  -- 差し戻し（誤操作の取り消し。行は消さない）
  returned_by           uuid references auth.users(id) on delete restrict,
  returned_at           timestamptz,
  return_reason         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_office_intakes_status_chk') then
    alter table public.gw_hr_office_intakes add constraint gw_hr_office_intakes_status_chk
      check (office_status in ('not_started', 'organizing', 'attorney_requested', 'awaiting_official_pdf',
                               'awaiting_consent', 'contracting', 'preparing_join', 'completed', 'withdrawn'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_office_intakes_unresolved_chk') then
    alter table public.gw_hr_office_intakes add constraint gw_hr_office_intakes_unresolved_chk
      check (jsonb_typeof(unresolved_items) = 'array' and jsonb_typeof(hearing_snapshot) = 'object');
  end if;
  -- 未確定の項目を残して引き渡すときは、管理者の承認（人・日時）と理由が要る
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_office_intakes_exception_chk') then
    alter table public.gw_hr_office_intakes add constraint gw_hr_office_intakes_exception_chk
      check (jsonb_array_length(unresolved_items) = 0
          or (exception_approved_by is not null and exception_approved_at is not null
              and char_length(btrim(coalesce(exception_reason, ''))) between 1 and 1000));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_office_intakes_return_chk') then
    alter table public.gw_hr_office_intakes add constraint gw_hr_office_intakes_return_chk
      check ((returned_at is null and returned_by is null and return_reason is null)
          or (returned_at is not null and returned_by is not null and char_length(btrim(coalesce(return_reason, ''))) between 1 and 1000));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_office_intakes_closed_chk') then
    alter table public.gw_hr_office_intakes add constraint gw_hr_office_intakes_closed_chk
      check ((closed_at is null) = (closed_by is null)
         and (office_status <> 'withdrawn' or (closed_at is not null and char_length(btrim(coalesce(closed_reason, ''))) between 1 and 1000)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_office_intakes_received_chk') then
    alter table public.gw_hr_office_intakes add constraint gw_hr_office_intakes_received_chk
      check ((received_at is null) = (received_by is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_office_intakes_request_chk') then
    alter table public.gw_hr_office_intakes add constraint gw_hr_office_intakes_request_chk
      check (client_request_id is null or char_length(client_request_id) between 8 and 100);
  end if;
end $$;

-- 有効な引き渡し（差し戻していないもの）は1人に1つ。二重の引き渡し・同時押しを DB で止める
create unique index if not exists uq_gw_hr_office_intakes_active
  on public.gw_hr_office_intakes(tenant_id, applicant_id) where returned_at is null;
create unique index if not exists uq_gw_hr_office_intakes_request
  on public.gw_hr_office_intakes(tenant_id, client_request_id) where client_request_id is not null;
create index if not exists idx_gw_hr_office_intakes_status
  on public.gw_hr_office_intakes(tenant_id, office_status, handed_at desc);

-- 引き渡す前：新フローの対象か・ヒアリングがそろっているか（API と同じ条件）
create or replace function public.gw_hr_office_intakes_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  a jsonb;
  d record;
  h record;
  k text;
  required text[] := array['offer_type', 'job_title', 'duties', 'desired_join_date', 'work_location',
                           'remote_policy', 'weekly_days', 'weekly_hours', 'contract_period'];
begin
  select to_jsonb(x) into a from public.gw_hr_applicants x where x.id = new.applicant_id and x.tenant_id = new.tenant_id;
  if a is null then
    raise exception 'gw_hr_office_intakes: 応募者が同じ会社にありません（db/143）' using errcode = '23514';
  end if;
  if a ->> 'employee_id' is not null then
    raise exception 'gw_hr_office_intakes: 社員登録済みの応募者は引き渡せません（db/143）' using errcode = '23514';
  end if;
  if a ->> 'status' in ('declined', 'passed', 'position_closed', 'done') then
    raise exception 'gw_hr_office_intakes: 終了・辞退・社員登録済みの応募者は引き渡せません（db/143）' using errcode = '23514';
  end if;
  if a ->> 'lead_category' = 'mugendojo' then
    raise exception 'gw_hr_office_intakes: 無限道場リードは Office へ引き渡しません（db/143）' using errcode = '23514';
  end if;
  if exists (select 1 from public.gw_hr_offers o where o.applicant_id = new.applicant_id) then
    raise exception 'gw_hr_office_intakes: 条件の版（オファー）がある応募者は旧フロー（HRで契約手続き）のままです（db/143）' using errcode = '23514';
  end if;
  -- 最新の社長判断が合格で、それがこの引き渡しの根拠
  select id, tenant_id, applicant_id, decision into d from public.gw_hr_ceo_decisions
   where tenant_id = new.tenant_id and applicant_id = new.applicant_id
   order by decided_at desc, created_at desc limit 1;
  if d.id is null or d.decision <> 'pass' then
    raise exception 'gw_hr_office_intakes: 社長の合格判断が確定していません（db/143）' using errcode = '23514';
  end if;
  if d.id <> new.ceo_decision_id then
    raise exception 'gw_hr_office_intakes: 根拠の社長判断が最新ではありません（db/143）' using errcode = '23514';
  end if;
  select * into h from public.gw_hr_hearings where id = new.hearing_id;
  if h.id is null or h.tenant_id <> new.tenant_id or h.applicant_id <> new.applicant_id then
    raise exception 'gw_hr_office_intakes: ヒアリングが同じ会社・同じ応募者のものではありません（db/143）' using errcode = '23514';
  end if;
  if h.locked_at is not null then
    raise exception 'gw_hr_office_intakes: このヒアリングはすでに引き渡しに使われています（db/143）' using errcode = '23514';
  end if;
  if h.confirmed_at is null then
    raise exception 'gw_hr_office_intakes: ヒアリングの内容確認がまだです（db/143）' using errcode = '23514';
  end if;
  if h.offer_type is null then
    raise exception 'gw_hr_office_intakes: 採用区分が決まっていません（db/143）' using errcode = '23514';
  end if;
  if h.offer_type = 'training' then
    raise exception 'gw_hr_office_intakes: 育成枠は Office へ引き渡しません（db/143）' using errcode = '23514';
  end if;
  -- 必須項目：値があるか、未確定／Officeで確認 として挙げてあるか
  foreach k in array required loop
    if to_jsonb(h) ->> k is null and not (h.unresolved ? k) then
      raise exception 'gw_hr_office_intakes: 条件ヒアリング不足（%）（db/143）', k using errcode = '23514';
    end if;
  end loop;
  if not (h.unresolved ? 'desired_pay')
     and not exists (select 1 from public.gw_hr_hearing_pay p where p.hearing_id = h.id and p.desired_amount is not null) then
    raise exception 'gw_hr_office_intakes: 条件ヒアリング不足（desired_pay）（db/143）' using errcode = '23514';
  end if;
  -- 未確定の項目と例外の承認は、ヒアリングのものと同じ（引き渡す人が書き換えない）
  if new.unresolved_items is distinct from h.unresolved
     or new.exception_reason is distinct from h.exception_reason
     or new.exception_approved_by is distinct from h.exception_approved_by
     or new.exception_approved_at is distinct from h.exception_approved_at then
    raise exception 'gw_hr_office_intakes: 未確定の項目・例外の承認がヒアリングと違います（db/143）' using errcode = '23514';
  end if;
  if new.offer_id is not null or new.returned_at is not null or new.closed_at is not null or new.received_at is not null
     or new.office_status <> 'not_started' then
    raise exception 'gw_hr_office_intakes: 引き渡しは「未着手」で記録します（db/143）' using errcode = '23514';
  end if;
  if new.office_assignee_id is not null
     and not exists (select 1 from public.gw_employees e where e.id = new.office_assignee_id and e.tenant_id = new.tenant_id) then
    raise exception 'gw_hr_office_intakes: Office 担当が同じ会社の社員ではありません（db/143）' using errcode = '23514';
  end if;
  return new;
end $$;

comment on function public.gw_hr_office_intakes_check() is
  '採用HR：早期引き渡しは、社長合格（最新）・offer の版なし・ヒアリング確認済み（不足なし、未確定は承認つき）・育成枠以外だけ（db/143）';

drop trigger if exists gw_hr_office_intakes_check on public.gw_hr_office_intakes;
create trigger gw_hr_office_intakes_check
  before insert on public.gw_hr_office_intakes
  for each row execute function public.gw_hr_office_intakes_check();

-- 引き渡したら、ヒアリングを固定する（同じトランザクションの中。引き渡しが失敗したら固定も戻る）
create or replace function public.gw_hr_office_intakes_lock_hearing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.gw_hr_hearings set locked_at = new.handed_at where id = new.hearing_id and locked_at is null;
  return null;
end $$;

drop trigger if exists gw_hr_office_intakes_lock_hearing on public.gw_hr_office_intakes;
create trigger gw_hr_office_intakes_lock_hearing
  after insert on public.gw_hr_office_intakes
  for each row execute function public.gw_hr_office_intakes_lock_hearing();

-- 引き渡した内容は変えない。差し戻し・終了は一度だけ。完了・辞退は終端。削除しない
create or replace function public.gw_hr_office_intakes_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c text;
  o jsonb;
  n jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception 'gw_hr_office_intakes は削除できません（db/143）'
      using errcode = '55000', hint = '誤操作は差し戻し（returned_at・理由）で記録します。行は消しません';
  end if;
  o := to_jsonb(old);
  n := to_jsonb(new);
  foreach c in array array['id', 'tenant_id', 'applicant_id', 'ceo_decision_id', 'hearing_id', 'hearing_snapshot',
                           'unresolved_items', 'exception_reason', 'exception_approved_by', 'exception_approved_at',
                           'handed_by', 'handed_by_employee_id', 'handed_at', 'client_request_id', 'created_at'] loop
    if (n -> c) is distinct from (o -> c) then
      raise exception 'gw_hr_office_intakes.% は引き渡したあと変更できません（db/143）', c using errcode = '55000';
    end if;
  end loop;
  if old.returned_at is not null then
    raise exception 'gw_hr_office_intakes: 差し戻した引き渡しは変更できません（新しい引き渡しで記録します）（db/143）' using errcode = '55000';
  end if;
  if old.closed_at is not null then
    foreach c in array array['closed_at', 'closed_by', 'closed_reason'] loop
      if (n -> c) is distinct from (o -> c) then
        raise exception 'gw_hr_office_intakes.% は記録したあと変更できません（db/143）', c using errcode = '55000';
      end if;
    end loop;
  end if;
  if old.received_at is not null and (new.received_at is distinct from old.received_at or new.received_by is distinct from old.received_by) then
    raise exception 'gw_hr_office_intakes: 受領の記録は変更できません（db/143）' using errcode = '55000';
  end if;
  if old.office_status in ('completed', 'withdrawn') and new.office_status is distinct from old.office_status then
    raise exception 'gw_hr_office_intakes: 完了・辞退／不成立のあとは状態を変えられません（db/143）' using errcode = '55000';
  end if;
  if old.offer_id is not null and new.offer_id is distinct from old.offer_id then
    raise exception 'gw_hr_office_intakes.offer_id は一度決めたら変更できません（db/143）' using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end $$;

comment on function public.gw_hr_office_intakes_guard() is
  '採用HR：引き渡した内容（誰が・いつ・ヒアリング・未確定・例外の承認）を変えさせない。差し戻し・終了は一度だけ。削除しない（db/143）';

drop trigger if exists gw_hr_office_intakes_guard on public.gw_hr_office_intakes;
create trigger gw_hr_office_intakes_guard
  before update or delete on public.gw_hr_office_intakes
  for each row execute function public.gw_hr_office_intakes_guard();

-- -----------------------------------------------------------------------------
-- 5) 引き渡しの監査・やりとりの履歴（追記だけ）。本文に給与・連絡先を書かない
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_office_intake_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  intake_id         uuid not null references public.gw_hr_office_intakes(id) on delete restrict,
  applicant_id      uuid not null references public.gw_hr_applicants(id) on delete restrict,
  kind              text not null,
  actor_id          uuid references auth.users(id) on delete restrict,
  actor_employee_id uuid,
  message           text,
  fields            jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_office_intake_events_kind_chk') then
    alter table public.gw_hr_office_intake_events add constraint gw_hr_office_intake_events_kind_chk
      check (kind in ('handed_off', 'received', 'status_changed', 'revision_requested', 'revision_answered',
                      'returned', 'closed', 'assignee_changed', 'note'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_office_intake_events_text_chk') then
    alter table public.gw_hr_office_intake_events add constraint gw_hr_office_intake_events_text_chk
      check ((message is null or char_length(message) <= 1000) and jsonb_typeof(fields) = 'array');
  end if;
end $$;

create index if not exists idx_gw_hr_office_intake_events_intake
  on public.gw_hr_office_intake_events(intake_id, created_at);

create or replace function public.gw_hr_office_intake_events_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.gw_hr_office_intakes i
                  where i.id = new.intake_id and i.tenant_id = new.tenant_id and i.applicant_id = new.applicant_id) then
    raise exception 'gw_hr_office_intake_events: 引き渡しと会社・応募者が違います（db/143）' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists gw_hr_office_intake_events_check on public.gw_hr_office_intake_events;
create trigger gw_hr_office_intake_events_check
  before insert on public.gw_hr_office_intake_events
  for each row execute function public.gw_hr_office_intake_events_check();

drop trigger if exists gw_hr_office_intake_events_guard on public.gw_hr_office_intake_events;
create trigger gw_hr_office_intake_events_guard
  before update or delete on public.gw_hr_office_intake_events
  for each row execute function public.gw_hr_append_only();

-- -----------------------------------------------------------------------------
-- 6) 応募者（gw_hr_applicants）の安全装置。既存の列・制約・trigger は変えず、trigger を1つ足すだけ
--   ・契約の履歴（オファーの版〔handoff_at を含む〕・社労士への依頼・正式PDF・社長判断・ヒアリング・早期引き渡し）がある
--     応募者は削除できない（オファー等は on delete cascade なので、削除で一緒に消えてしまうのを止める）。
--     会社ごと消す（tenants からの cascade）は止めない
--   ・ログインした人（authenticated。画面から PostgREST で直接）は、次を書けない（サーバの service role の流れ
--     ＝本人の承諾〔api/hr/offers/public.js〕・社員登録〔api/hr/applicants/advance.js〕は止めない）：
--       承諾済み（accepted）・完了（done）にする／完了の人の状態を変える／社員を結びつける（employee_id）／
--       社長・管理者でないのに合格（decision = hired）にする／Office へ引き渡し済みの人の選考段階・状態・判断を変える
-- -----------------------------------------------------------------------------
create or replace function public.gw_hr_applicant_contract_history(p_applicant uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  out text[] := '{}';
  hit boolean;
begin
  if exists (select 1 from public.gw_hr_offers o where o.applicant_id = p_applicant) then
    out := out || 'オファー・条件の版'::text;
  end if;
  if exists (select 1 from public.gw_hr_offers o where o.applicant_id = p_applicant and o.handoff_at is not null) then
    out := out || 'Office への引き渡し（handoff_at）'::text;
  end if;
  -- db/139 の表（戻されていても止まらないよう、あるときだけ読む）
  if to_regclass('public.gw_hr_attorney_requests') is not null then
    execute 'select exists (select 1 from public.gw_hr_attorney_requests where applicant_id = $1)' into hit using p_applicant;
    if hit then out := out || '社労士への依頼'::text; end if;
  end if;
  if to_regclass('public.gw_hr_offer_official_docs') is not null then
    execute 'select exists (select 1 from public.gw_hr_offer_official_docs where applicant_id = $1)' into hit using p_applicant;
    if hit then out := out || '正式PDF'::text; end if;
  end if;
  if exists (select 1 from public.gw_hr_ceo_decisions d where d.applicant_id = p_applicant) then
    out := out || '社長判断の記録'::text;
  end if;
  if exists (select 1 from public.gw_hr_hearings h where h.applicant_id = p_applicant) then
    out := out || '条件ヒアリング'::text;
  end if;
  if exists (select 1 from public.gw_hr_office_intakes i where i.applicant_id = p_applicant) then
    out := out || 'Office への早期引き渡し'::text;
  end if;
  return out;
end $$;

comment on function public.gw_hr_applicant_contract_history(uuid) is
  '採用HR：応募者を削除すると消えてしまう契約の履歴（あれば名前を並べる。空なら削除してよい。db/143）';

create or replace function public.gw_hr_has_active_intake(p_tenant uuid, p_applicant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.gw_hr_office_intakes i
                  where i.tenant_id = p_tenant and i.applicant_id = p_applicant and i.returned_at is null)
$$;

comment on function public.gw_hr_has_active_intake(uuid, uuid) is
  '採用HR：Office へ引き渡し済み（差し戻していない早期引き渡しがある）か（db/143）';

-- security definer にしない（current_user で「画面から直接か・サーバか」を見るため）
create or replace function public.gw_hr_applicants_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  hist text[];
begin
  if tg_op = 'DELETE' then
    -- 会社ごと消す（tenants からの cascade。trigger の中から呼ばれる）は止めない
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    hist := public.gw_hr_applicant_contract_history(old.id);
    if cardinality(hist) > 0 then
      raise exception 'gw_hr_applicants: 契約の履歴（%）がある応募者は削除できません（db/143）', array_to_string(hist, '・')
        using errcode = '23503', hint = '選考を終えるときは、状態を「辞退」「見送り」「募集終了」にしてください（履歴は残ります）';
    end if;
    return old;
  end if;

  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.status is distinct from old.status and new.status in ('accepted', 'done') then
    raise exception 'gw_hr_applicants: 承諾済み・完了は、本人の承諾・社員登録の手続きでだけ記録します（db/143）'
      using errcode = '42501';
  end if;
  if old.status = 'done' and new.status is distinct from old.status then
    raise exception 'gw_hr_applicants: 社員登録が完了した応募者の状態は変えられません（db/143）' using errcode = '42501';
  end if;
  if new.employee_id is distinct from old.employee_id then
    raise exception 'gw_hr_applicants: 社員との結びつけは社員登録の手続きでだけ記録します（db/143）' using errcode = '42501';
  end if;
  if new.decision = 'hired' and new.decision is distinct from old.decision
     and not public.gw_hr_is_hire_decider(new.tenant_id, auth.uid()) then
    raise exception 'gw_hr_applicants: 合格にできるのは社長・管理者だけです（db/143）'
      using errcode = '42501', hint = '採用担当・人事のランク評価だけでは合格にできません';
  end if;
  if (new.status is distinct from old.status or new.stage is distinct from old.stage or new.decision is distinct from old.decision)
     and public.gw_hr_has_active_intake(new.tenant_id, new.id) then
    raise exception 'gw_hr_applicants: Office へ引き渡し済みの応募者の選考段階・状態・判断は変えられません（db/143）'
      using errcode = '42501', hint = 'Office での手続き（辞退・不成立を含む）で記録します';
  end if;
  return new;
end $$;

comment on function public.gw_hr_applicants_guard() is
  '採用HR：契約の履歴がある応募者は削除させない。画面からの直接の書き込みで、承諾・完了・社員登録・社長合格・引き渡し済みを飛び越えさせない（db/143）';

drop trigger if exists gw_hr_applicants_guard on public.gw_hr_applicants;
create trigger gw_hr_applicants_guard
  before update or delete on public.gw_hr_applicants
  for each row execute function public.gw_hr_applicants_guard();

-- -----------------------------------------------------------------------------
-- 7) 見える範囲（RLS）：採用HR・人事労務が読むだけ（給与は gw_can_see_salary だけ）。書くのはサーバだけ
-- -----------------------------------------------------------------------------
alter table public.gw_hr_ceo_decisions enable row level security;
alter table public.gw_hr_hearings enable row level security;
alter table public.gw_hr_hearing_pay enable row level security;
alter table public.gw_hr_office_intakes enable row level security;
alter table public.gw_hr_office_intake_events enable row level security;

drop policy if exists gw_hr_ceo_decisions_read on public.gw_hr_ceo_decisions;
create policy gw_hr_ceo_decisions_read on public.gw_hr_ceo_decisions
  for select to authenticated using (public.gw_is_recruiting(tenant_id) or public.gw_is_hr(tenant_id));
drop policy if exists gw_hr_hearings_read on public.gw_hr_hearings;
create policy gw_hr_hearings_read on public.gw_hr_hearings
  for select to authenticated using (public.gw_is_recruiting(tenant_id) or public.gw_is_hr(tenant_id));
drop policy if exists gw_hr_hearing_pay_read on public.gw_hr_hearing_pay;
create policy gw_hr_hearing_pay_read on public.gw_hr_hearing_pay
  for select to authenticated using (public.gw_can_see_salary(tenant_id));
drop policy if exists gw_hr_office_intakes_read on public.gw_hr_office_intakes;
create policy gw_hr_office_intakes_read on public.gw_hr_office_intakes
  for select to authenticated using (public.gw_is_recruiting(tenant_id) or public.gw_is_hr(tenant_id));
drop policy if exists gw_hr_office_intake_events_read on public.gw_hr_office_intake_events;
create policy gw_hr_office_intake_events_read on public.gw_hr_office_intake_events
  for select to authenticated using (public.gw_is_recruiting(tenant_id) or public.gw_is_hr(tenant_id));

revoke all on public.gw_hr_ceo_decisions, public.gw_hr_hearings, public.gw_hr_hearing_pay,
              public.gw_hr_office_intakes, public.gw_hr_office_intake_events from authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.gw_hr_ceo_decisions, public.gw_hr_hearings, public.gw_hr_hearing_pay,
             public.gw_hr_office_intakes, public.gw_hr_office_intake_events from anon';
  end if;
end $$;
grant select on public.gw_hr_ceo_decisions, public.gw_hr_hearings, public.gw_hr_hearing_pay,
               public.gw_hr_office_intakes, public.gw_hr_office_intake_events to authenticated;
grant all on public.gw_hr_ceo_decisions, public.gw_hr_hearings, public.gw_hr_hearing_pay,
             public.gw_hr_office_intakes, public.gw_hr_office_intake_events to service_role;
-- 判定の関数は、応募者の安全装置（画面から直接書く人＝authenticated の権限で動く）からも呼ぶ
revoke all on function public.gw_hr_is_hire_decider(uuid, uuid) from public;
revoke all on function public.gw_hr_applicant_contract_history(uuid) from public;
revoke all on function public.gw_hr_has_active_intake(uuid, uuid) from public;
grant execute on function public.gw_hr_is_hire_decider(uuid, uuid) to authenticated, service_role;
grant execute on function public.gw_hr_applicant_contract_history(uuid) to authenticated, service_role;
grant execute on function public.gw_hr_has_active_intake(uuid, uuid) to authenticated, service_role;

comment on table public.gw_hr_ceo_decisions is
  '採用HR：社長判断（合格／保留／見送り）の確定記録。判断者・日時・応募者ID。社長・管理者だけ。追記だけ（db/143）';
comment on table public.gw_hr_hearings is
  '採用HR：条件ヒアリング（候補者の希望。給与以外）。未確定は unresolved に挙げる。Office へ引き渡すと固定（db/143）';
comment on table public.gw_hr_hearing_pay is
  '採用HR：条件ヒアリングの給与（候補者希望／社内承認済み）。給与を見られる人だけが読む（db/143）';
comment on table public.gw_hr_office_intakes is
  '採用HR → Office の早期引き渡し（社長合格・ヒアリング記録後）。承諾・正式契約・社員登録ではない。'
  'gw_hr_offers.handoff_at（db/133）とは別。有効なものは1人に1つ。削除しない（db/143）';
comment on table public.gw_hr_office_intake_events is
  '採用HR → Office の引き渡しの監査・やりとりの履歴。追記だけ。給与・連絡先を書かない（db/143）';

commit;

notify pgrst, 'reload schema';
