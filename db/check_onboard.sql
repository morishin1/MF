-- =============================================================================
-- 新規メンバー登録が失敗するとき、原因を先に見る
--
-- Supabase の SQL Editor に貼って Run するだけ。何も書き換えない（読むだけ）。
-- 1行目のメールアドレスだけ、登録しようとしている人のものに書き換えてください。
--
-- ■ 無限道場は前提ではありません
--   登録が失敗する理由に「無限道場に登録されていない」は含まれません。
--   むしろ逆で、ここで登録すると無限道場（profiles）と
--   タイムカード（tc_profiles）の行は自動で作られます。
--   その2つは失敗しても登録は成立します（結果だけ画面に出ます）。
--
--   登録そのものが止まるのは、ログインアカウント（auth.users）まわりだけです。
--   このSQLは、そこを3つに分けて見ます。
-- =============================================================================

with target as (
  -- ★ ここだけ書き換える
  select lower('a_imafuku@8grp.co.jp') as email
),

-- ① そのメールのログインアカウントが、もうあるか
--    ある場合、新しく作るのではなく既存に紐づける動きになる
account as (
  select
    '① ログインアカウント' as "見るところ",
    case when u.id is null
      then '無し（新しく作られます。ここは問題になりません）'
      else '既にあります（' || u.created_at::date || ' 作成）'
    end as "状態",
    coalesce(u.id::text, '—') as "参考"
  from target t
  left join auth.users u on lower(u.email) = t.email
),

-- ② そのアカウントが、既に名簿の誰かに割り当てられていないか
--    ここが当たると user_already_assigned で止まる
assigned as (
  select
    '② 名簿への割り当て' as "見るところ",
    case when e.id is null
      then '割り当て無し（問題ありません）'
      else '★ ' || e.display_name || ' さんに割り当て済み（登録はここで止まります）'
    end as "状態",
    coalesce(e.employee_code || ' / ' || coalesce(e.email, '—'), '—') as "参考"
  from target t
  left join auth.users u on lower(u.email) = t.email
  left join public.gw_employees e on e.user_id = u.id
),

-- ③ 同じメールが、既に名簿に入っていないか
--    ここが当たると、プレビューの時点で「既に登録されています」と出る
roster as (
  select
    '③ 名簿の重複' as "見るところ",
    case when e.id is null
      then '重複無し（問題ありません）'
      else '★ ' || e.display_name || ' さんが同じメールで登録済み'
    end as "状態",
    coalesce(e.employee_code || ' / ' || e.status, '—') as "参考"
  from target t
  left join public.gw_employees e on lower(e.email) = t.email
)

select * from account
union all select * from assigned
union all select * from roster;


-- -----------------------------------------------------------------------------
-- 似た名前・似たメールで、既に名簿に入っていないかを広めに見る
-- （表記ゆれで①〜③に引っかからないことがある）
-- -----------------------------------------------------------------------------
-- select display_name, email, employee_code, status, user_id, created_at
--   from public.gw_employees
--  where display_name like '%今福%'
--     or email ilike '%imafuku%'
--  order by created_at desc;


-- -----------------------------------------------------------------------------
-- 途中まで作られて止まった人を探す
--
-- 名簿はできたのにアカウントが無い、という状態は消さずに残してあります。
-- 消すと、何がどこまでできたのか分からなくなるためです。
-- 出てきた人は、メンバー一覧からアカウントだけ作り直せます。
-- -----------------------------------------------------------------------------
-- select e.display_name, e.email, e.employee_code, e.created_at,
--        e.user_id is null                        as アカウント無し,
--        c.id is null                             as 労働条件無し,
--        g.id is null                             as 育成計画無し,
--        p.id is null                             as 入社手続き無し
--   from public.gw_employees e
--   left join public.gw_contracts   c on c.employee_id = e.id and c.status = 'active'
--   left join public.gw_growth_plans g on g.employee_id = e.id
--   left join public.gw_procedures   p on p.employee_id = e.id and p.kind = 'onboarding'
--  where e.status = 'invited'
--  order by e.created_at desc;
