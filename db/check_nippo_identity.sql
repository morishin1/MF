-- =============================================================================
-- 日報の「本人は提出済み・AIフィードバックも出た・なのに管理側は未提出」の突き合わせ
--
-- ■ 読み取りだけ（SELECT だけ。UPDATE / INSERT / DELETE / RPC / DDL は入っていない）。何も書き換えない。
-- ■ 使い方：Supabase の SQL Editor に全文を貼り、下の「p」の3つだけ変えて Run。1つの表で結果が出る。
--     name_like  … 対象者の氏名の一部（例 '%山田%'）。社員名簿・日報の名前・アカウントの表示名を探す
--     email_like … 対象者のメールの一部（分からなければ '' のまま）
--     d          … 管理画面で「未提出」に見えた日（JST の日付）
--
-- ■ 管理画面（api/nippo/admin.js）が「提出済み」と数える条件（ここが真実の元）
--     auth.users.id → gw_employees.user_id → tc_nippo.user_id の完全一致。
--     名簿に載るのは gw_employees.status が active / leaving で、user_id が空でない人だけ。
--
-- ■ 結果の読み方（区分の順に並ぶ）
--     A 名簿          … 対象者の gw_employees（user_id が空か・在籍状態が active/leaving か）
--     B 日報          … 対象日の tc_nippo（誰の user_id で保存されたか）
--     C AI評価        … 対象日の gw_nippo_ai_evals（どの日報・どの user_id に付いたか）
--     D アカウント    … 同じ人物と思われるログインアカウント（auth.users）。見つけ方つき
--     E 判定          … 上の突き合わせの結論（✅ / ⚠）
--     F 30日の紐づかない日報 … 直近30日に、管理側の名簿（active/leaving）に紐づかない user_id の日報（同じ症状の人がほかにいないか）
-- =============================================================================
with p as (
  select '%山田%'::text   as name_like,    -- ← 対象者の氏名の一部
         ''::text         as email_like,   -- ← 対象者のメールの一部（任意。例 '%yamada%'）
         date '2026-10-08' as d            -- ← 管理画面で未提出に見えた日（JST）
),
-- A. 社員名簿（氏名 or メールで探す）
emp as (
  select e.id, e.tenant_id, e.user_id, e.display_name, e.status, e.email
    from public.gw_employees e, p
   where e.display_name ilike p.name_like
      or (p.email_like <> '' and e.email ilike p.email_like)
),
-- 直近30日に、同じ名前で日報を書いた user_id（別アカウントで書いていないか）
nip_names as (
  select distinct n.user_id
    from public.tc_nippo n, p
   where n.work_date between p.d - 30 and p.d + 1
     and n.user_name ilike p.name_like
),
-- D. 同じ人物と思われるログインアカウント（4通りの見つけ方）
acc_hit as (
  select u.id, '名簿に紐づけ済み' as how from auth.users u where u.id in (select user_id from emp where user_id is not null)
  union all
  select u.id, '名簿のメールと同じ' from auth.users u
   where exists (select 1 from emp where emp.email is not null and lower(emp.email) = lower(u.email))
  union all
  select u.id, 'メールが一致' from auth.users u, p
   where p.email_like <> '' and u.email ilike p.email_like
  union all
  select u.id, 'アカウントの表示名が一致' from auth.users u, p
   where coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '') ilike p.name_like
  union all
  select u.id, '同じ名前で日報を書いた' from auth.users u where u.id in (select user_id from nip_names)
),
acc as (
  select u.id, u.email, u.created_at, u.last_sign_in_at,
         string_agg(distinct h.how, ' / ') as how
    from acc_hit h join auth.users u on u.id = h.id
   group by u.id, u.email, u.created_at, u.last_sign_in_at
),
-- B. 対象日の日報（名前が一致 / 名簿の user_id / 上のアカウントのどれか）
nip as (
  select n.id, n.user_id, n.user_name, n.work_date, n.submitted_at
    from public.tc_nippo n, p
   where n.work_date = p.d
     and (n.user_name ilike p.name_like
          or n.user_id in (select user_id from emp where user_id is not null)
          or n.user_id in (select id from acc))
),
-- C. 対象日の AI評価（その日報に付いたもの + 同じ人物のアカウントに付いたもの）
ev as (
  select v.nippo_id, v.user_id, v.work_date, v.status, v.created_at
    from public.gw_nippo_ai_evals v, p
   where v.nippo_id in (select id from nip)
      or (v.work_date = p.d and v.user_id in (select id from acc))
),
-- 管理側の名簿に載る user_id（全テナント。管理画面はさらに自分のテナントだけに絞る）
roster as (
  select distinct e.user_id from public.gw_employees e
   where e.user_id is not null and e.status in ('active', 'leaving')
),
-- F. 直近30日の、管理側の名簿に紐づかない日報
orphan as (
  select n.user_id, max(n.user_name) as user_name, count(*) as cnt, max(n.work_date) as last_date
    from public.tc_nippo n
   where n.work_date >= current_date - 30
     and (n.user_id is null or n.user_id not in (select user_id from roster))
   group by n.user_id
),
out as (
  -- A 名簿
  select 'A 名簿' as 区分, e.display_name as 名前,
         coalesce(e.user_id::text, '（空）') as user_id,
         e.status as 状態,
         case when e.user_id is null then '⚠ user_id が空（ログインアカウント未紐づけ。管理側の名簿に出ない）'
              when e.status not in ('active', 'leaving') then '⚠ 在籍状態が active/leaving でない（管理側の名簿に出ない）'
              else '✅ 管理側の名簿に出る（active/leaving・user_id あり）' end as 判定,
         coalesce(e.email, '') as 詳細1,
         'tenant ' || e.tenant_id::text || ' / employee ' || e.id::text as 詳細2
    from emp e
  union all
  -- B 日報
  select 'B 日報', n.user_name, coalesce(n.user_id::text, '（空）'), n.work_date::text,
         case when exists (select 1 from emp where emp.user_id = n.user_id and emp.status in ('active', 'leaving'))
                then '✅ 名簿の user_id と一致'
              when exists (select 1 from emp where emp.user_id = n.user_id)
                then '⚠ 名簿の user_id と一致するが、在籍状態が active/leaving でない'
              when exists (select 1 from public.gw_employees x where x.user_id = n.user_id)
                then '⚠ 別の社員の user_id（' || (select string_agg(x.display_name || ':' || x.status, ', ') from public.gw_employees x where x.user_id = n.user_id) || '）'
              else '⚠ どの社員名簿にも紐づかない user_id' end,
         '提出 ' || coalesce(n.submitted_at::text, '（未提出）'),
         'nippo ' || n.id::text
    from nip n
  union all
  -- C AI評価
  select 'C AI評価', '', v.user_id::text, v.work_date::text,
         v.status || case when v.user_id in (select user_id from emp where user_id is not null) then '（名簿の user_id）' else '（名簿と違う user_id）' end,
         '作成 ' || v.created_at::text,
         'nippo ' || v.nippo_id::text
    from ev v
  union all
  -- D アカウント
  select 'D アカウント', coalesce(a.email, ''), a.id::text,
         coalesce((select string_agg(x.display_name || ':' || x.status, ', ') from public.gw_employees x where x.user_id = a.id), '（どの社員にも紐づいていない）'),
         a.how,
         '最終ログイン ' || coalesce(a.last_sign_in_at::text, '（なし）'),
         '作成 ' || a.created_at::text
    from acc a
  union all
  -- E 判定
  select 'E 判定', '1 名簿に該当者がいるか', '', (select count(*) from emp)::text || ' 人',
         case (select count(*) from emp) when 0 then '⚠ 名簿に該当者なし（氏名の一部を見直す）'
              when 1 then '✅ 1人' else '⚠ 複数（同姓・二重登録の可能性。A を見る）' end, '', ''
  union all
  select 'E 判定', '2 名簿の user_id が空でないか', '', (select count(*) from emp where user_id is null)::text || ' 件が空',
         case when exists (select 1 from emp where user_id is null) then '⚠ user_id が空の行あり（管理側の名簿に出ない）' else '✅ 空なし' end, '', ''
  union all
  select 'E 判定', '3 在籍状態が active / leaving か', '',
         coalesce((select string_agg(distinct status, ', ') from emp), ''),
         case when exists (select 1 from emp where status not in ('active', 'leaving')) then '⚠ active/leaving 以外あり（管理側の名簿に出ない）' else '✅ active/leaving のみ' end, '', ''
  union all
  select 'E 判定', '4 対象日の日報があるか', '', (select count(*) from nip)::text || ' 件',
         case when exists (select 1 from nip) then '✅ 保存されている' else '⚠ 対象日の日報が見つからない（日付・名前を見直す）' end, '', ''
  union all
  select 'E 判定', '5 tc_nippo.user_id = gw_employees.user_id か', '',
         (select count(*) from nip where user_id in (select user_id from emp where user_id is not null and status in ('active', 'leaving')))::text
           || ' / ' || (select count(*) from nip)::text || ' 件が一致',
         case when not exists (select 1 from nip) then '—（日報なし）'
              when exists (select 1 from nip where user_id is null or user_id not in (select user_id from emp where user_id is not null and status in ('active', 'leaving')))
                then '⚠ 一致しない日報あり（B の判定を見る）' else '✅ すべて一致' end, '', ''
  union all
  select 'E 判定', '6 同じ人物に複数ログインアカウントが無いか', '', (select count(*) from acc)::text || ' 個',
         case when (select count(*) from acc) > 1 then '⚠ 複数あり（D を見る。名簿に紐づいていない方で日報を書いていないか）'
              when (select count(*) from acc) = 1 then '✅ 1個' else '⚠ 見つからない' end, '', ''
  union all
  select 'E 判定', '7 対象日の日報の総数（管理画面「今日の日報」は300件まで）', '',
         (select count(*) from public.tc_nippo n, p where n.work_date = p.d)::text || ' 件',
         case when (select count(*) from public.tc_nippo n, p where n.work_date = p.d) > 300 then '⚠ 300件超（一覧から漏れうる）' else '✅ 300件以内' end, '', ''
  union all
  select 'E 判定', '8 直近30日に名簿に紐づかない日報', '', (select count(*) from orphan)::text || ' 人分',
         case when exists (select 1 from orphan) then '⚠ あり（F を見る）' else '✅ なし' end, '', ''
  union all
  -- F 30日の紐づかない日報
  select 'F 30日の紐づかない日報', o.user_name, coalesce(o.user_id::text, '（空）'),
         o.cnt::text || ' 件',
         case when o.user_id is null then '⚠ user_id が空の日報'
              when exists (select 1 from public.gw_employees x where x.user_id = o.user_id)
                then '⚠ 名簿にあるが在籍状態が対象外（' || (select string_agg(x.display_name || ':' || x.status, ', ') from public.gw_employees x where x.user_id = o.user_id) || '）'
              else '⚠ どの社員名簿にも紐づかない' end,
         '最終 ' || o.last_date::text,
         coalesce((select u.email from auth.users u where u.id = o.user_id), '（アカウントなし）')
    from orphan o
)
select * from out order by 区分, 名前, 状態;
