-- =============================================================================
-- 123: 退職手続きを1画面で進めるための記録（退職日の編集・貸与品の返却・サービス別アカウント・手続きの履歴）
--
-- ■ 何をするか（121・122 は書き換えない。足すだけ）
--   1) gw_retire_cases に 最終出勤日（last_work_on）・担当者（owner_employee_id）を足す
--        退職日の正は、社員名簿の gw_employees.left_on のまま（ここには持たない）
--   2) gw_retire_events      … 退職手続きの操作の記録（追記専用）。退職日の変更（変更前→変更後）・返却の確認・
--                               アカウント停止の確認など。監査ログ（gw_activity_log）の保存期間に左右されない業務の記録
--   3) gw_retire_asset_returns … この退職で何を返してもらうか・返したか。貸与品台帳（gw_assets）は複製しない
--                               （返却で台帳の貸出先が外れても、次の人へ貸し出されても、ここで分かるように
--                                 名前・管理番号だけ控える）
--   4) gw_retire_accounts    … 自動で止められないサービス（Google Workspace・Slack・GitHub・Vercel）の、担当者による記録
--                               （利用中／停止予定／停止済／対象外）。グループウェア・無限道場・タイムカード・会計は、
--                               それぞれの表から状態を読む（ここには持たない）
--   5) gw_retire_set_dates() … 退職日・最終出勤日・担当者を、ほかの担当者の更新を上書きせずに（更新日時の突き合わせ）
--                               1回で保存し、変更前→変更後を記録する。在籍状態（status）とアカウントには触れない
--
-- ■ 権限
--   4つの表は RLS 有効・読み取りだけ・人事（gw_is_hr）。書き込みのポリシーは置かない（API が service role で書く）。
--   gw_retire_set_dates は service role だけが呼べる（一般のユーザーからは呼べない）。
--
-- ■ 適用の順番
--   121（gw_retire_cases）→ 122 → この 123 → アプリのデプロイ。
--   デプロイが先でも、退職手続きの新しい部分だけ「SQL を流してください」と出て、ほかの画面は止まらない。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 005（gw_employees・gw_is_hr）・011（gw_assets）・121（gw_retire_cases）
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_retire_cases') is null then
    raise exception 'gw_retire_cases がありません。先に db/121_retire_docs.sql を流してください';
  end if;
  if to_regclass('public.gw_assets') is null then
    raise exception 'gw_assets がありません。先に db/011_assets_templates.sql を流してください';
  end if;
  if to_regprocedure('public.gw_is_hr(uuid)') is null then
    raise exception 'gw_is_hr がありません。先に db/005_groupware_core.sql を流してください';
  end if;
end $$;

-- 1) 退職手続きの基本情報（退職日は gw_employees.left_on が正）
alter table public.gw_retire_cases
  add column if not exists last_work_on      date,
  add column if not exists owner_employee_id uuid references public.gw_employees(id) on delete set null;

comment on column public.gw_retire_cases.last_work_on is '最終出勤日。退職日（gw_employees.left_on）より後にはできない（API と gw_retire_set_dates が止める）';
comment on column public.gw_retire_cases.owner_employee_id is '退職手続きの担当者（社員）';

-- 2) 退職手続きの操作の記録（追記専用）
create table if not exists public.gw_retire_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,
  kind         text not null check (kind in (
                 'dates.update',      -- 退職日・最終出勤日・担当者の変更（detail に変更前→変更後）
                 'asset.request',     -- 返却を依頼した（返却予定日）
                 'asset.return',      -- 返却を確認した（台帳の貸出先を外した）
                 'account.update'     -- サービスの状態を担当者が記録した（停止予定・停止済・対象外・利用中）
               )),
  detail       jsonb not null default '{}'::jsonb,
  actor_id     uuid references auth.users(id) on delete set null,
  actor_name   text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_gw_retire_events_emp on public.gw_retire_events(tenant_id, employee_id, created_at desc);

comment on table public.gw_retire_events is
  '退職手続きの操作の記録（追記専用。消さない・書き換えない）。detail に本文・URL・退職理由のメモは入れない。db/123';

-- 3) 貸与品の返却（この退職で、何を返してもらうか・返したか）
create table if not exists public.gw_retire_asset_returns (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,
  asset_id      uuid references public.gw_assets(id) on delete set null,
  -- 台帳の行が消えても・名前が変わっても、何を返したか分かるように控える（台帳そのものは複製しない）
  asset_kind    text not null check (asset_kind in ('pc', 'phone', 'account', 'key', 'other')),
  asset_name    text not null,
  asset_identifier text,
  state         text not null check (state in ('requested', 'returned')),
  requested_at  timestamptz,
  due_on        date,
  returned_at   timestamptz,
  returned_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint gw_retire_asset_returns_returned_needs_time check (state <> 'returned' or returned_at is not null)
);

-- 1つの貸与品は、1人の退職につき1行
create unique index if not exists uq_gw_retire_asset_returns_asset
  on public.gw_retire_asset_returns(employee_id, asset_id) where asset_id is not null;
create index if not exists idx_gw_retire_asset_returns_emp on public.gw_retire_asset_returns(tenant_id, employee_id);

comment on table public.gw_retire_asset_returns is
  '退職者の貸与品の返却（依頼・返却予定日・返却確認）。在庫の状態は gw_assets.status が正。db/123';

-- 4) 自動で止められないサービスの、担当者による記録
create table if not exists public.gw_retire_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,
  service       text not null check (service in ('google', 'slack', 'github', 'vercel')),
  state         text not null check (state in ('active', 'scheduled', 'stopped', 'not_applicable')),
  scheduled_on  date,                                  -- 停止予定日（担当者が手で止める予定）
  stopped_at    timestamptz,                           -- 担当者が「止めた」と記録した日時（外部サービスの停止の証明ではない）
  stopped_by    uuid references auth.users(id) on delete set null,
  note          text,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (employee_id, service),
  constraint gw_retire_accounts_stopped_needs_time check (state <> 'stopped' or stopped_at is not null)
);

create index if not exists idx_gw_retire_accounts_tenant on public.gw_retire_accounts(tenant_id, employee_id);

comment on table public.gw_retire_accounts is
  '自動で止められないサービス（Google Workspace・Slack・GitHub・Vercel）を、担当者が止めた・止める予定・対象外と記録する。db/123';

-- RLS：読み取りだけ・人事。書き込みは API（service role）だけ
alter table public.gw_retire_events        enable row level security;
alter table public.gw_retire_asset_returns enable row level security;
alter table public.gw_retire_accounts      enable row level security;

drop policy if exists gw_retire_events_select on public.gw_retire_events;
create policy gw_retire_events_select on public.gw_retire_events
  for select using (public.gw_is_hr(tenant_id));
drop policy if exists gw_retire_asset_returns_select on public.gw_retire_asset_returns;
create policy gw_retire_asset_returns_select on public.gw_retire_asset_returns
  for select using (public.gw_is_hr(tenant_id));
drop policy if exists gw_retire_accounts_select on public.gw_retire_accounts;
create policy gw_retire_accounts_select on public.gw_retire_accounts
  for select using (public.gw_is_hr(tenant_id));

-- 5) 退職日・最終出勤日・担当者を、競合を見ながら1回で保存する
--    p_expect_emp  … 画面が読んだときの gw_employees.updated_at（違えば、ほかの担当者が先に更新した）
--    p_expect_case … 画面が読んだときの gw_retire_cases.updated_at（行が無かったときは null）
--    在籍状態（status）・アカウントには触れない。入退社の手続き（gw_procedures）の退社日と、未完了の項目の期限も合わせる
--    （お知らせは送らない。知らせ直すのは画面の［もう一度知らせる］）
create or replace function public.gw_retire_set_dates(
  p_tenant uuid, p_employee uuid, p_actor uuid, p_actor_name text,
  p_left_on date, p_last_work_on date, p_owner uuid,
  p_expect_emp timestamptz, p_expect_case timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e   public.gw_employees%rowtype;
  c   public.gw_retire_cases%rowtype;
  now_ts timestamptz := now();
begin
  select * into e from public.gw_employees where id = p_employee and tenant_id = p_tenant for update;
  if not found then
    raise exception 'retire_not_found' using errcode = 'P0002';
  end if;
  select * into c from public.gw_retire_cases where employee_id = p_employee and tenant_id = p_tenant for update;

  -- 競合：画面が読んだ後に、誰かが名簿か退職手続きを更新していた
  if e.updated_at is distinct from p_expect_emp
     or (c.id is not null and c.updated_at is distinct from p_expect_case)
     or (c.id is null and p_expect_case is not null) then
    raise exception 'retire_conflict' using errcode = 'P0001';
  end if;

  if p_last_work_on is not null and p_left_on is not null and p_last_work_on > p_left_on then
    raise exception 'retire_last_after_left' using errcode = '22023';
  end if;
  if p_owner is not null and not exists (
    select 1 from public.gw_employees where id = p_owner and tenant_id = p_tenant
  ) then
    raise exception 'retire_bad_owner' using errcode = '22023';
  end if;

  update public.gw_employees set left_on = p_left_on, updated_at = now_ts
   where id = p_employee and tenant_id = p_tenant;

  insert into public.gw_retire_cases (tenant_id, employee_id, last_work_on, owner_employee_id, updated_by, updated_at)
  values (p_tenant, p_employee, p_last_work_on, p_owner, p_actor, now_ts)
  on conflict (employee_id) do update
    set last_work_on = excluded.last_work_on, owner_employee_id = excluded.owner_employee_id,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  -- 入退社の手続きの退社日と、未完了の項目の期限を合わせる（済んだ項目の記録は変えない）
  if p_left_on is not null and to_regclass('public.gw_procedures') is not null then
    update public.gw_procedures set target_on = p_left_on, updated_at = now_ts
     where tenant_id = p_tenant and employee_id = p_employee and kind = 'offboarding'
       and target_on is distinct from p_left_on;
    update public.gw_procedure_items i set due_on = p_left_on
      from public.gw_procedures p
     where i.procedure_id = p.id and p.tenant_id = p_tenant and p.employee_id = p_employee
       and p.kind = 'offboarding' and i.status in ('todo', 'submitted');
  end if;

  insert into public.gw_retire_events (tenant_id, employee_id, kind, detail, actor_id, actor_name, created_at)
  values (p_tenant, p_employee, 'dates.update', jsonb_build_object(
    'leftOn',     jsonb_build_object('from', e.left_on, 'to', p_left_on),
    'lastWorkOn', jsonb_build_object('from', c.last_work_on, 'to', p_last_work_on),
    'owner',      jsonb_build_object('from', c.owner_employee_id, 'to', p_owner)
  ), p_actor, p_actor_name, now_ts);

  return jsonb_build_object('employeeUpdatedAt', now_ts, 'caseUpdatedAt', now_ts);
end $$;

revoke all on function public.gw_retire_set_dates(uuid, uuid, uuid, text, date, date, uuid, timestamptz, timestamptz) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.gw_retire_set_dates(uuid, uuid, uuid, text, date, date, uuid, timestamptz, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.gw_retire_set_dates(uuid, uuid, uuid, text, date, date, uuid, timestamptz, timestamptz) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.gw_retire_set_dates(uuid, uuid, uuid, text, date, date, uuid, timestamptz, timestamptz) to service_role;
  end if;
end $$;

comment on function public.gw_retire_set_dates(uuid, uuid, uuid, text, date, date, uuid, timestamptz, timestamptz) is
  '退職日（gw_employees.left_on）・最終出勤日・担当者を、更新日時を突き合わせて保存し、変更前→変更後を gw_retire_events に残す。'
  'status・アカウントは変えない。service role だけ。db/123';

notify pgrst, 'reload schema';

commit;

-- 確認1（適用後）: 3つの表のポリシーが「読み取りだけ・人事」か（3行・cmd はすべて SELECT）
--
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public' and tablename in ('gw_retire_events', 'gw_retire_asset_returns', 'gw_retire_accounts')
--    order by tablename;
--
-- 確認2（適用後）: 足した列と関数（2行と1行）
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'gw_retire_cases' and column_name in ('last_work_on', 'owner_employee_id');
--   select to_regprocedure('public.gw_retire_set_dates(uuid, uuid, uuid, text, date, date, uuid, timestamptz, timestamptz)');
--
-- 戻す（データごと消える。本番で流す前に必ず確認）:
--   drop function if exists public.gw_retire_set_dates(uuid, uuid, uuid, text, date, date, uuid, timestamptz, timestamptz);
--   drop table if exists public.gw_retire_accounts, public.gw_retire_asset_returns, public.gw_retire_events;
--   alter table public.gw_retire_cases drop column if exists owner_employee_id, drop column if exists last_work_on;
