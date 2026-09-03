-- 005_groupware_core.sql
-- 社内グループウェア 第1段: 社員名簿・社内ロール・操作ログの土台
--
-- ▼ 設計方針（着手前調査の決定事項に基づく）
--
--  1. 既存8テーブル（tenants / memberships / clients / accounting_credentials /
--     documents / journals / ai_questions / audit_log）は一切変更しない。追加のみ。
--
--  2. memberships.role の CHECK 制約は広げない。
--     'hr' や 'manager' を足すと is_tenant_staff()（schema.sql:211-220）、
--     lib/auth.js の canAccessClient()、api/me.js の isAdmin、
--     api/journals/approve.js の承認判定が、その新ロールを「権限なし」と解釈する。
--     エラーではなく静かに403になるため、会計機能が気づかれずに壊れる。
--     → 社内ロールは gw_role_grants に「別軸」で持つ。
--
--  3. 社内テーブルの基礎条件は user_tenant_ids() ではなく is_tenant_staff() を使う。
--     user_tenant_ids()（schema.sql:195-199）はロールを絞らないため、
--     role='client' の顧問先ユーザーにも自テナントとして見えてしまう。
--
--  4. 操作ログは既存 audit_log に相乗りさせない。
--     audit_select（schema.sql:304-306）が tenant_id in (user_tenant_ids()) のみで、
--     顧問先ユーザーからテナント全体のログが読める状態にあるため、
--     社内の機微な detail を同じ経路に乗せない。gw_activity_log に分離する。
--
--  5. 既存ポリシーは全て PERMISSIVE / TO PUBLIC。追加は必ず「可視範囲を広げる」方向に
--     しか働かないため、既存業務テーブルには一切ポリシーを足さない（新テーブルで受ける）。
--     唯一の例外は memberships への SELECT 追加で、これは意図的な加算的拡張。
--
-- 実行方法: Supabase の SQL Editor に全文を貼って実行（db/ は配信対象外）。
-- 再実行しても安全（if not exists / drop policy if exists で冪等）。


-- =============================================================================
-- 1) 社員名簿
--    グループウェア全機能の共通前提。メンション・担当者選択・既読者表示・
--    入社手続きの対象者、すべてがこのテーブルを参照する。
-- =============================================================================
create table if not exists public.gw_employees (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,

  -- 招待前の内定者も先に登録できるよう nullable。
  -- memberships.user_id は not null なので、内定者を memberships で先行作成はできない。
  -- 招待してアカウントが出来た時点で、ここに auth.users の id を書き込んで紐づける。
  user_id         uuid references auth.users(id) on delete set null,

  display_name    text not null,
  email           text,
  department      text,
  position        text,
  employment_type text check (employment_type in
                    ('正社員','契約社員','パート','アルバイト','業務委託','役員','その他')),
  joined_on       date,
  left_on         date,
  work_location   text,

  -- invited: 招待済みでまだログインしていない / active: 在籍
  -- leaving: 退職手続き中 / left: 退職済み（行は残す。過去の投稿の表示名に必要なため）
  status          text not null default 'active'
                    check (status in ('invited','active','leaving','left')),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 1ユーザーが同一テナントで二重に社員登録されないようにする。
-- user_id が null（内定者）の行は複数あってよいので部分インデックスにする。
create unique index if not exists uq_gw_employees_user
  on public.gw_employees(tenant_id, user_id) where user_id is not null;

create index if not exists idx_gw_employees_tenant
  on public.gw_employees(tenant_id, status);


-- =============================================================================
-- 2) 社内ロール
--    memberships.role（admin/staff/client）とは別軸。会計側の権限判定には影響しない。
--      owner         … 経営者。管理者と同じ画面を見る
--      hr            … 人事。社員名簿の編集・入社手続きを行う
--      manager       … 責任者。タスクのエスカレーション先
--      labor_advisor … 社労士。許可された入社手続き書類のみ
-- =============================================================================
create table if not exists public.gw_role_grants (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  role        text not null check (role in ('owner','hr','manager','labor_advisor')),
  granted_by  uuid references auth.users(id) on delete set null,
  granted_at  timestamptz not null default now(),
  unique (employee_id, role)
);

create index if not exists idx_gw_role_grants_tenant
  on public.gw_role_grants(tenant_id, role);


-- =============================================================================
-- 3) 社内の操作ログ（audit_log とは別。顧問先から読めない）
-- =============================================================================
create table if not exists public.gw_activity_log (
  id        bigserial primary key,
  ts        timestamptz not null default now(),
  tenant_id uuid,
  actor_id  uuid,          -- auth.users.id。参照先が消えてもログは残すので FK は張らない
  action    text not null,  -- 'employee.create' / 'role.grant' など
  target    text,           -- 'employee:<uuid>' 形式
  detail    jsonb
);

create index if not exists idx_gw_activity_tenant_ts
  on public.gw_activity_log(tenant_id, ts desc);


-- =============================================================================
-- 4) ヘルパ関数
--    既存の user_tenant_ids / user_client_ids / is_tenant_staff と同じ流儀で、
--    SECURITY DEFINER にして RLS の無限再帰を避ける。
-- =============================================================================

-- 自分の社員ID（このテナントで社員登録されていなければ null）
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
   limit 1
$$;

-- 指定した社内ロールを持っているか
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
  )
$$;

-- 人事権限（hr または owner）。人事情報の編集はここで判定する
create or replace function public.gw_is_hr(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'hr')
      or public.gw_has_role(p_tenant, 'owner')
$$;


-- =============================================================================
-- 5) RLS
-- =============================================================================
alter table public.gw_employees     enable row level security;
alter table public.gw_role_grants   enable row level security;
alter table public.gw_activity_log  enable row level security;

-- 社員名簿: 社内の人（admin/staff）は全員読める。
-- メンションや担当者選択に必要なので、閲覧は社内で共有する。
-- 顧問先ユーザー（role='client'）は is_tenant_staff が false なので読めない。
drop policy if exists gw_employees_select on public.gw_employees;
create policy gw_employees_select on public.gw_employees
  for select using (public.is_tenant_staff(tenant_id));

-- 本人は自分の行だけ更新できる（プロフィール編集）
drop policy if exists gw_employees_self_update on public.gw_employees;
create policy gw_employees_self_update on public.gw_employees
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 追加・削除・他人の編集は人事のみ
drop policy if exists gw_employees_hr_write on public.gw_employees;
create policy gw_employees_hr_write on public.gw_employees
  for all
  using (public.gw_is_hr(tenant_id))
  with check (public.gw_is_hr(tenant_id));

-- 社内ロール: 誰が何の権限かは社内で共有。付け外しは人事のみ
drop policy if exists gw_role_grants_select on public.gw_role_grants;
create policy gw_role_grants_select on public.gw_role_grants
  for select using (public.is_tenant_staff(tenant_id));

drop policy if exists gw_role_grants_hr_write on public.gw_role_grants;
create policy gw_role_grants_hr_write on public.gw_role_grants
  for all
  using (public.gw_is_hr(tenant_id))
  with check (public.gw_is_hr(tenant_id));

-- 操作ログ: 社内の人だけ読める。書き込みポリシーは意図的に定義しない
-- （サーバ側の service_role からのみ書く。audit_log と同じ扱い）
drop policy if exists gw_activity_select on public.gw_activity_log;
create policy gw_activity_select on public.gw_activity_log
  for select using (public.is_tenant_staff(tenant_id));


-- =============================================================================
-- 6) memberships への加算的な SELECT ポリシー
--    既存の memberships_select（user_id = auth.uid()＝自分の行のみ）は変更しない。
--    PERMISSIVE ポリシーは OR で合成されるため、これは可視範囲を広げるだけで
--    既存の挙動を壊さない。社員名簿と会計側の権限を突き合わせるために必要。
-- =============================================================================
drop policy if exists memberships_select_staff on public.memberships;
create policy memberships_select_staff on public.memberships
  for select using (public.is_tenant_staff(tenant_id));


-- =============================================================================
-- 7) 初期投入について
--    gw_employees への最初の1行は、まだ誰も hr ロールを持っていないため
--    RLS 経由では入れられない。サーバ側（service_role を使う API）から投入するか、
--    この SQL Editor で直接 insert する。
--    以下は雛形（実行するなら値を埋めてコメントを外す）。
--
--    with t as (select id from public.tenants limit 1),
--         u as (select id from auth.users where email = 'ここに管理者のメール' limit 1)
--    insert into public.gw_employees (tenant_id, user_id, display_name, email, status)
--    select t.id, u.id, 'ここに氏名', 'ここに管理者のメール', 'active' from t, u
--    on conflict do nothing;
--
--    -- 続けて、その社員に owner と hr を付与する
--    insert into public.gw_role_grants (tenant_id, employee_id, role)
--    select e.tenant_id, e.id, r.role
--      from public.gw_employees e
--      cross join (values ('owner'),('hr')) as r(role)
--     where e.email = 'ここに管理者のメール'
--    on conflict do nothing;
-- =============================================================================
