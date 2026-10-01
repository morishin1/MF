-- =============================================================================
-- 101: 応募者・合格通知の「元の列」の給与を空にする（給与分離 案A の第2段）
--
--   100 で、給与を gw_hr_pay へ写した。アプリを HR_PAY_SPLIT=1 で動かすと、給与は
--   gw_hr_pay から読み書きされ、元の列（gw_hr_applicants / gw_hr_offers の wage_type・wage_amount）は
--   使われなくなる。だが、元の列に値が残っている限り、採用担当・責任者は、
--   ブラウザから直接 DB を叩いて読める。ここで元の列を空にして、初めて塞がる。
--
-- ■ 流してよい条件（この順に、全部そろってから）
--     ① db/100 を流した
--     ② HR_PAY_SPLIT=1 で再デプロイし、応募者・合格通知の画面で給与が正しく出ている
--     ③ 下の「A. 事前確認」の結果が 0 件
--
-- ■ この SQL がすること
--     ・安全装置: 元の列に給与があるのに gw_hr_pay に行が無いものがあれば、何も変えずに止める
--     ・元の列の給与を空にする
--     ・以後、元の列に給与を書き込めなくする（check 制約）。設定を誤って HR_PAY_SPLIT を外しても、
--       給与が元の列に戻ってしまう（＝また読める）ことがない。書こうとすると、はっきり失敗する
--
-- ■ 実行方法: Supabase の SQL Editor に貼って Run（べき等）
--
-- ■ A. 事前確認（読み取りだけ。0 件になること）
--   select 'applicant' as kind, a.id from public.gw_hr_applicants a
--     left join public.gw_hr_pay p on p.applicant_id = a.id and p.offer_id is null
--    where (a.wage_type is not null or a.wage_amount is not null) and p.id is null
--   union all
--   select 'offer', o.id from public.gw_hr_offers o
--     left join public.gw_hr_pay p on p.offer_id = o.id
--    where (o.wage_type is not null or o.wage_amount is not null) and p.id is null;
--
-- ■ B. 適用後の確認（読み取りだけ）
--   select count(*) from public.gw_hr_applicants where wage_type is not null or wage_amount is not null;  -- 0
--   select count(*) from public.gw_hr_offers     where wage_type is not null or wage_amount is not null;  -- 0
--
-- ■ C. 元に戻す（給与を元の列へ書き戻す。HR_PAY_SPLIT を外す前に、必ず先にこれを流す）
--   alter table public.gw_hr_applicants drop constraint if exists gw_hr_applicants_wage_moved;
--   alter table public.gw_hr_offers     drop constraint if exists gw_hr_offers_wage_moved;
--   update public.gw_hr_applicants a set wage_type = p.wage_type, wage_amount = p.wage_amount
--     from public.gw_hr_pay p where p.applicant_id = a.id and p.offer_id is null;
--   update public.gw_hr_offers o set wage_type = p.wage_type, wage_amount = p.wage_amount
--     from public.gw_hr_pay p where p.offer_id = o.id;
-- =============================================================================

begin;

-- 安全装置: 元の列にだけ給与が残っているもの（gw_hr_pay に行が無いもの）があれば、止める。
-- 値の違いは問わない（分離のあとに給与を直していれば、gw_hr_pay のほうが新しい）
do $$
declare
  n int;
begin
  select count(*) into n from (
    select a.id from public.gw_hr_applicants a
      left join public.gw_hr_pay p on p.applicant_id = a.id and p.offer_id is null
     where (a.wage_type is not null or a.wage_amount is not null) and p.id is null
    union all
    select o.id from public.gw_hr_offers o
      left join public.gw_hr_pay p on p.offer_id = o.id
     where (o.wage_type is not null or o.wage_amount is not null) and p.id is null
  ) x;
  if n > 0 then
    raise exception '元の列にだけ給与が残っている行が % 件あります（gw_hr_pay に行がありません）。db/100 を流し直すか、原因を確かめてから流してください', n;
  end if;
end $$;

update public.gw_hr_applicants set wage_type = null, wage_amount = null
 where wage_type is not null or wage_amount is not null;
update public.gw_hr_offers set wage_type = null, wage_amount = null
 where wage_type is not null or wage_amount is not null;

-- 以後、元の列には給与を書けない（給与は gw_hr_pay だけ）
alter table public.gw_hr_applicants drop constraint if exists gw_hr_applicants_wage_moved;
alter table public.gw_hr_applicants add constraint gw_hr_applicants_wage_moved
  check (wage_type is null and wage_amount is null);
alter table public.gw_hr_offers drop constraint if exists gw_hr_offers_wage_moved;
alter table public.gw_hr_offers add constraint gw_hr_offers_wage_moved
  check (wage_type is null and wage_amount is null);

comment on column public.gw_hr_applicants.wage_type is
  '使わない（常に null）。給与は gw_hr_pay（給与を見られる人だけの RLS）。db/101 で check 制約を付けた';
comment on column public.gw_hr_applicants.wage_amount is
  '使わない（常に null）。給与は gw_hr_pay（給与を見られる人だけの RLS）。db/101 で check 制約を付けた';
comment on column public.gw_hr_offers.wage_type is
  '使わない（常に null）。給与は gw_hr_pay。db/101 で check 制約を付けた';
comment on column public.gw_hr_offers.wage_amount is
  '使わない（常に null）。給与は gw_hr_pay。db/101 で check 制約を付けた';

notify pgrst, 'reload schema';

commit;
