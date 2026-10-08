-- =============================================================================
-- 中村さんの日報：ログインメールを正本にした直接診断
--
-- 読み取り専用（SELECT のみ）。本番データを書き換えません。
-- 対象メール: s_nakamura@8grp.co.jp
--
-- 見たいこと:
--   1) auth.users にこのメールのアカウントがあるか
--   2) gw_employees がその auth.users.id に紐づいているか
--   3) そのアカウントで直近30日に tc_nippo が保存されているか
--   4) AI評価がどの日報に付いているか
--   5) 社員名簿の user_id と日報の user_id が一致しているか
-- =============================================================================

with p as (
  select 's_nakamura@8grp.co.jp'::text as email
),
acc as (
  select
    u.id as user_id,
    u.email,
    u.created_at,
    u.last_sign_in_at,
    coalesce(
      u.raw_user_meta_data->>'full_name',
      u.raw_user_meta_data->>'name',
      ''
    ) as display_name
  from auth.users u, p
  where lower(u.email) = lower(p.email)
),
emp as (
  select
    e.id as employee_id,
    e.tenant_id,
    e.user_id,
    e.display_name,
    e.email,
    e.status
  from public.gw_employees e, p
  where lower(coalesce(e.email, '')) = lower(p.email)
     or e.user_id in (select user_id from acc)
),
nip as (
  select
    n.id as nippo_id,
    n.user_id,
    n.user_name,
    n.work_date,
    n.submitted_at,
    n.updated_at
  from public.tc_nippo n
  where n.user_id in (select user_id from acc)
    and n.work_date >= current_date - 30
),
ev as (
  select
    v.id as eval_id,
    v.nippo_id,
    v.user_id,
    v.work_date,
    v.status,
    v.created_at
  from public.gw_nippo_ai_evals v
  where v.nippo_id in (select nippo_id from nip)
     or (v.user_id in (select user_id from acc)
         and v.work_date >= current_date - 30)
),
out as (
  select
    'A アカウント'::text as 区分,
    coalesce(a.email, '') as 名前,
    a.user_id::text as user_id,
    coalesce(a.display_name, '') as 状態,
    '✅ auth.users に存在'::text as 判定,
    '最終ログイン ' || coalesce(a.last_sign_in_at::text, '（なし）') as 詳細1,
    '作成 ' || a.created_at::text as 詳細2
  from acc a

  union all

  select
    'B 社員名簿',
    e.display_name,
    coalesce(e.user_id::text, '（空）'),
    e.status,
    case
      when e.user_id in (select user_id from acc) and e.status in ('active','leaving')
        then '✅ ログインアカウントと社員名簿が一致'
      when e.user_id in (select user_id from acc)
        then '⚠ user_id は一致するが status が active/leaving でない'
      when lower(coalesce(e.email,'')) = lower((select email from p))
        then '⚠ メールは一致するが user_id がログインアカウントと違う'
      else '⚠ 不一致'
    end,
    coalesce(e.email, ''),
    'employee ' || e.employee_id::text || ' / tenant ' || e.tenant_id::text
  from emp e

  union all

  select
    'C 日報',
    n.user_name,
    n.user_id::text,
    n.work_date::text,
    case
      when exists (
        select 1 from emp e
        where e.user_id = n.user_id
          and e.status in ('active','leaving')
      ) then '✅ 社員名簿と一致'
      else '⚠ この日報user_idは有効な社員名簿に一致しない'
    end,
    '提出 ' || coalesce(n.submitted_at::text, '（submitted_at空）'),
    'nippo ' || n.nippo_id::text
  from nip n

  union all

  select
    'D AI評価',
    '',
    v.user_id::text,
    v.work_date::text,
    v.status,
    '作成 ' || v.created_at::text,
    'nippo ' || v.nippo_id::text
  from ev v

  union all

  select
    'E 判定',
    '1 auth.users にメールがあるか',
    '',
    (select count(*) from acc)::text || ' 件',
    case when (select count(*) from acc) = 1 then '✅ 1件'
         when (select count(*) from acc) = 0 then '⚠ アカウントなし'
         else '⚠ 同じメールで複数件' end,
    '',
    ''

  union all

  select
    'E 判定',
    '2 gw_employees に該当者がいるか',
    '',
    (select count(*) from emp)::text || ' 件',
    case when (select count(*) from emp) = 1 then '✅ 1件'
         when (select count(*) from emp) = 0 then '⚠ 社員名簿に該当なし'
         else '⚠ 複数の社員レコードあり' end,
    '',
    ''

  union all

  select
    'E 判定',
    '3 auth.users.id = gw_employees.user_id か',
    '',
    (select count(*) from emp e where e.user_id in (select user_id from acc))::text || ' 件一致',
    case when exists (select 1 from emp e where e.user_id in (select user_id from acc))
         then '✅ 一致あり'
         else '⚠ 一致なし' end,
    '',
    ''

  union all

  select
    'E 判定',
    '4 直近30日に日報があるか',
    '',
    (select count(*) from nip)::text || ' 件',
    case when exists (select 1 from nip) then '✅ あり' else '⚠ なし' end,
    '',
    ''

  union all

  select
    'E 判定',
    '5 AI評価があるか',
    '',
    (select count(*) from ev)::text || ' 件',
    case when exists (select 1 from ev) then '✅ あり' else '⚠ なし' end,
    '',
    ''

  union all

  select
    'E 判定',
    '6 日報user_idが有効社員名簿と一致するか',
    '',
    (select count(*) from nip n
      where exists (
        select 1 from emp e
        where e.user_id = n.user_id
          and e.status in ('active','leaving')
      ))::text || ' / ' || (select count(*) from nip)::text || ' 件一致',
    case
      when not exists (select 1 from nip) then '— 日報なし'
      when exists (
        select 1 from nip n
        where not exists (
          select 1 from emp e
          where e.user_id = n.user_id
            and e.status in ('active','leaving')
        )
      ) then '⚠ 不一致の日報あり'
      else '✅ 全件一致'
    end,
    '',
    ''
)
select *
from out
order by 区分, 状態, 名前;
