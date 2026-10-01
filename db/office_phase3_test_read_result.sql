-- =============================================================================
-- 【Office Phase3 TEST】 実 Claude の読取結果を、正解と突き合わせる（読み取り専用）
--
-- Supabase の SQL Editor に貼って Run。**何も書き換えません（SELECT だけ）**。
-- 「AIで読み取る」のあと、いつ流してもかまいません（人が直したあとでも、AI が最初に返した値は ai_snapshot に残っているので、
--  同じ結果が出ます）。
--
-- ■ 何を比べるか
--   テスト勤務表（test/fixtures/office-timesheet/sample-2026-10.pdf）の「書かれているとおり」の値（expected.json の printed）と、
--   AI が最初に返した値（gw_timesheet_days.ai_snapshot）。31日 × 5項目（区分・開始・終了・休憩・実働）＝155項目
--     一致       … 同じ（書かれていない所は、AI も空）
--     誤読       … 書かれているのと違う値
--     読み落とし … 書かれているのに、AI が空
--     推測       … 書かれていない・読めない所に、AI が値を入れた（**1件でもあれば、本番投入は止めて修正**）
--   読めない所（10/14：休憩・実働が空白、10/21：終了が染みで隠れている・実働も）は、AI も空のままなら「一致」
--   夜間（10/29 の終了）は 30:00 でも 6:00（翌日の意味）でも「一致」
--
-- ■ 使う勤務表：テスト社員（固定 id）の 2026-10。db/office_phase3_test_seed.sql で作ったもの
-- ■ 所要時間：この SQL では、AI が何秒かかったかは出ません（保存していないため）。画面の「30秒〜1分」の表示、またはブラウザの
--   開発者ツール（Network）で /api/office/timesheet の action=read の時間を見てください。下の「目安」は、ファイルを追加してから読取が
--   終わるまでの経過で、ボタンを押すまでの待ち時間も含みます
-- =============================================================================

with
sheet as (
  select * from public.gw_timesheets
   where employee_id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' and target_month = '2026-10'
),
-- 正解（勤務表に書かれているとおり）。alt_end は、終了の別の書き方（10/29 の夜間：翌日 6:00 = 360）
expected(day, kind, s, e, alt_end, b, w) as (
  values
    ( 1, 'work', 540, 1080, null, 60, 480),
    ( 2, 'work', 570, 1110, null, 60, 480),
    ( 3, 'off', null, null, null, null, null),
    ( 4, 'off', null, null, null, null, null),
    ( 5, 'work', 540, 1050, null, 45, 465),
    ( 6, 'work', 540, 1080, null, 60, 480),
    ( 7, 'work', 540, 1080, null, 60, 480),
    ( 8, 'work', 600, 1140, null, 60, 480),
    ( 9, 'work', 540, 1290, null, 60, 690),
    (10, 'off', null, null, null, null, null),
    (11, 'off', null, null, null, null, null),
    (12, 'off', null, null, null, null, null),
    (13, 'work', 540, 1080, null, 60, 480),
    (14, 'work', 540, 1080, null, null, null),
    (15, 'work', 540, 1080, null, 60, 480),
    (16, 'off', null, null, null, null, null),
    (17, 'off', null, null, null, null, null),
    (18, 'off', null, null, null, null, null),
    (19, 'work', 540, 1080, null, 60, 480),
    (20, 'work', 540, 1080, null, 60, 480),
    (21, 'work', 540, null, null, 60, null),
    (22, 'work', 540, 1080, null, 60, 480),
    (23, 'work', 540, 1110, null, 60, 510),
    (24, 'off', null, null, null, null, null),
    (25, 'off', null, null, null, null, null),
    (26, 'work', 540, 1080, null, 60, 480),
    (27, 'work', 540, 1080, null, 60, 480),
    (28, 'work', 540, 1080, null, 60, 480),
    (29, 'work', 1320, 1800, 360, 60, 420),
    (30, 'off', null, null, null, null, null),
    (31, 'off', null, null, null, null, null)
),
got as (
  select extract(day from d.work_date)::int as day, d.ai_snapshot as snap
    from public.gw_timesheet_days d join sheet on sheet.id = d.timesheet_id
),
cells as (
  select x.day, f.field, f.exp_v, f.got_v, f.alt_v
    from expected x
    left join got g on g.day = x.day
    cross join lateral (values
      ('区分', x.kind,      g.snap ->> 'kind',           null::text),
      ('開始', x.s::text,   g.snap ->> 'startMin',       null::text),
      ('終了', x.e::text,   g.snap ->> 'endMin',         x.alt_end::text),
      ('休憩', x.b::text,   g.snap ->> 'breakMin',       null::text),
      ('実働', x.w::text,   g.snap ->> 'sheetWorkedMin', null::text)
    ) as f(field, exp_v, got_v, alt_v)
),
judged as (
  select day, field, exp_v, got_v,
         -- 画面と同じ表記（区分はそのまま、時刻・分は h:mm。空は「空」）
         case when exp_v is null then '空' when field = '区分' then exp_v else (exp_v::int / 60)::text || ':' || lpad((exp_v::int % 60)::text, 2, '0') end as exp_t,
         case when got_v is null then '空' when field = '区分' then got_v else (got_v::int / 60)::text || ':' || lpad((got_v::int % 60)::text, 2, '0') end as got_t,
         case when exp_v is null and got_v is null then '一致'
              when exp_v is null                    then '推測'
              when got_v is null                    then '読み落とし'
              when got_v = exp_v or got_v = alt_v   then '一致'
              else '誤読' end as res
    from cells
),
tally as (
  select count(*) filter (where res = '一致') as ok, count(*) filter (where res = '誤読') as wrong,
         count(*) filter (where res = '読み落とし') as missed, count(*) filter (where res = '推測') as guessed,
         count(*) as total
    from judged
),
readev as (
  select detail, created_at from public.gw_office_events
   where employee_id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' and billing_month = '2026-10' and kind = 'timesheet.read'
   order by created_at desc limit 1
),
upev as (
  select created_at from public.gw_office_events
   where employee_id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' and billing_month = '2026-10' and kind = 'timesheet.upload'
   order by created_at desc limit 1
),
diffs as (
  select string_agg(
           '10/' || lpad(day::text, 2, '0') || ' ' || field || '：正解 ' || exp_t || ' → AI ' || got_t || '（' || res || '）',
           E'\n' order by day, field) as t
    from judged where res <> '一致'
)
select 順, 項目, 値, 判定
  from (values
    (1,  '読取した勤務表', coalesce((select status || ' ／ read_state=' || read_state from sheet), '（勤務表の行がありません＝まだ読み取っていません）'),
         case when exists (select 1 from sheet where read_state = 'ok') then '✅ 読取完了' when exists (select 1 from sheet) then '❌ 読取に失敗（下の 2）' else '❌ まだ読み取っていません' end),
    (2,  '使用モデル名', coalesce((select ai_model from sheet), '—'), 'ℹ'),
    (3,  '読取の結果・失敗の理由', coalesce((select coalesce(ai_message, '（メッセージなし）') from sheet), '—') || coalesce(' ／ 直近の読取の記録：' || (select detail::text from readev), ''), 'ℹ'),
    (4,  '読取日時（日本時間）', coalesce((select to_char(ai_read_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS') from sheet), '—'), 'ℹ'),
    (5,  '所要時間の目安（ファイル追加 → 読取完了）', coalesce((select round(extract(epoch from (r.created_at - u.created_at)))::text || ' 秒（ボタンを押すまでの待ちを含む）' from readev r, upev u), '—'), 'ℹ 実際の秒数は、画面の表示か開発者ツールで'),
    (6,  '使ったトークン（入力／出力）', coalesce((select (detail ->> 'inputTokens') || ' ／ ' || (detail ->> 'outputTokens') from readev), '—'), 'ℹ'),
    (7,  '読み込まれた日数（画面に出る日別データ）', (select count(*)::text from got where snap is not null) || ' / 31', case when (select count(*) from got where snap is not null) = 31 then '✅ 31日ぶんが画面用のデータに入っている' else '❌' end),
    (8,  '正しく読めた項目数', (select ok::text || ' / ' || total::text from tally), 'ℹ'),
    (9,  '誤読数', (select wrong::text from tally), case when (select wrong from tally) = 0 then '✅' else '⚠ 下の 13 を確認' end),
    (10, '読み落とし数', (select missed::text from tally), case when (select missed from tally) = 0 then '✅' else '⚠ 下の 13 を確認' end),
    (11, '推測して埋めた件数', (select guessed::text from tally), case when (select guessed from tally) = 0 then '✅ 0件' else '❌ 1件でもあれば、本番投入は止めて修正' end),
    (12, '休憩が空欄の日（10/14）を、空欄のまま扱えたか',
         coalesce((select got_t from judged where day = 14 and field = '休憩'), '—'),
         case when (select res from judged where day = 14 and field = '休憩') = '一致' then '✅ 空欄のまま' else '❌ 補完された' end),
    (13, '判読不能な箇所（10/14 休憩・実働、10/21 終了・実働）を、補完しなかったか',
         (select string_agg('10/' || lpad(day::text, 2, '0') || ' ' || field || '=' || got_t, ' ／ ' order by day, field)
            from judged where (day = 14 and field in ('休憩', '実働')) or (day = 21 and field in ('終了', '実働'))),
         case when (select count(*) from judged where ((day = 14 and field in ('休憩', '実働')) or (day = 21 and field in ('終了', '実働'))) and res <> '一致') = 0
              then '✅ すべて空のまま' else '❌ 補完された所がある' end),
    (14, '一致しなかった項目', coalesce((select t from diffs), 'なし'), 'ℹ'),
    (15, '確定した稼働時間（人が確認・修正したあと）', coalesce((select case when status = 'confirmed' then round(total_minutes / 60.0, 2)::text || ' h（' || work_days || '日）' else '（まだ確定していません）' end from sheet), '—'), 'ℹ 正解の合計は 154.75h（154:45）'),
    (16, '確認にかけた時間・直した項目の数', coalesce((select review_seconds::text || ' 秒 ／ ' || edit_count::text || ' 項目' from sheet), '—'), 'ℹ')
  ) as v(順, 項目, 値, 判定)
 order by 順;
