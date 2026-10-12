-- db/133_hr_offer_handoff.sql のやり直し（正式契約の要否・Office へ引き渡した記録の列を外す）。
--
-- ■ 注意：列ごと消える（データも消える）
--   オファーごとの正式契約の要否、どの版を・いつ・誰が Office へ引き渡したかの記録が、すべて消える。
--   db/132 の列（条件通知書PDF・承諾記録・LegalSign）と、その trigger・function には触らない。
--   社員名簿・アカウント・入社手続き（Office 側で作ったもの）も消さない。
--   本番で流す前に、残したい行を控えること：
--     select id, applicant_id, version, offer_type, formal_contract_required, accepted_at, formal_signed_at, handoff_at, handoff_by
--       from public.gw_hr_offers
--      where handoff_at is not null or formal_contract_required is not null;
--
-- 戻したあとも、条件承諾・LegalSign・［本採用へ進める］はこれまでどおり動く
-- （アプリは列が無いことを見て止まらない。正式契約の要否は区分の既定で扱う）。
begin;

drop trigger if exists gw_hr_offers_lock_handoff on public.gw_hr_offers;
drop function if exists public.gw_hr_offers_lock_handoff();
drop trigger if exists gw_hr_offers_formal_default on public.gw_hr_offers;
drop function if exists public.gw_hr_offers_formal_default();

drop index if exists public.idx_gw_hr_offers_handoff;

alter table public.gw_hr_offers
  drop constraint if exists gw_hr_offers_formal_required_chk,
  drop constraint if exists gw_hr_offers_handoff_pair_chk,
  drop constraint if exists gw_hr_offers_handoff_accepted_chk,
  drop constraint if exists gw_hr_offers_handoff_formal_chk,
  drop constraint if exists gw_hr_offers_handoff_type_chk;

alter table public.gw_hr_offers
  drop column if exists formal_contract_required,
  drop column if exists handoff_at,
  drop column if exists handoff_by;

commit;

notify pgrst, 'reload schema';
