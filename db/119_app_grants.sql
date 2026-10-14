-- =============================================================================
-- 119: アプリ利用権限（gw_app_grants）— 「どのアプリへ入れるか」と「アプリの中で何ができるか」を分ける
--
-- ■ 何のためか
--   これまで、採用HR・Sales・Office に入れるかどうかは、内部ロール（gw_role_grants: owner / hr / manager / finance …）の
--   並びで決まっていた。ロールが「入口」と「中でできること」を兼ねていたため、メンバー一覧に8個のチェックが並び、
--   「採用HRを OFF にしたいのに、hr や manager を持っていて入れてしまう」ことが起きた。
--   この SQL は、入口だけを持つ表を作る。メンバー一覧は 採用HR / Sales / Office / 経営 の4ボタンだけになる。
--
-- ■ 保存するもの
--   app_key = 'hr'（採用HR）/ 'sales'（Sales）/ 'office'（Office）の3つだけ。
--   経営（/keiei）は経営者（owner）から導出し、この表には保存しない。owner は4つとも使える（行を作らない）。
--
-- ■ 意味（lib/gw.js と同じ）
--   入口  hr = owner または app_key='hr'       sales = owner または app_key='sales'
--         office = owner または 会計の管理者 または app_key='office'
--   中身  月末月初 = 入口(office) かつ (owner | manager | finance)
--         人事・労務 = 会計の管理者 | owner | (入口(office) かつ hr)
--         経理・事務 = 会計の管理者 | owner | (入口(office) かつ finance)
--   Office を ON にしただけでは、人事・労務・経理・事務・月末月初のどれも使えない。内部ロールが決める。
--
-- ■ 既存ユーザーの移行（この SQL の最後の INSERT）。いまの実効権限を変えない。内部ロールは1行も変えない・消さない。
--     manager   → hr, sales, office     hr → hr, office     recruiter → hr     sales → sales     finance → office
--     owner・it・labor_advisor・会計の管理者 → 行を作らない
--   hr の人に「月末月初」は付かない（月末月初は owner / manager / finance だけ）。
--
-- ■ 先に流すもの・流したあと
--   1. db/check_app_grants_dryrun.sql を流して、差分が 0 行であることを確かめる（読み取りだけ）。
--   2. この SQL（119）を流す。
--   3. db/check_app_grants_after.sql を流して、差分が 0 行であることを確かめる。
--   4. そのあとで、アプリをデプロイする（この SQL より先にデプロイしない。ただし、表が無い間は
--      アプリが内部ロールから同じ結果を出すので、順序を間違えても権限は変わらない）。
--   この SQL は、どの RLS・判定関数（gw_is_hr / gw_is_recruiting / gw_is_sales / gw_is_office …）も変えない。
--   DB 側の判定をアプリ利用権限に切り替えるのは、別の SQL（次の PR）。
--
-- ■ 元に戻す
--   drop function if exists public.gw_has_app(uuid, text);
--   drop table if exists public.gw_app_grants;
--   （内部ロールは変えていないので、戻しても元の権限のまま）
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等。2回流しても同じ）
-- 前提: db/005（gw_role_grants・gw_employee_id・gw_is_hr）・memberships・tenants
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_employees') is null or to_regclass('public.gw_role_grants') is null then
    raise exception 'gw_employees / gw_role_grants がありません。先に db/005_groupware_core.sql を流してください';
  end if;
  if to_regprocedure('public.gw_is_hr(uuid)') is null or to_regprocedure('public.is_tenant_staff(uuid)') is null
     or to_regprocedure('public.gw_employee_id(uuid)') is null then
    raise exception 'gw_is_hr / is_tenant_staff / gw_employee_id がありません。先に db/005_groupware_core.sql を流してください';
  end if;
end $$;

-- 1) 表
create table if not exists public.gw_app_grants (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  app_key     text not null check (app_key in ('hr', 'sales', 'office')),
  granted_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (employee_id, app_key)
);

create index if not exists idx_gw_app_grants_tenant on public.gw_app_grants(tenant_id, app_key);

comment on table public.gw_app_grants is
  'アプリ利用権限（どのアプリへ入れるか）。hr=採用HR / sales=Sales / office=Office。経営は owner から導出するので保存しない。'
  'アプリの中で何ができるかは、内部ロール（gw_role_grants）が決める（db/119）';
comment on column public.gw_app_grants.granted_by is '付けた人（auth.users）。移行で入れた行は null';

-- 2) 自分がそのアプリの入口を持っているか（gw_has_role と同じ作り。在籍状態では絞らない）
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
  )
$$;

comment on function public.gw_has_app(uuid, text) is
  '自分が、そのアプリ（hr / sales / office）の入口を持っているか。owner・会計の管理者の暗黙の入口は含まない（呼ぶ側で足す）';

-- 3) RLS：読めるのは、社内の管理者・自分の行・人事。付け外しは人事（gw_role_grants と同じ考え方）
alter table public.gw_app_grants enable row level security;

drop policy if exists gw_app_grants_select on public.gw_app_grants;
create policy gw_app_grants_select on public.gw_app_grants
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_app_grants_hr_write on public.gw_app_grants;
create policy gw_app_grants_hr_write on public.gw_app_grants
  for all
  using (public.gw_is_hr(tenant_id))
  with check (public.gw_is_hr(tenant_id));

-- 4) 既存ユーザーの移行（いまの実効権限と同じになるように。べき等）
insert into public.gw_app_grants (tenant_id, employee_id, app_key, granted_by)
select distinct g.tenant_id, g.employee_id, x.app_key, null::uuid
  from public.gw_role_grants g
  join (values
    ('manager',   'hr'),    ('manager', 'sales'), ('manager', 'office'),
    ('hr',        'hr'),    ('hr',      'office'),
    ('recruiter', 'hr'),
    ('sales',     'sales'),
    ('finance',   'office')
  ) as x(role, app_key) on x.role = g.role
on conflict (employee_id, app_key) do nothing;

notify pgrst, 'reload schema';

commit;
