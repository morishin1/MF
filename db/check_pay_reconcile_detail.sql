-- =============================================================================
-- 給与の突き合わせ（金額つき・社員ごと）— 経営者（owner）だけで使う。読み取りだけ
--
-- Supabase の SQL Editor に貼って Run するだけ。何も書き換えない。
-- ※ このSQLの結果には、実際の給与金額が出る。画面共有・スクリーンショット・貼り付けに注意し、
--    経営者以外に渡さない。ふだんの確認は db/check_pay_reconcile.sql（金額なし）で足りる。
--    金額を見ないと判断できない社員について、必要なときだけ使う。
--
-- ■ 出るもの（1人1行。BP・退職者は除く。入社準備中は含む）
--   氏名・在籍状態
--   契約: 種別・金額・注記の有無・有効な契約の件数（いちばん新しい1件を見る）
--   内定の給与（gw_hr_pay）: 種別・金額（オファー単位を優先）
--   本人の届出の定期代
--   給与管理（いま適用中の記録）: 適用開始日・種別・基本給・手当の合計・通勤手当
--   判定: 未登録 / 適用前のみ / 一致 / 基本給が契約と違う / 通勤手当が届出と違う
--
-- ■ 表が無いとき
--   契約・入社情報・内定の給与・給与管理のどれかが無ければ、その列は空になる（エラーにならない）。
-- =============================================================================

with
has as (
  select
    to_regclass('public.gw_contracts')        is not null as contracts,
    to_regclass('public.gw_onboard_profiles') is not null as profiles,
    to_regclass('public.gw_hr_applicants')    is not null and to_regclass('public.gw_hr_pay') is not null as hr_pay,
    to_regclass('public.gw_compensations')    is not null as comp,
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gw_hr_applicants'
             and column_name = 'employee_id') as applicant_link,
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gw_employees'
             and column_name = 'employee_kind') as emp_kind
),
q as (
  select
    $s$select e.display_name as name, e.status as status,
              c.wage_type as c_type, c.wage_amount as c_amount, case when c.has_note then 'あり' end as c_note, c.n as c_count,
              o.wage_type as o_type, o.wage_amount as o_amount,
              pr.commute_cost as declared,
              cur.effective_from as p_from, cur.wage_type as p_type, cur.base_amount as p_base,
              cur.allowance_total as p_allow, cur.commute_amount as p_commute,
              case
                when cur.effective_from is null and rec.n > 0 then '適用前のみ'
                when cur.effective_from is null then '未登録'
                else coalesce(nullif(concat_ws('・',
                       case when c.wage_amount is not null and (cur.wage_type is distinct from c.wage_type or cur.base_amount is distinct from c.wage_amount)
                            then '基本給が契約と違う' end,
                       case when cur.commute_amount is distinct from pr.commute_cost then '通勤手当が届出と違う' end), ''), '一致')
              end as verdict
         from public.gw_employees e $s$
    -- 契約（いちばん新しい有効な1件）
    || case when h.contracts then
         $s$left join lateral (select k.wage_type, k.wage_amount, (btrim(coalesce(k.wage_note, '')) <> '') as has_note,
                                     (select count(*) from public.gw_contracts z where z.employee_id = e.id and z.status = 'active') as n
                                from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                               order by k.created_at desc limit 1) c on true $s$
       else $s$left join (select null::text as wage_type, null::numeric as wage_amount, null::boolean as has_note, null::bigint as n where false) c on false $s$ end
    -- 内定の給与（gw_hr_pay。オファー単位を優先）
    || case when h.hr_pay and h.applicant_link then
         $s$left join public.gw_hr_applicants a on a.employee_id = e.id
            left join lateral (select p.wage_type, p.wage_amount from public.gw_hr_pay p where p.applicant_id = a.id
                                order by (p.offer_id is not null) desc, p.updated_at desc limit 1) o on true $s$
       else $s$left join (select null::text as wage_type, null::numeric as wage_amount where false) o on false $s$ end
    -- 本人の届出の定期代
    || case when h.profiles then
         $s$left join public.gw_onboard_profiles pr on pr.employee_id = e.id $s$
       else $s$left join (select null::numeric as commute_cost where false) pr on false $s$ end
    -- 給与管理（いま適用中の記録と、記録の件数）
    || case when h.comp then
         $s$left join lateral (select p.effective_from, p.wage_type, p.base_amount, p.commute_amount,
                                      (select coalesce(sum((al ->> 'amount')::numeric), 0) from jsonb_array_elements(p.allowances) al) as allowance_total
                                 from public.gw_compensations p
                                where p.employee_id = e.id and p.effective_from <= (now() at time zone 'Asia/Tokyo')::date
                                order by p.effective_from desc, p.revision desc limit 1) cur on true
            left join lateral (select count(*) as n from public.gw_compensations p where p.employee_id = e.id) rec on true $s$
       else $s$left join (select null::date as effective_from, null::text as wage_type, null::numeric as base_amount, null::numeric as commute_amount,
                                 null::numeric as allowance_total where false) cur on false
              left join (select 0::bigint as n) rec on true $s$ end
    || $s$ where e.status <> 'left'$s$
    || case when h.emp_kind then $s$ and e.employee_kind is distinct from 'bp'$s$ else '' end
    || $s$ order by e.display_name$s$ as sql
  from has h
)
select x."氏名", x."在籍状態",
       x."契約の種別", x."契約の金額", x."契約の注記", x."有効な契約の件数",
       x."内定の給与の種別", x."内定の給与の金額",
       x."届出の定期代",
       x."給与管理の適用開始日", x."給与管理の種別", x."給与管理の基本給", x."給与管理の手当の合計", x."給与管理の通勤手当",
       x."判定"
  from q,
       xmltable('/table/row' passing query_to_xml(q.sql, false, false, '') columns
         "氏名" text path 'name',
         "在籍状態" text path 'status',
         "契約の種別" text path 'c_type',
         "契約の金額" numeric path 'c_amount',
         "契約の注記" text path 'c_note',
         "有効な契約の件数" int path 'c_count',
         "内定の給与の種別" text path 'o_type',
         "内定の給与の金額" numeric path 'o_amount',
         "届出の定期代" numeric path 'declared',
         "給与管理の適用開始日" text path 'p_from',
         "給与管理の種別" text path 'p_type',
         "給与管理の基本給" numeric path 'p_base',
         "給与管理の手当の合計" numeric path 'p_allow',
         "給与管理の通勤手当" numeric path 'p_commute',
         "判定" text path 'verdict') x
 order by x."氏名";
