-- =============================================================================
-- 126: 権限の付け外しの固定ルールと、給与の決定（キャリアの給与）を経営者だけに（DB 側）
--      2026-10-07 グループウェア：メニュー整理・権限分担
--
-- ■ なぜ要るか
--   画面と API（lib/role-change.js・api/employees/apps.js・api/career/index.js）では止めている。
--   ただし DB の行のポリシーが「人事なら owner 以外の全部を書ける／キャリアの表を全部読める」のままだと、
--   ブラウザに渡している公開キーと本人のトークンで、DB を直接たたくと回避できる。ここで DB も同じ規則にそろえる。
--
-- ■ 変えること（3つ。どれもポリシーの差し替えだけ。表・列・行は変えない）
--   1) gw_role_grants の書き込み（gw_role_grants_hr_write）
--        経営者 … これまでどおり全部（owner の規則・最後の owner のトリガは db/099 のまま）
--        経営者でない人事・管理者 … 通常の業務の権限（hr / finance / manager / recruiter / sales）だけ。
--                                   it（IT・管理）・labor_advisor（社労士）・owner は付け外しできない。
--                                   自分自身の行は付け外しできない（自分の権限を広げられない）
--   2) gw_app_grants の書き込み（gw_app_grants_hr_write）
--        経営者 … 全部 ／ 経営者でない人事・管理者 … 自分自身の行は付け外しできない
--   3) gw_career_levels・gw_career_reviews の読み取り（給与レンジ・給与メモ・昇給の判断の列がある）
--        人事 → 経営者だけ。画面（api/career）は service_role で読むので、人事の画面は変わらない。
--        行のポリシーでは列を隠せないため、表ごと経営者だけにする
--
-- ■ 前提
--   db/005（gw_is_hr・gw_employee_id）・db/099（gw_is_owner）・db/092（キャリア）・db/119（gw_app_grants）
--
-- ■ 流し方
--   Supabase の SQL Editor に全文を貼って Run。何度流しても同じ結果（べき等）。
--
-- ■ 確認（流したあと）
--   確認1: 3つの表のポリシー（4行。すべて gw_is_owner を含む）
--     select c.relname as 表, p.polname as ポリシー,
--            pg_get_expr(p.polqual, p.polrelid) ilike '%gw_is_owner%' as 経営者の条件あり
--       from pg_policy p join pg_class c on c.oid = p.polrelid
--      where p.polname in ('gw_role_grants_hr_write', 'gw_app_grants_hr_write',
--                          'gw_career_levels_read', 'gw_career_reviews_read')
--      order by 1, 2;
--     → 4行、経営者の条件あり がすべて true
--   確認2: 付け外しの規則（関数が1つ）
--     select proname from pg_proc where proname = 'gw_can_grant_role';   -- 1行
--
-- ■ 元に戻す（必要なときだけ。db/099・db/119・db/092 のときのポリシーに戻す）
--   drop policy if exists gw_role_grants_hr_write on public.gw_role_grants;
--   create policy gw_role_grants_hr_write on public.gw_role_grants for all
--     using (public.gw_is_hr(tenant_id) and (role <> 'owner' or public.gw_is_owner(tenant_id)))
--     with check (public.gw_is_hr(tenant_id) and (role <> 'owner' or public.gw_is_owner(tenant_id)));
--   drop policy if exists gw_app_grants_hr_write on public.gw_app_grants;
--   create policy gw_app_grants_hr_write on public.gw_app_grants for all
--     using (public.gw_is_hr(tenant_id)) with check (public.gw_is_hr(tenant_id));
--   drop policy if exists gw_career_levels_read on public.gw_career_levels;
--   create policy gw_career_levels_read on public.gw_career_levels for select to authenticated using (public.gw_is_hr(tenant_id));
--   drop policy if exists gw_career_reviews_read on public.gw_career_reviews;
--   create policy gw_career_reviews_read on public.gw_career_reviews for select to authenticated using (public.gw_is_hr(tenant_id));
--   drop function if exists public.gw_can_grant_role(uuid, uuid, text);
-- =============================================================================

begin;

-- 付け外ししてよいか（lib/role-change.js の grantRuleError と同じ規則）。
--   p_role が null … アプリ利用権限（gw_app_grants）。自分の行かどうかだけを見る
create or replace function public.gw_can_grant_role(p_tenant uuid, p_employee uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_is_hr(p_tenant)
     and (
       public.gw_is_owner(p_tenant)
       or (
         p_employee is distinct from public.gw_employee_id(p_tenant)
         and (p_role is null or p_role in ('hr', 'finance', 'manager', 'recruiter', 'sales'))
       )
     )
$$;

comment on function public.gw_can_grant_role(uuid, uuid, text) is
  '権限の付け外しの固定ルール（db/126）。経営者は全部。経営者でない人事・管理者は、通常の業務の権限'
  '（hr / finance / manager / recruiter / sales）とアプリだけ、自分自身の行は不可。lib/role-change.js grantRuleError と同じ。';

-- 1) 内部ロール
drop policy if exists gw_role_grants_hr_write on public.gw_role_grants;
create policy gw_role_grants_hr_write on public.gw_role_grants
  for all
  using (public.gw_can_grant_role(tenant_id, employee_id, role))
  with check (public.gw_can_grant_role(tenant_id, employee_id, role));

-- 2) アプリ利用権限
drop policy if exists gw_app_grants_hr_write on public.gw_app_grants;
create policy gw_app_grants_hr_write on public.gw_app_grants
  for all
  using (public.gw_can_grant_role(tenant_id, employee_id, null))
  with check (public.gw_can_grant_role(tenant_id, employee_id, null));

-- 3) キャリアの給与（給与レンジ・給与メモ・昇給の判断）がある表は、経営者だけが直接読める
drop policy if exists gw_career_levels_read on public.gw_career_levels;
create policy gw_career_levels_read on public.gw_career_levels
  for select to authenticated using (public.gw_is_owner(tenant_id));
drop policy if exists gw_career_reviews_read on public.gw_career_reviews;
create policy gw_career_reviews_read on public.gw_career_reviews
  for select to authenticated using (public.gw_is_owner(tenant_id));

commit;

notify pgrst, 'reload schema';
