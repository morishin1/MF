-- =============================================================================
-- 給与が保存されている場所と、その食い違いを見る（読み取りだけ）
--
-- Supabase の SQL Editor に貼って Run するだけ。何も書き換えない。移行の前に、まずこれを流す。
-- 結果は「区分 / 項目 / 状態 / 詳細」の一覧。表が無い環境でもエラーにならず「表なし」と出る。
-- ※ 詳細に、社員の氏名が出る（金額は出さない）。結果は、経営者だけで扱ってください。
--
-- ■ 何のための確認か  docs/keiei-pay-management.md
--   経営（/keiei）を給与の正式な管理場所にするにあたり、いまの給与が「どこに・どんな形で」あるかを確かめる。
--   ここで見つけた食い違いは、自動では直さない。/keiei の給与管理で、経営者が1人ずつ確認して記録する。
--
-- ■ 見方
--   ✅ … 問題なし   ⚠ … 確認が要る   ℹ … 参考（件数）   （表なし）… その表がまだ無い（未適用）
--   区分 A … 給与が入っている場所と件数（db/105 の前でも見られる）
--   区分 B … 給与管理（gw_compensations）と、既存の表との食い違い（db/105 を流した後に意味が出る）
--   区分 C … 給与の所在の一覧（どれを正とするか）
-- =============================================================================

with
-- 在籍している人（退職済みを除く）
emp as (
  select id, tenant_id, display_name from public.gw_employees where status <> 'left'
),
-- 表・列があるか
has as (
  select
    to_regclass('public.gw_contracts')       is not null as contracts,
    to_regclass('public.gw_onboard_profiles') is not null as profiles,
    to_regclass('public.gw_hr_applicants')   is not null as applicants,
    to_regclass('public.gw_hr_offers')       is not null as offers,
    to_regclass('public.gw_hr_pay')          is not null as hr_pay,
    to_regclass('public.gw_compensations')   is not null as comp,
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gw_hr_applicants'
             and column_name = 'employee_id') as applicant_link
),

-- ---- A. 給与が入っている場所と件数 ---------------------------------------------
a(seq, item, n, names, note) as (
  select 1, '契約（有効）で賃金が入っている',
         case when h.contracts then (xpath('/row/v/text()', query_to_xml(
           $q$select count(*) as v from public.gw_contracts where status = 'active' and wage_amount is not null$q$, false, true, '')))[1]::text::int end,
         null::text, '契約上の賃金（wage_type / wage_amount）。署名した書面が言っていること'
    from has h
  union all
  select 2, '有効な契約が2件以上ある社員（どの賃金が現在か曖昧）',
         case when h.contracts then (xpath('/row/n/text()', query_to_xml(
           $q$select count(*) as n from (select employee_id from public.gw_contracts where status = 'active' group by employee_id having count(*) > 1) x$q$, false, true, '')))[1]::text::int end,
         case when h.contracts then (xpath('/row/v/text()', query_to_xml(
           $q$select coalesce(string_agg(e.display_name, '、' order by e.display_name), '') as v
                from (select employee_id from public.gw_contracts where status = 'active' group by employee_id having count(*) > 1) c
                join public.gw_employees e on e.id = c.employee_id$q$, false, true, '')))[1]::text end,
         '取り込みのとき、どの契約を元にするか、1人ずつ確認が要る'
    from has h
  union all
  select 3, '契約の賃金の種別が 月給/年俸/時給/日給 以外（その他・空）で、金額がある',
         case when h.contracts then (xpath('/row/n/text()', query_to_xml(
           $q$select count(*) as n from public.gw_contracts where status = 'active' and wage_amount is not null
                 and coalesce(wage_type, '') not in ('月給', '年俸', '時給', '日給')$q$, false, true, '')))[1]::text::int end,
         case when h.contracts then (xpath('/row/v/text()', query_to_xml(
           $q$select coalesce(string_agg(distinct e.display_name, '、'), '') as v
                from public.gw_contracts c join public.gw_employees e on e.id = c.employee_id
               where c.status = 'active' and c.wage_amount is not null and coalesce(c.wage_type, '') not in ('月給', '年俸', '時給', '日給')$q$, false, true, '')))[1]::text end,
         '給与管理へ取り込めない（種別を経営者が選び直して入力する）'
    from has h
  union all
  select 4, '契約の「手当・控除など」（wage_note）に文章がある',
         case when h.contracts then (xpath('/row/v/text()', query_to_xml(
           $q$select count(*) as v from public.gw_contracts where status = 'active' and btrim(coalesce(wage_note, '')) <> ''$q$, false, true, '')))[1]::text::int end,
         null::text, '手当の金額は文章の中にしかない。給与管理には、手当を金額つきで入力し直す（自動では読み取らない）'
    from has h
  union all
  select 5, '入社情報の届出に「1か月の定期代」（commute_cost）が入っている',
         case when h.profiles then (xpath('/row/v/text()', query_to_xml(
           $q$select count(*) as v from public.gw_onboard_profiles where commute_cost is not null$q$, false, true, '')))[1]::text::int end,
         null::text, '本人が届け出た金額（参考）。会社が決めた通勤手当ではない'
    from has h
  union all
  select 6, '応募者の元の列の給与（分離後は 0 になる）',
         case when h.applicants then (xpath('/row/v/text()', query_to_xml(
           $q$select count(*) as v from public.gw_hr_applicants where wage_type is not null or wage_amount is not null$q$, false, true, '')))[1]::text::int end,
         null::text, '内定前の条件。db/100・101 のあと、gw_hr_pay へ移る'
    from has h
  union all
  select 7, '合格通知の元の列の給与（分離後は 0 になる）',
         case when h.offers then (xpath('/row/v/text()', query_to_xml(
           $q$select count(*) as v from public.gw_hr_offers where wage_type is not null or wage_amount is not null$q$, false, true, '')))[1]::text::int end,
         null::text, '内定前の条件'
    from has h
  union all
  select 8, '内定の給与専用の表（gw_hr_pay）の行数',
         case when h.hr_pay then (xpath('/row/v/text()', query_to_xml($q$select count(*) as v from public.gw_hr_pay$q$, false, true, '')))[1]::text::int end,
         null::text, 'db/100 のあと。入社前の条件で、社員の給与の正ではない'
    from has h
  union all
  select 9, '給与管理（gw_compensations）の行数',
         case when h.comp then (xpath('/row/v/text()', query_to_xml($q$select count(*) as v from public.gw_compensations$q$, false, true, '')))[1]::text::int end,
         null::text, 'db/105 のあと。現在の給与額の正'
    from has h
  union all
  select 10, '給与管理に、現在の記録がある社員の数',
         case when h.comp then (xpath('/row/v/text()', query_to_xml(
           $q$select count(distinct employee_id) as v from public.gw_compensations where effective_from <= (now() at time zone 'Asia/Tokyo')::date$q$, false, true, '')))[1]::text::int end,
         null::text, ''
    from has h
),

-- ---- B. 給与管理と既存の表の食い違い（db/105 のあと）-----------------------------
-- 社員ごとの、いまの給与管理（適用開始日が今日以前で、いちばん新しい行の、最新の版）と、有効な契約（いちばん新しい1件）
b_src as (
  select 1 as seq, '在籍者で、契約に賃金があるのに、給与管理に記録がない' as item,
         case when h.comp and h.contracts then $q$
           select coalesce(string_agg(e.display_name, '、' order by e.display_name), '') as v, count(*) as n
             from public.gw_employees e
            where e.status <> 'left'
              and exists (select 1 from public.gw_contracts c where c.employee_id = e.id and c.status = 'active' and c.wage_amount is not null)
              and not exists (select 1 from public.gw_compensations p where p.employee_id = e.id
                                 and p.effective_from <= (now() at time zone 'Asia/Tokyo')::date)$q$ end as sql,
         '給与管理へ、契約の賃金を取り込む（経営者が1人ずつ確認して記録）' as note
    from has h
  union all
  select 2, '給与管理の現在の基本給が、契約の賃金と違う（種別または金額）',
         case when h.comp and h.contracts then $q$
           select coalesce(string_agg(x.display_name, '、' order by x.display_name), '') as v, count(*) as n
             from (
               select e.display_name, cur.wage_type as cw, cur.base_amount as cb, c.wage_type as kw, c.wage_amount as ka
                 from public.gw_employees e
                 join lateral (
                   select p.wage_type, p.base_amount from public.gw_compensations p
                    where p.employee_id = e.id and p.effective_from <= (now() at time zone 'Asia/Tokyo')::date
                    order by p.effective_from desc, p.revision desc limit 1) cur on true
                 join lateral (
                   select k.wage_type, k.wage_amount from public.gw_contracts k
                    where k.employee_id = e.id and k.status = 'active' and k.wage_amount is not null
                    order by k.created_at desc limit 1) c on true
                where e.status <> 'left') x
            where x.cw is distinct from x.kw or x.cb is distinct from x.ka$q$ end,
         '契約の書面と、実際の給与が違う（給与CSVの「基本給」は契約から出るので、CSVとも違う）。契約を更新するか、給与の記録を訂正するか、経営者が判断する'
    from has h
  union all
  select 3, '給与管理の通勤手当が、本人が届け出た定期代と違う',
         case when h.comp and h.profiles then $q$
           select coalesce(string_agg(x.display_name, '、' order by x.display_name), '') as v, count(*) as n
             from (
               select e.display_name, cur.commute_amount as ca, pr.commute_cost as pc
                 from public.gw_employees e
                 join lateral (
                   select p.commute_amount from public.gw_compensations p
                    where p.employee_id = e.id and p.effective_from <= (now() at time zone 'Asia/Tokyo')::date
                    order by p.effective_from desc, p.revision desc limit 1) cur on true
                 join public.gw_onboard_profiles pr on pr.employee_id = e.id
                where e.status <> 'left' and pr.commute_cost is not null) x
            where x.ca is distinct from x.pc$q$ end,
         '会社が決めた通勤手当と、本人の申告が違う（給与CSVの「通勤手当」は申告から出るので、CSVとも違う。上限・非課税枠・定額支給などで違うことは普通にある）'
    from has h
  union all
  select 4, '給与管理に、適用開始日が未来の記録だけがある（まだ適用されていない）',
         case when h.comp then $q$
           select coalesce(string_agg(e.display_name, '、' order by e.display_name), '') as v, count(*) as n
             from public.gw_employees e
            where e.status <> 'left'
              and exists (select 1 from public.gw_compensations p where p.employee_id = e.id)
              and not exists (select 1 from public.gw_compensations p where p.employee_id = e.id
                                 and p.effective_from <= (now() at time zone 'Asia/Tokyo')::date)$q$ end,
         '入社前の人の給与なら想定どおり'
    from has h
),
b(seq, item, n, names, note) as (
  select seq + 20, item,
         case when sql is null then null else (xpath('/row/n/text()', query_to_xml(sql, false, true, '')))[1]::text::int end,
         case when sql is null then null else (xpath('/row/v/text()', query_to_xml(sql, false, true, '')))[1]::text end,
         note
    from b_src
),

-- ---- C. 給与の所在（どれを正とするか）-------------------------------------------
c(seq, item, state, detail) as (values
  (41, '現在の給与額（基本給・手当・通勤手当）', '正: gw_compensations（給与管理）', '適用開始日つきの履歴。追記だけ。/keiei だけが書く'),
  (42, '契約上の賃金', '参照: gw_contracts / 署名済みPDF', '書面が言っていること。記録のたびに写しを残し、食い違いを見せる。/keiei は契約へ書かない'),
  (43, '内定時の給与', '参照: gw_hr_pay（入社前）', '自動では移さない。入社時に、経営者が確認して取り込む'),
  (44, '本人が届け出た定期代', '参照: gw_onboard_profiles.commute_cost', '会社が決めた通勤手当ではない'),
  (45, '労働条件通知書の「賃金」欄・署名済みPDF', '参照: gw_doc_orders / gw_sign_requests', '文字列。過去の書面は不変の証跡'),
  (46, '給与CSV（MF給与の取込用）', '出力: lib/payroll-csv.js', 'いまは契約を読む。給与の段階2のとき、給与管理を読む形に切り替える（別工程）'),
  (47, '昇給レンジ・昇給の判断（キャリア）', '別: gw_career_levels / gw_career_reviews', '目安と判断の記録。給与額の正ではない'),
  (48, 'PP・BPの現場単価（unit_price）', '対象外: gw_site_contracts', '給与管理に混ぜない。意味が確定するまで変更しない')
)

select "区分", "項目", "状態", "詳細" from (
  select a.seq, 'A. 給与が入っている場所' as "区分", a.item as "項目",
         case when a.n is null then '（表なし）' else 'ℹ ' || a.n::text || ' 件' end as "状態",
         coalesce(nullif(a.names, ''), '') || case when nullif(a.names, '') is not null and a.note <> '' then ' ／ ' else '' end || a.note as "詳細"
    from a
  union all
  select b.seq, 'B. 給与管理との食い違い（db/105 のあと）', b.item,
         case when b.n is null then '（給与管理の表なし）' when b.n = 0 then '✅ 0 件' else '⚠ ' || b.n::text || ' 件' end,
         coalesce(nullif(b.names, ''), '') || case when nullif(b.names, '') is not null and b.note <> '' then ' ／ ' else '' end || b.note
    from b
  union all
  select c.seq, 'C. 給与の所在（正・参照）', c.item, c.state, c.detail from c
) all_rows
order by seq;
