-- =============================================================================
-- 128: 採用HR：面談合格後の「採用区分」（offer_type）と、区分ごとの条件（offer_terms）
--
-- ■ 何をするか（列を足すだけ。既存の行・既存の列は変えない）
--   1) gw_hr_applicants.offer_type … 合格後に選んだ採用区分
--   2) gw_hr_offers.offer_type     … その版のオファーの採用区分（発行時点のスナップショット）
--   3) gw_hr_offers.offer_terms    … 区分にしか無い条件（役職・委託業務・成果物・NDA など。jsonb）
--   採用区分は5つ（lib/hr-offer-types.js が正）：
--     executive_employee（正社員・幹部候補）／training（育成枠）／contractor（業務委託）／
--     part_time（パート・アルバイト）／spot（スポット・副業）
--   区分とステータスは別の列（status はこれまでの値をそのまま使う）。既存の行は offer_type = null のまま
--   （区分の無い、これまでの合格通知として動く）。
--
-- ■ 金額は入れない
--   給与・報酬の金額は、これまでどおり wage_type / wage_amount（HR_PAY_SPLIT=1 なら gw_hr_pay）。
--   offer_terms には金額を入れない。
--   インセンティブ・交通費の文章は offer_terms に入るが、API は給与を見られない人に返さない（lib/salary.js）。
--
-- ■ 権限
--   既存の表に列を足すだけなので、RLS・ポリシーは変えない（081 のまま）。
--
-- ■ 適用の順番
--   この SQL → アプリのデプロイ。
--   デプロイが先でも、応募者一覧・詳細・合格通知はこれまでどおり動く。
--   採用区分を選ぶ操作だけが「db/128 を流してください」と出て止まる。
--
-- 実行方法: Supabase の SQL Editor に、このファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 081（gw_hr_applicants・gw_hr_offers）
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_hr_applicants') is null or to_regclass('public.gw_hr_offers') is null then
    raise exception 'gw_hr_applicants / gw_hr_offers がありません。先に db/081_hr_recruiting.sql を流してください';
  end if;
end $$;

alter table public.gw_hr_applicants
  add column if not exists offer_type text;

alter table public.gw_hr_offers
  add column if not exists offer_type  text,
  add column if not exists offer_terms jsonb not null default '{}'::jsonb;

-- 区分の値は5つだけ（null は「区分なし」＝これまでの合格通知）
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_applicants_offer_type_chk') then
    alter table public.gw_hr_applicants add constraint gw_hr_applicants_offer_type_chk
      check (offer_type is null or offer_type in ('executive_employee', 'training', 'contractor', 'part_time', 'spot'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_offer_type_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_offer_type_chk
      check (offer_type is null or offer_type in ('executive_employee', 'training', 'contractor', 'part_time', 'spot'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_offer_terms_obj_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_offer_terms_obj_chk
      check (jsonb_typeof(offer_terms) = 'object');
  end if;
end $$;

comment on column public.gw_hr_applicants.offer_type is
  '合格後の採用区分（executive_employee/training/contractor/part_time/spot）。null は区分なし（これまでの合格通知）';
comment on column public.gw_hr_offers.offer_type is
  'この版のオファーの採用区分（発行時点のスナップショット）';
comment on column public.gw_hr_offers.offer_terms is
  '区分にしか無い条件（役職・委託業務・成果物・NDA など）。金額は入れない（wage_type / wage_amount）';

commit;

notify pgrst, 'reload schema';

-- ■ 確認（流したあとに実行。1つ目は3行・2つ目も3行出れば OK）
-- select table_name, column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and ((table_name = 'gw_hr_applicants' and column_name = 'offer_type')
--      or (table_name = 'gw_hr_offers' and column_name in ('offer_type', 'offer_terms')))
--  order by table_name, column_name;
-- select conname from pg_constraint
--  where conname in ('gw_hr_applicants_offer_type_chk', 'gw_hr_offers_offer_type_chk', 'gw_hr_offers_offer_terms_obj_chk');
