-- =============================================================================
-- 【移行の前に流す・読み取りだけ】アプリ利用権限（db/119）を入れたとき、誰の実効権限が変わるか
--
-- ■ 何を比べるか（人ごと）
--   「いまの式」＝ 内部ロール（gw_role_grants）と会計の管理者（memberships の admin/staff）から出した実効権限
--   「移行後の式」＝ db/119 が付けるアプリ利用権限（下の app_* ）と内部ロールから出した実効権限
--   どちらも lib/gw.js の判定と同じ条件。比べる項目:
--     採用HR / Sales / 月末月初（Office の月次業務） / 人事・労務 / 経理・事務 / 経営 / 人事の管理権限（canManageHr の土台）/ 管理部への問い合わせ
--
-- ■ 合格条件
--   ① の「差分」が 0 行。1行でも出たら、db/119 を流さない（権限が増える人・減る人がいるということ）。
--   ② の件数は、移行で付くアプリ利用権限の人数。③ は人ごとの一覧（内部ロール → 付くアプリ）。
--
-- ■ 書き込みはしない（create も insert もない）。何度流してもよい。Supabase の SQL Editor に貼って Run。
--   個人名が出る。画面や共有の場に貼らない（人数と「差分 0 行」だけを報告する）。
-- =============================================================================

-- ① 差分（0 行が合格）---------------------------------------------------------
with roles as (
  select employee_id, array_agg(role) as rs from public.gw_role_grants group by employee_id
), emp as (
  select e.id as employee_id, e.display_name, e.status,
         coalesce(r.rs, '{}'::text[]) as rs,
         exists (select 1 from public.memberships m
                  where m.user_id = e.user_id and m.tenant_id = e.tenant_id and m.role in ('admin', 'staff')) as is_admin
    from public.gw_employees e left join roles r on r.employee_id = e.id
), f as (
  select employee_id, display_name, status, is_admin,
         ('owner' = any(rs)) as o, ('manager' = any(rs)) as m, ('hr' = any(rs)) as h,
         ('finance' = any(rs)) as fin, ('recruiter' = any(rs)) as rec, ('sales' = any(rs)) as sal
    from emp
), calc as (
  select *,
         -- 移行で付くアプリ利用権限（db/119 の INSERT と同じ規則）
         (m or h or rec) as app_hr,
         (m or sal)      as app_sales,
         (m or h or fin) as app_office
    from f
), cmp as (
  select employee_id, display_name, status, is_admin,
         -- いまの式
         (o or m or h or rec)        as old_recruit,
         (o or m or sal)             as old_sell,
         (o or m or fin)             as old_monthly,
         (is_admin or o or h)        as old_office_hr,
         (is_admin or o or fin)      as old_office_finance,
         o                           as old_keiei,
         (is_admin or o or h)        as old_manage_hr,
         ((is_admin or o or h) or (o or m or fin)) as old_ai_inquiries,
         -- 移行後の式（owner は暗黙で全部。会計の管理者は Office の入口が暗黙）
         (o or app_hr)               as new_recruit,
         (o or app_sales)            as new_sell,
         ((o or is_admin or app_office) and (o or m or fin)) as new_monthly,
         (is_admin or o or (app_office and h))   as new_office_hr,
         (is_admin or o or (app_office and fin)) as new_office_finance,
         o                           as new_keiei,
         (is_admin or o or (app_office and h))   as new_manage_hr,
         ((is_admin or o or (app_office and h)) or ((o or is_admin or app_office) and (o or m or fin))) as new_ai_inquiries
    from calc
)
select display_name as 名前, status as 在籍,
       case when old_recruit        <> new_recruit        then '採用HR '        else '' end
    || case when old_sell           <> new_sell           then 'Sales '         else '' end
    || case when old_monthly        <> new_monthly        then '月末月初 '      else '' end
    || case when old_office_hr      <> new_office_hr      then '人事・労務 '    else '' end
    || case when old_office_finance <> new_office_finance then '経理・事務 '    else '' end
    || case when old_keiei          <> new_keiei          then '経営 '          else '' end
    || case when old_manage_hr      <> new_manage_hr      then '人事の管理権限 ' else '' end
    || case when old_ai_inquiries   <> new_ai_inquiries   then '管理部への問い合わせ' else '' end as 変わる項目
  from cmp
 where (old_recruit, old_sell, old_monthly, old_office_hr, old_office_finance, old_keiei, old_manage_hr, old_ai_inquiries)
    is distinct from
       (new_recruit, new_sell, new_monthly, new_office_hr, new_office_finance, new_keiei, new_manage_hr, new_ai_inquiries)
 order by 1;

-- ② 移行で付くアプリ利用権限の人数 -------------------------------------------
with roles as (
  select employee_id, array_agg(role) as rs from public.gw_role_grants group by employee_id
), a as (
  select coalesce(r.rs, '{}'::text[]) as rs from public.gw_employees e left join roles r on r.employee_id = e.id
)
select count(*)                                                                      as 社員数,
       count(*) filter (where 'manager' = any(rs) or 'hr' = any(rs) or 'recruiter' = any(rs)) as 付く_採用HR,
       count(*) filter (where 'manager' = any(rs) or 'sales' = any(rs))                       as 付く_Sales,
       count(*) filter (where 'manager' = any(rs) or 'hr' = any(rs) or 'finance' = any(rs))   as 付く_Office,
       count(*) filter (where 'owner' = any(rs))                                              as 経営者_暗黙で全部
  from a;

-- ③ 人ごとの一覧（内部ロール → 付くアプリ）。個人名が出る -----------------------
select e.display_name as 名前, e.status as 在籍,
       coalesce(string_agg(g.role, ', ' order by g.role), '（なし）') as 内部ロール,
       (bool_or(g.role = 'owner'))                                                         as 経営者,
       (bool_or(g.role in ('manager', 'hr', 'recruiter')))                                 as 付く_採用HR,
       (bool_or(g.role in ('manager', 'sales')))                                           as 付く_Sales,
       (bool_or(g.role in ('manager', 'hr', 'finance')))                                   as 付く_Office,
       exists (select 1 from public.memberships m
                where m.user_id = e.user_id and m.tenant_id = e.tenant_id and m.role in ('admin', 'staff')) as 会計の管理者
  from public.gw_employees e
  left join public.gw_role_grants g on g.employee_id = e.id
 group by e.id, e.display_name, e.status, e.user_id, e.tenant_id
 order by 経営者 desc nulls last, 2, 1;
