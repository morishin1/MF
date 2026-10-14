-- =============================================================================
-- 120_left_gate.sql — 退職者（left）を、DB でも止める
--
-- ■ 何が問題だったか
--   退職にしても、内部ロール（gw_role_grants）・アプリ利用権限（gw_app_grants）・
--   会計のメンバーシップが残っていると、DB の権限関数（gw_has_role / gw_has_app / gw_is_hr …）は
--   「入れる」と答える。さらに gw_employees_peer_select は「名簿に行がある人」なら誰でも
--   全社員の名簿を読め、gw_employees_self_update は自分の行を何でも書き換えられる（status を在籍に戻せる）。
--   画面（js/layout.js）の転送と API（lib/auth.js）が止めていても、Supabase を直接呼ばれると通る。
--
-- ■ 方針（権限の行は消さない）
--   ・権限の行は残す（履歴・監査・再雇用時の確認のため）
--   ・退職者として扱う人は、行が残っていても、権限関数が「いいえ」と答える
--   ・退職者として扱う条件は lib/left-gate.js と同じ
--       status = 'left'
--       または status = 'leaving' で退職日（left_on）が過ぎている（日本時間の翌日 0 時から）
--
-- ■ 変えるもの（すべて create or replace。べき等）
--   gw_employee_is_left(status, left_on)  … 新規。退職者として扱うか
--   gw_me_is_left()                       … 新規。ログイン中の人が退職者か
--   gw_employee_id / gw_has_role / gw_has_app / gw_my_department / gw_is_internal_staff / is_tenant_staff
--       … 退職者には null / false を返す。ほかの権限関数（gw_is_hr・gw_is_recruiting・gw_is_sales・
--         gw_is_office・gw_is_office_finance・gw_is_keiei・gw_is_owner・gw_is_advisor）は、
--         これらの上に作ってあるので、定義はそのまま（退職者は連動して false になる）
--   gw_employees_self_guard（トリガ・新規） … 自分の行で在籍状態・退職日・所属・ログイン紐づけを変えられるのは人事だけ。
--         退職者は自分の行を書き換えられない
--
-- ■ 変えないもの
--   ・表・列・RLS のポリシー・既存の行（データは1行も変わらない）
--   ・サーバー（service_role）からの操作（auth.uid() が null のときは止めない）
--   ・退職していない人（active・退職日前の leaving）の権限
--
-- ■ 実行方法
--   1. db/check_left_gate_before.sql を流して、いまの状態を控える（読み取りだけ）
--   2. このファイルを Supabase の SQL Editor に貼って Run
--   3. db/check_left_gate_after.sql を流して、合格条件を確認する（読み取りだけ）
--   やり直し: db/rollback_120_left_gate.sql
--
-- ■ 前提: db/005（権限関数）・db/099_owner_only.sql・db/119_app_grants.sql が適用済み
-- =============================================================================

begin;

do $$
begin
  if to_regprocedure('public.gw_has_role(uuid,text)') is null then
    raise exception 'gw_has_role がありません。先に db/005_groupware_core.sql を流してください';
  end if;
  if to_regprocedure('public.gw_has_app(uuid,text)') is null then
    raise exception 'gw_has_app がありません。先に db/119_app_grants.sql を流してください';
  end if;
  if to_regprocedure('public.is_tenant_staff(uuid)') is null then
    raise exception 'is_tenant_staff がありません。先に db/schema.sql（会計側）を流してください';
  end if;
end $$;

-- 1) 退職者として扱うか（lib/left-gate.js isLeftEmployee と同じ）
create or replace function public.gw_employee_is_left(p_status text, p_left_on date)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_status = 'left'
      or (p_status = 'leaving'
          and p_left_on is not null
          and p_left_on < (now() at time zone 'Asia/Tokyo')::date)
$$;

comment on function public.gw_employee_is_left(text, date) is
  '退職者として扱うか。left、または退職日（left_on）を過ぎた leaving（日本時間の翌日 0 時から）。lib/left-gate.js と同じ';

-- 2) ログイン中の人が退職者か。名簿に行が無い人（顧問先など）は false。複数の行があるときは、すべてが退職のときだけ true
create or replace function public.gw_me_is_left()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.gw_employees e where e.user_id = auth.uid())
     and not exists (
       select 1 from public.gw_employees e
        where e.user_id = auth.uid()
          and not public.gw_employee_is_left(e.status, e.left_on))
$$;

comment on function public.gw_me_is_left() is
  'ログイン中の人が退職者か（権限の行が残っていても、退職者は権限なし）。db/120';

-- 3) 自分の社員ID。退職者は null（名簿を読む・自分の記録を引く入口を閉じる）
create or replace function public.gw_employee_id(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
    from public.gw_employees
   where tenant_id = p_tenant
     and user_id = auth.uid()
     and not public.gw_employee_is_left(status, left_on)
   limit 1
$$;

-- 4) 指定した社内ロールを持っているか。退職者は、行が残っていても false
create or replace function public.gw_has_role(p_tenant uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_role_grants g
      join public.gw_employees e on e.id = g.employee_id
     where g.tenant_id = p_tenant
       and g.role = p_role
       and e.user_id = auth.uid()
       and not public.gw_employee_is_left(e.status, e.left_on)
  )
$$;

-- 5) アプリ利用権限（hr / sales / office）の入口を持っているか。退職者は false
create or replace function public.gw_has_app(p_tenant uuid, p_app text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_app_grants g
      join public.gw_employees e on e.id = g.employee_id
     where g.tenant_id = p_tenant
       and g.app_key = p_app
       and e.user_id = auth.uid()
       and not public.gw_employee_is_left(e.status, e.left_on)
  )
$$;

-- 6) 自分の部署。退職者は null
create or replace function public.gw_my_department(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select department
    from public.gw_employees
   where tenant_id = p_tenant
     and user_id = auth.uid()
     and not public.gw_employee_is_left(status, left_on)
   limit 1
$$;

-- 7) 社内の管理側か（db/026）。退職者は false
create or replace function public.gw_is_internal_staff()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select not public.gw_me_is_left()
     and (
       exists (
         select 1 from public.memberships m
          where m.user_id = auth.uid()
            and m.role in ('admin', 'staff')
       ) or exists (
         select 1
           from public.gw_role_grants g
           join public.gw_employees  e on e.id = g.employee_id
          where e.user_id = auth.uid()
            and g.role in ('owner', 'hr', 'manager')
       )
     );
$$;

-- 8) 会計側の管理者・スタッフか。退職者は、メンバーシップが残っていても false
create or replace function public.is_tenant_staff(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships
     where user_id = auth.uid()
       and tenant_id = p_tenant
       and role in ('admin','staff')
  ) and not public.gw_me_is_left();
$$;

-- 9) 自分の行の「在籍状態・退職日・所属・ログイン紐づけ」は、人事だけが変えられる。
--    gw_employees_self_update は自分の行を何でも書き換えられるので、そのままだと
--    退職者が status を在籍に戻して、すべてを取り戻せてしまう。
--    サーバー（service_role・SQL Editor）は auth.uid() が null なので、ここでは止めない
create or replace function public.gw_employees_self_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or old.user_id is distinct from v_uid then
    return new;     -- サーバー、または他人の行（他人の行は gw_employees_hr_write が人事だけに限っている）
  end if;

  -- 退職者は、自分の行を書き換えられない
  if public.gw_employee_is_left(old.status, old.left_on) then
    raise exception 'account_left: 退職済みのため、名簿は変更できません' using errcode = '42501';
  end if;

  -- 在籍状態・退職日・所属テナント・ログインの紐づけは、人事だけ
  if (new.status is distinct from old.status
      or new.left_on is distinct from old.left_on
      or new.tenant_id is distinct from old.tenant_id
      or new.user_id is distinct from old.user_id)
     and not public.gw_is_hr(old.tenant_id) then
    raise exception 'hr_only: 在籍状態・退職日の変更は、人事・管理者だけができます' using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists gw_employees_self_guard_trg on public.gw_employees;
create trigger gw_employees_self_guard_trg
  before update on public.gw_employees
  for each row execute function public.gw_employees_self_guard();

notify pgrst, 'reload schema';

commit;
