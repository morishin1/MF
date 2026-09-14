-- =============================================================================
-- 065: 入社手続きは1人1つ。増えてしまったぶんを片付けて、二度と増えないようにする
--
-- ■ 何が起きていたか
--
--   入社手続きの画面で、6つの書類すべてに
--
--     「この書類は、いまのチェックリストに結び付いていません」
--
--   とだけ出て、出す口（アップロード）が1つも出なくなっていた。
--   前は出せていたのに、ある時から急に出せなくなる。
--
-- ■ なぜそうなったか
--
--   コードは長いあいだ、こう書いてあった。
--
--     .eq("employee_id", id).eq("kind", "onboarding").maybeSingle()
--
--   コメントには「1人1つ（employee_id, kind で一意）」と書いてあった。
--   ところが、その一意制約はどの SQL にも無かった。
--
--   行が2つできると maybeSingle は **エラーを返して data を null にする**。
--   呼ぶ側はどこも error を見ていなかったので、
--
--     ・本人の画面 … 「手続きが無い人」として扱われ、
--                    書類が1つもチェックリストに結び付かなくなる
--     ・作る側     … 「まだ無い」と判断して、もう1つ作る
--
--   となる。2つになった瞬間から本人は何も出せなくなり、
--   管理者が操作するたびに3つ4つと増えていく。
--
--   直りにくかったのは、画面のメッセージが
--   「結び付いていません」としか言わなかったため。
--   結び付ける相手（手続き）が消えて見えていることが、どこにも出ていなかった。
--
-- ■ ここで直すこと
--
--   1. 増えてしまった手続きを、いちばん古いものにまとめる
--      （書類もファイルも、そちらへ寄せる。何も消さない）
--   2. 空になった重複行を消す
--   3. (employee_id, kind) に一意制約を付けて、二度と増えないようにする
--
--   コード側は lib/onboard-kit.js の findProcedure にまとめてある。
--   一意制約を付けたあとも、読むほうは複数あっても壊れないままにしてある。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 008_onboarding.sql / 037_onboard_form.sql を流してあること
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) いま何件ダブっているか、先に見る
-- -----------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from (
    select employee_id, kind from public.gw_procedures
     group by employee_id, kind having count(*) > 1) x;
  raise notice 'ダブっている (employee_id, kind) の組: % 件', n;
end $$;

-- -----------------------------------------------------------------------------
-- 1) いちばん古いものを正として、あとのぶんを寄せる
-- -----------------------------------------------------------------------------
with ranked as (
  select id, employee_id, kind,
         first_value(id) over (
           partition by employee_id, kind
           order by created_at asc, id asc) as keeper
    from public.gw_procedures
),
dups as (select id, keeper from ranked where id <> keeper)
update public.gw_procedure_items i
   set procedure_id = d.keeper
  from dups d
 where i.procedure_id = d.id;

with ranked as (
  select id, employee_id, kind,
         first_value(id) over (
           partition by employee_id, kind
           order by created_at asc, id asc) as keeper
    from public.gw_procedures
),
dups as (select id, keeper from ranked where id <> keeper)
update public.gw_procedure_files f
   set procedure_id = d.keeper
  from dups d
 where f.procedure_id = d.id;

-- -----------------------------------------------------------------------------
-- 2) 寄せた結果、同じ書類が2行になったものを片付ける
--
--    消すのは「鍵が同じ」「まだ何も出していない」「ファイルが付いていない」
--    行だけ。出したものが付いている行は、どちらも残す。
--    （残っても画面には1つしか出ない。消して困るほうが大きい）
-- -----------------------------------------------------------------------------
delete from public.gw_procedure_items i
 using (
   select id,
          row_number() over (
            partition by procedure_id, item_key
            order by case when status = 'todo' then 1 else 0 end asc,
                     created_at asc, id asc) as rn
     from public.gw_procedure_items
    where item_key is not null) x
 where i.id = x.id
   and x.rn > 1
   and i.status = 'todo'
   and not exists (select 1 from public.gw_procedure_files f where f.item_id = i.id);

-- -----------------------------------------------------------------------------
-- 3) 空になった重複の手続きを消す
--
--    書類もファイルも残っていないものだけ。
--    寄せ損ねたものがあれば、ここで残るので気づける
-- -----------------------------------------------------------------------------
with ranked as (
  select id, employee_id, kind,
         first_value(id) over (
           partition by employee_id, kind
           order by created_at asc, id asc) as keeper
    from public.gw_procedures
)
delete from public.gw_procedures p
 using ranked r
 where p.id = r.id
   and r.id <> r.keeper
   and not exists (select 1 from public.gw_procedure_items i where i.procedure_id = p.id)
   and not exists (select 1 from public.gw_procedure_files f where f.procedure_id = p.id);

-- -----------------------------------------------------------------------------
-- 4) 二度と増えないようにする
--
--    ここで落ちるなら、まだダブりが残っている（上の 3 で消せなかった）。
--    そのときは下の「確認」を流して、どの人が残っているか見ること
-- -----------------------------------------------------------------------------
create unique index if not exists uq_gw_procedures_employee_kind
  on public.gw_procedures(employee_id, kind);

comment on index public.uq_gw_procedures_employee_kind is
  '入社手続きは1人1つ。2つできると maybeSingle がエラーになり、'
  '本人の画面から書類を出す口が消える（db/065 の冒頭）';


notify pgrst, 'reload schema';

-- 確認:
--   -- まだダブっている人がいないか
--   select e.display_name, p.kind, count(*)
--     from public.gw_procedures p
--     join public.gw_employees e on e.id = p.employee_id
--    group by e.display_name, p.kind having count(*) > 1;
--
--   -- 本人が出す書類に、ちゃんと鍵が入っているか
--   select i.item_key, i.title, i.status
--     from public.gw_procedure_items i
--     join public.gw_procedures p on p.id = i.procedure_id
--    where p.kind = 'onboarding' and i.owner = 'employee'
--    order by i.sort_order;
