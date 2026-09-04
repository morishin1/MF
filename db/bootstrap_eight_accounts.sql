-- =============================================================================
-- bootstrap_eight_accounts.sql — 株式会社エイトの初期アカウント設定
--
-- これはマイグレーションではなく、初期データの投入スクリプトです。
-- Supabase の SQL Editor にそのまま貼って実行してください。
-- 何度実行しても同じ結果になります（重複は作りません）。
--
-- 前提:
--   - db/000_install_fresh.sql（または schema〜007）が適用済み
--   - auth.users に zimu@8grp.co.jp と s_morita@gw.8grp.co.jp が存在する
--     ※ 既存アカウントのパスワードはこのスクリプトでは一切変更しません
--
-- 作るもの:
--   テナント「株式会社エイト」／取引先「エイト」
--   zimu@8grp.co.jp        … 管理者（staff）
--   s_morita@gw.8grp.co.jp … 管理者（staff）＋ 社内ロール owner / hr
--   両者の社員名簿（gw_employees）
--
-- メンバー用のデモアカウントは【手順B】を参照してください。
-- =============================================================================


-- 【手順A】ここから ---------------------------------------------------------

-- 1) テナント
insert into public.tenants (name)
select '株式会社エイト'
where not exists (select 1 from public.tenants where name = '株式会社エイト');

-- 2) 取引先（会計書類のアップロード先）
insert into public.clients (tenant_id, name, accounting_software)
select t.id, 'エイト', 'mf'
  from public.tenants t
 where t.name = '株式会社エイト'
   and not exists (
     select 1 from public.clients c
      where c.tenant_id = t.id and c.name = 'エイト');

-- 3) 管理者のメンバーシップ（会計側の権限）
insert into public.memberships (user_id, tenant_id, role)
select u.id, t.id, 'staff'
  from auth.users u
 cross join public.tenants t
 where t.name = '株式会社エイト'
   and lower(u.email) in ('zimu@8grp.co.jp', 's_morita@gw.8grp.co.jp')
   and not exists (
     select 1 from public.memberships m
      where m.user_id = u.id and m.tenant_id = t.id and m.role = 'staff');

-- 4) 社員名簿（グループウェア側）
insert into public.gw_employees (tenant_id, user_id, display_name, email, status)
select t.id,
       u.id,
       case lower(u.email)
         when 'zimu@8grp.co.jp' then '事務'
         else '森田'
       end,
       u.email,
       'active'
  from auth.users u
 cross join public.tenants t
 where t.name = '株式会社エイト'
   and lower(u.email) in ('zimu@8grp.co.jp', 's_morita@gw.8grp.co.jp')
   and not exists (
     select 1 from public.gw_employees e
      where e.tenant_id = t.id and e.user_id = u.id);

-- 5) 社内ロール（森田さんを経営者・人事に）
insert into public.gw_role_grants (tenant_id, employee_id, role)
select e.tenant_id, e.id, r.role
  from public.gw_employees e
 cross join (values ('owner'), ('hr')) as r(role)
 where lower(e.email) = 's_morita@gw.8grp.co.jp'
on conflict (employee_id, role) do nothing;

-- 6) 確認
select u.email,
       m.role                        as 会計権限,
       e.display_name                as 表示名,
       coalesce(
         string_agg(g.role, ', ' order by g.role),
         '(なし)'
       )                             as 社内ロール
  from auth.users u
  join public.memberships m   on m.user_id = u.id
  join public.tenants t       on t.id = m.tenant_id and t.name = '株式会社エイト'
  left join public.gw_employees e   on e.tenant_id = t.id and e.user_id = u.id
  left join public.gw_role_grants g on g.employee_id = e.id
 group by u.email, m.role, e.display_name
 order by u.email;

-- 【手順A】ここまで ---------------------------------------------------------


-- =============================================================================
-- 【手順B】メンバー用のデモアカウント
--
--   SQL からは Auth ユーザーを作れないので、先にダッシュボードで作成します。
--
--   1. Supabase → Authentication → Users → "Add user" → "Create new user"
--   2. Email: demo@8grp.co.jp
--      Password: 任意（チャットには貼らないでください）
--      "Auto Confirm User" を ON
--   3. 作成したら、以下のコメントを外して実行
--
--   ※ demo@8grp.co.jp は lms に存在しないので、他システムに影響しません。
-- =============================================================================

-- insert into public.memberships (user_id, tenant_id, role, client_id)
-- select u.id, c.tenant_id, 'client', c.id
--   from auth.users u
--  cross join public.clients c
--  where lower(u.email) = 'demo@8grp.co.jp'
--    and c.name = 'エイト'
--    and not exists (
--      select 1 from public.memberships m
--       where m.user_id = u.id and m.tenant_id = c.tenant_id and m.role = 'client');
--
-- insert into public.gw_employees (tenant_id, user_id, display_name, email, department, status)
-- select c.tenant_id, u.id, 'デモ メンバー', u.email, '管理部', 'active'
--   from auth.users u
--  cross join public.clients c
--  where lower(u.email) = 'demo@8grp.co.jp'
--    and c.name = 'エイト'
--    and not exists (
--      select 1 from public.gw_employees e
--       where e.tenant_id = c.tenant_id and e.user_id = u.id);
