-- =============================================================================
-- 給与が保存されている場所と、その食い違いを見る（読み取りだけ・金額は出さない）
--
-- Supabase の SQL Editor に貼って Run するだけ。何も書き換えない。移行・切り替えの前に、まずこれを流す。
-- 結果は「区分 / 項目 / 状態 / 詳細」の一覧。表が無い環境でもエラーにならず「（表なし）」と出る。
--
-- ■ 金額は出さない
--   詳細に出るのは、社員の氏名と、状態・不一致の理由（「種別が違う」「金額が違う」など）だけ。
--   実際の金額を見て判断したいときだけ、別の SQL（db/check_pay_reconcile_detail.sql。経営者だけで扱う）を使う。
--   ※ 氏名は出る。結果は、経営者だけで扱ってください。
--
-- ■ 何のための確認か  docs/keiei-pay-management.md
--   経営（/keiei）を給与の正式な管理場所にするにあたり、いまの給与が「どこに・どんな形で」あるかを確かめる。
--   ここで見つけた食い違いは、自動では直さない。/keiei の給与管理で、経営者が1人ずつ確認して記録する。
--   給与の段階2・給与CSVの読み先の切り替えの前に、区分 B が「✅ 0 件」になっていること（docs §12）。
--
-- ■ 対象の社員
--   「対象社員」＝在籍中と退職手続き中（active・leaving）。BP（外部パートナー）・退職者・入社準備中は含めない
--   （入社準備中とBPは、人数だけ別に出す）。
--
-- ■ 見方
--   ✅ … 問題なし   ⚠ … 確認が要る   ℹ … 参考（件数）   （表なし）… その表がまだ無い（未適用）
--   区分 A … 社員数と、給与の参照元の有無（db/105 の前でも見られる）
--   区分 B … 各データ間の不一致と、給与管理の未登録（db/105 を流した後に意味が出る）
--   区分 C … 給与の所在の一覧（どれを正とするか）
--
-- ■ 給与CSV（lib/payroll-csv.js）が読むもの
--   「基本給・給与形態」＝有効な契約の賃金（いちばん新しい1件）、「通勤手当（月額）」＝入社情報の届出の定期代。
--   区分 A の「給与CSVの…参照元」は、この2つが空にならないかの確認。
-- =============================================================================

with
-- 表・列があるか
has as (
  select
    to_regclass('public.gw_employees')       is not null as emp,
    to_regclass('public.gw_contracts')       is not null as contracts,
    to_regclass('public.gw_onboard_profiles') is not null as profiles,
    to_regclass('public.gw_hr_applicants')   is not null as applicants,
    to_regclass('public.gw_hr_offers')       is not null as offers,
    to_regclass('public.gw_hr_pay')          is not null as hr_pay,
    to_regclass('public.gw_compensations')   is not null as comp,
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gw_hr_applicants'
             and column_name = 'employee_id') as applicant_link,
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gw_employees'
             and column_name = 'employee_kind') as emp_kind
),
-- SQL の部品（動的に組み立てて実行する。表が無くても、書いただけでは失敗しない）
parts as (
  select
    -- 対象社員（e）
    case when h.emp_kind then $p$e.status in ('active', 'leaving') and e.employee_kind is distinct from 'bp'$p$
         else $p$e.status in ('active', 'leaving')$p$ end as sc,
    -- 今日（日本時間）
    $p$(now() at time zone 'Asia/Tokyo')::date$p$ as today,
    -- 名前を最大30人まで並べ、あふれた分は「ほかN人」にする。label が空なら、件数だけ
    $p$select count(*) as n,
              coalesce(string_agg(label, '、' order by label) filter (where rn <= 30 and label <> ''), '')
                || case when count(*) filter (where label <> '') > 30 then '…ほか' || (count(*) filter (where label <> '') - 30) || '人' else '' end as v
         from (select label, row_number() over (order by label) as rn from ( %s ) q(label)) r$p$ as wrap
  from has h
),
-- 定義: (番号, 区分, 項目, 種類, 必要な表が揃っているか, 中身の SQL, 表が無いときの言い方, 注記)
--   種類 i … 参考の件数（ℹ）／ w … 0 件が正常（✅ / ⚠）
--   中身の SQL は、{SC}（対象社員の条件）と {TODAY}（今日）を使える。1行 = 1人。1列だけ返す（氏名、または 氏名（理由）。件数だけなら空文字）
def(seq, sect, item, kind, need, q_sql, missing_text, note) as (
  -- ---- A. 社員数と参照元 ----
  select 1, 'A', '対象社員数（在籍・退職手続き中。BP・退職者・入社準備中は含めない）', 'i', h.emp,
         $q$select ''::text as label from public.gw_employees e where {SC}$q$, '（表なし）', ''
    from has h
  union all
  select 2, 'A', '入社準備中の社員数（対象に含めない）', 'i', h.emp,
         $q$select ''::text from public.gw_employees e where e.status = 'invited'$q$, '（表なし）',
         '入社前の人の給与は、入社時に経営者が確認して記録する'
    from has h
  union all
  select 3, 'A', 'BP（外部パートナー）の人数（対象外）', 'i', h.emp and h.emp_kind,
         $q$select ''::text from public.gw_employees e where e.status in ('active', 'leaving') and e.employee_kind = 'bp'$q$, '（表なし）',
         '給与の管理の対象外。現場単価（unit_price）は、給与とは別に扱う'
    from has h
  union all
  select 4, 'A', '契約に給与あり（＝給与CSVの「基本給・給与形態」の参照元あり）', 'i', h.emp and h.contracts,
         $q$select ''::text from public.gw_employees e
              join lateral (select k.wage_amount from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                             order by k.created_at desc limit 1) c on c.wage_amount is not null
             where {SC}$q$, '（表なし）',
         '有効な契約のうち、いちばん新しい1件の賃金（人件費・給与CSVと同じ選び方）'
    from has h
  union all
  select 5, 'A', '契約に給与なし（＝給与CSVの「基本給・給与形態」が空になる）', 'i', h.emp and h.contracts,
         $q$select e.display_name from public.gw_employees e
             where {SC} and not exists (
               select 1 from (select k.wage_amount from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                               order by k.created_at desc limit 1) c where c.wage_amount is not null)$q$, '（表なし）',
         '有効な契約が無い、または賃金が未入力'
    from has h
  union all
  select 6, 'A', '内定の給与（gw_hr_pay）あり', 'i', h.emp and h.hr_pay and h.applicants and h.applicant_link,
         $q$select ''::text from public.gw_employees e join public.gw_hr_applicants a on a.employee_id = e.id
             where {SC} and exists (select 1 from public.gw_hr_pay p where p.applicant_id = a.id and (p.wage_type is not null or p.wage_amount is not null))$q$,
         '（表なし）', '入社前の条件。応募者から入社した人だけにある'
    from has h
  union all
  select 7, 'A', '内定の給与（gw_hr_pay）なし', 'i', h.emp and h.hr_pay and h.applicants and h.applicant_link,
         $q$select ''::text from public.gw_employees e
             where {SC} and not exists (select 1 from public.gw_hr_applicants a join public.gw_hr_pay p on p.applicant_id = a.id
                                         where a.employee_id = e.id and (p.wage_type is not null or p.wage_amount is not null))$q$,
         '（表なし）', '応募者を経ずに登録された人・db/100 のあと gw_hr_pay へ移っていない人は「なし」になる（参考）'
    from has h
  union all
  select 8, 'A', '通勤手当の届出あり（＝給与CSVの「通勤手当（月額）」の参照元あり）', 'i', h.emp and h.profiles,
         $q$select ''::text from public.gw_employees e join public.gw_onboard_profiles pr on pr.employee_id = e.id
             where {SC} and pr.commute_cost is not null$q$, '（表なし）',
         '本人が届け出た「1か月の定期代」。会社が決めた通勤手当ではない'
    from has h
  union all
  select 9, 'A', '通勤手当の届出なし（＝給与CSVの「通勤手当（月額）」が空になる）', 'i', h.emp and h.profiles,
         $q$select e.display_name from public.gw_employees e
             where {SC} and not exists (select 1 from public.gw_onboard_profiles pr where pr.employee_id = e.id and pr.commute_cost is not null)$q$,
         '（表なし）', '通勤手当が無い人も含む（通勤手当なしが正しい人は、そのままでよい）'
    from has h
  union all
  select 10, 'A', '給与管理に登録済み（いま適用中の記録がある）', 'i', h.emp and h.comp,
         $q$select ''::text from public.gw_employees e
             where {SC} and exists (select 1 from public.gw_compensations p where p.employee_id = e.id and p.effective_from <= {TODAY})$q$,
         '（給与管理の表なし）', ''
    from has h
  union all
  select 11, 'A', '給与管理に未登録（記録がない）', 'i', h.emp and h.comp,
         $q$select e.display_name from public.gw_employees e
             where {SC} and not exists (select 1 from public.gw_compensations p where p.employee_id = e.id)$q$,
         '（給与管理の表なし）', '経営者が /keiei#pay で記録する（初回給与の候補が使える）'
    from has h
  union all
  select 12, 'A', '給与管理に、適用開始日が未来の記録だけがある（まだ適用されていない）', 'i', h.emp and h.comp,
         $q$select e.display_name from public.gw_employees e
             where {SC} and exists (select 1 from public.gw_compensations p where p.employee_id = e.id)
               and not exists (select 1 from public.gw_compensations p where p.employee_id = e.id and p.effective_from <= {TODAY})$q$,
         '（給与管理の表なし）', '入社前の人なら想定どおり。在籍中なら、適用開始日を確認する'
    from has h

  -- ---- B. 各データ間の不一致・未登録（0 件が正常）----
  union all
  select 20, 'B', '給与管理が未登録で、契約に給与がある（→ 契約から候補を作れる）', 'w', h.emp and h.comp and h.contracts,
         $q$select e.display_name from public.gw_employees e
             join lateral (select k.wage_amount from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                            order by k.created_at desc limit 1) c on c.wage_amount is not null
             where {SC} and not exists (select 1 from public.gw_compensations p where p.employee_id = e.id)$q$,
         '（給与管理の表なし）', '経営者が候補を確認 → 修正 → 理由入力 → 登録する（自動では登録しない）'
    from has h
  union all
  select 21, 'B', '給与管理が未登録で、契約にも給与がない（→ 手入力が必要）', 'w', h.emp and h.comp and h.contracts,
         $q$select e.display_name from public.gw_employees e
             where {SC} and not exists (select 1 from public.gw_compensations p where p.employee_id = e.id)
               and not exists (select 1 from (select k.wage_amount from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                                               order by k.created_at desc limit 1) c where c.wage_amount is not null)$q$,
         '（給与管理の表なし）', '内定の給与・労働条件通知書・本人への確認を元に、経営者が入力する'
    from has h
  union all
  select 22, 'B', '給与管理の基本給が、契約の賃金と違う', 'w', h.emp and h.comp and h.contracts,
         $q$select e.display_name || '（' || case when cur.wage_type is distinct from c.wage_type then '種別が違う' else '金額が違う' end || '）'
              from public.gw_employees e
              join lateral (select p.wage_type, p.base_amount from public.gw_compensations p
                             where p.employee_id = e.id and p.effective_from <= {TODAY}
                             order by p.effective_from desc, p.revision desc limit 1) cur on true
              join lateral (select k.wage_type, k.wage_amount from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                             order by k.created_at desc limit 1) c on c.wage_amount is not null
             where {SC} and (cur.wage_type is distinct from c.wage_type or cur.base_amount is distinct from c.wage_amount)$q$,
         '（給与管理の表なし）', '契約を更新するか、給与の記録を訂正するか、経営者が判断する（給与CSVの「基本給」は契約から出る）'
    from has h
  union all
  select 23, 'B', '給与管理の通勤手当が、本人の届出と違う', 'w', h.emp and h.comp and h.profiles,
         $q$select e.display_name || '（' || case when cur.commute_amount is null then '給与管理は未設定・届出あり'
                                                  when pr.commute_cost is null then '給与管理にあり・届出なし'
                                                  else '金額が違う' end || '）'
              from public.gw_employees e
              join lateral (select p.commute_amount from public.gw_compensations p
                             where p.employee_id = e.id and p.effective_from <= {TODAY}
                             order by p.effective_from desc, p.revision desc limit 1) cur on true
              left join public.gw_onboard_profiles pr on pr.employee_id = e.id
             where {SC} and cur.commute_amount is distinct from pr.commute_cost$q$,
         '（給与管理の表なし）', '上限・非課税枠・定額支給などで違うことは普通にある。確認のうえ、給与管理の値を正とする（給与CSVの「通勤手当」は届出から出る）'
    from has h
  union all
  select 24, 'B', '内定の給与（gw_hr_pay）が、契約の賃金と違う（参考）', 'w', h.emp and h.contracts and h.hr_pay and h.applicants and h.applicant_link,
         $q$select e.display_name || '（' || case when hp.wage_type is distinct from c.wage_type then '種別が違う' else '金額が違う' end || '）'
              from public.gw_employees e
              join public.gw_hr_applicants a on a.employee_id = e.id
              join lateral (select p.wage_type, p.wage_amount from public.gw_hr_pay p where p.applicant_id = a.id
                             order by (p.offer_id is not null) desc, p.updated_at desc limit 1) hp on true
              join lateral (select k.wage_type, k.wage_amount from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                             order by k.created_at desc limit 1) c on c.wage_amount is not null
             where {SC} and hp.wage_amount is not null
               and (hp.wage_type is distinct from c.wage_type or hp.wage_amount is distinct from c.wage_amount)$q$,
         '（表なし）', '昇給・条件変更で違うのは普通。契約を最新とし、給与管理に取り込むときは契約を基準にする'
    from has h
  union all
  select 25, 'B', '有効な契約が2件以上ある（どの賃金が現在か曖昧）', 'w', h.emp and h.contracts,
         $q$select e.display_name from public.gw_employees e
             where {SC} and (select count(*) from public.gw_contracts k where k.employee_id = e.id and k.status = 'active') > 1$q$,
         '（表なし）', '候補は、いちばん新しい1件から作る。古い契約を「置き換え済み」にするかは、契約の画面で判断する'
    from has h
  union all
  select 26, 'B', '契約の賃金の種別が 月給/年俸/時給/日給 以外で、金額がある（候補にできない）', 'w', h.emp and h.contracts,
         $q$select e.display_name from public.gw_employees e
              join lateral (select k.wage_type, k.wage_amount from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                             order by k.created_at desc limit 1) c on c.wage_amount is not null
             where {SC} and coalesce(c.wage_type, '') not in ('月給', '年俸', '時給', '日給')$q$,
         '（表なし）', '給与管理へは、種別を経営者が選び直して入力する'
    from has h
  union all
  select 27, 'B', '契約の「手当・控除など」（wage_note）に文章がある（手当は候補にできない）', 'w', h.emp and h.contracts,
         $q$select e.display_name from public.gw_employees e
              join lateral (select k.wage_note from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                             order by k.created_at desc limit 1) c on btrim(coalesce(c.wage_note, '')) <> ''
             where {SC}$q$,
         '（表なし）', '手当の金額は文章の中にしかない。給与管理には、手当を金額つきで入力し直す（自動では読み取らない）'
    from has h
  union all
  select 28, 'B', '給与CSVの出力値（基本給＝契約・通勤手当＝届出）と、給与管理が違う（22 と 23 の合計。重複を除く）', 'w', h.emp and h.comp and h.contracts and h.profiles,
         $q$select e.display_name || '（' || concat_ws('・',
                   case when c.wage_amount is not null and (cur.wage_type is distinct from c.wage_type or cur.base_amount is distinct from c.wage_amount)
                        then '基本給' end,
                   case when cur.commute_amount is distinct from pr.commute_cost then '通勤手当' end) || 'が違う）'
              from public.gw_employees e
              join lateral (select p.wage_type, p.base_amount, p.commute_amount from public.gw_compensations p
                             where p.employee_id = e.id and p.effective_from <= {TODAY}
                             order by p.effective_from desc, p.revision desc limit 1) cur on true
              left join lateral (select k.wage_type, k.wage_amount from public.gw_contracts k where k.employee_id = e.id and k.status = 'active'
                                  order by k.created_at desc limit 1) c on true
              left join public.gw_onboard_profiles pr on pr.employee_id = e.id
             where {SC} and ((c.wage_amount is not null and (cur.wage_type is distinct from c.wage_type or cur.base_amount is distinct from c.wage_amount))
                             or cur.commute_amount is distinct from pr.commute_cost)$q$,
         '（給与管理の表なし）', '給与CSVの読み先を切り替える前に、0 件にする（切り替えは別の承認。docs/keiei-pay-management.md §12）'
    from has h
),
-- 中身の SQL を、部品を埋めて実行する
res as (
  select d.seq, d.sect, d.item, d.kind, d.missing_text, d.note,
         case when d.need then (xpath('/row/n/text()', query_to_xml(format(p.wrap, replace(replace(d.q_sql, '{SC}', p.sc), '{TODAY}', p.today)), false, true, '')))[1]::text::int end as n,
         case when d.need then (xpath('/row/v/text()', query_to_xml(format(p.wrap, replace(replace(d.q_sql, '{SC}', p.sc), '{TODAY}', p.today)), false, true, '')))[1]::text end as v
    from def d cross join parts p
),

-- ---- 参考: 元の列に残る給与・給与管理の行数 ---------------------------------------
ref(seq, item, n, note) as (
  select 40, '応募者の元の列の給与（分離後は 0 になる）',
         case when h.applicants then (xpath('/row/v/text()', query_to_xml(
           $q$select count(*) as v from public.gw_hr_applicants where wage_type is not null or wage_amount is not null$q$, false, true, '')))[1]::text::int end,
         '内定前の条件。db/100・101 のあと、gw_hr_pay へ移る'
    from has h
  union all
  select 41, '合格通知の元の列の給与（分離後は 0 になる）',
         case when h.offers then (xpath('/row/v/text()', query_to_xml(
           $q$select count(*) as v from public.gw_hr_offers where wage_type is not null or wage_amount is not null$q$, false, true, '')))[1]::text::int end,
         '内定前の条件'
    from has h
  union all
  select 42, '内定の給与専用の表（gw_hr_pay）の行数',
         case when h.hr_pay then (xpath('/row/v/text()', query_to_xml($q$select count(*) as v from public.gw_hr_pay$q$, false, true, '')))[1]::text::int end,
         'db/100 のあと。入社前の条件で、社員の給与の正ではない'
    from has h
  union all
  select 43, '給与管理（gw_compensations）の行数（訂正の版を含む）',
         case when h.comp then (xpath('/row/v/text()', query_to_xml($q$select count(*) as v from public.gw_compensations$q$, false, true, '')))[1]::text::int end,
         'db/105 のあと。現在の給与額の正'
    from has h
),

-- ---- C. 給与の所在（どれを正とするか）-------------------------------------------
c(seq, item, state, detail) as (values
  (61, '現在の給与額（基本給・手当・通勤手当）', '正: gw_compensations（給与管理）', '適用開始日つきの履歴。追記だけ。/keiei だけが書く'),
  (62, '契約上の賃金', '参照: gw_contracts / 署名済みPDF', '書面が言っていること。記録のたびに写しを残し、食い違いを見せる。/keiei は契約へ書かない'),
  (63, '内定時の給与', '参照: gw_hr_pay（入社前）', '自動では移さない。入社時に、経営者が確認して取り込む'),
  (64, '本人が届け出た定期代', '参照: gw_onboard_profiles.commute_cost', '会社が決めた通勤手当ではない'),
  (65, '労働条件通知書の「賃金」欄・署名済みPDF', '参照: gw_doc_orders / gw_sign_requests', '文字列。過去の書面は不変の証跡'),
  (66, '給与CSV（MF給与の取込用）', '出力: lib/payroll-csv.js', 'いまは契約（基本給）と届出（通勤手当）を読む。給与管理を読む形への切り替えは、差分が 0 になってから、別の承認で'),
  (67, '昇給レンジ・昇給の判断（キャリア）', '別: gw_career_levels / gw_career_reviews', '目安と判断の記録。給与額の正ではない'),
  (68, 'PP・BPの現場単価（unit_price）', '対象外: gw_site_contracts', '給与管理に混ぜない。意味が確定するまで変更しない')
)

select "区分", "項目", "状態", "詳細" from (
  select r.seq,
         case r.sect when 'A' then 'A. 社員数と給与の参照元' else 'B. 不一致・未登録（0 件が正常）' end as "区分",
         r.item as "項目",
         case when r.n is null then r.missing_text
              when r.kind = 'w' then case when r.n = 0 then '✅ 0 件' else '⚠ ' || r.n::text || ' 件' end
              else 'ℹ ' || r.n::text || ' 件' end as "状態",
         -- 名前に含まれる記号が、XML のエスケープのまま出ないように戻す
         coalesce(nullif(replace(replace(replace(replace(coalesce(r.v, ''), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&amp;', '&'), ''), '')
           || case when coalesce(r.v, '') <> '' and r.note <> '' then ' ／ ' else '' end || r.note as "詳細"
    from res r
  union all
  select f.seq, 'A. 社員数と給与の参照元（行数・参考）', f.item,
         case when f.n is null then '（表なし）' else 'ℹ ' || f.n::text || ' 件' end, f.note
    from ref f
  union all
  select c.seq, 'C. 給与の所在（正・参照）', c.item, c.state, c.detail from c
) all_rows
order by seq;
