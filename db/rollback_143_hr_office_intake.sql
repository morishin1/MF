-- =============================================================================
-- db/143_hr_office_intake.sql のやり直し（採用HR → Office の早期引き渡し：社長判断の確定記録・条件ヒアリング・
-- 早期引き渡し・応募者の安全装置を外す）
--
-- ■ 先にやること
--   1. アプリを db/143 より前の版へ戻すか、環境変数 HR_OFFICE_INTAKE を外す（既定は OFF）。
--      OFF のままなら、HR の画面・API は早期引き渡しの表を使わない（「Officeへ移動済み」タブ・ヒアリング・引き渡しは出ない）
--   2. 有効な（差し戻していない）早期引き渡しが無いか確かめる。あると、Office で手続き中の人の記録が消えるため、
--      この SQL は何も変えずに止まる：
--        select id, applicant_id, office_status, handed_at from public.gw_hr_office_intakes where returned_at is null;
--      → Office での手続きを終える（または差し戻しを記録する）か、旧フロー（HR で契約手続き）へ戻す方針を決めてから流す
--
-- ■ 消えるもの（データも消える。流す前に控えること）
--   社長判断の確定記録・条件ヒアリング（候補者希望・社内承認済みの給与を含む）・早期引き渡しとその履歴。
--     select * from public.gw_hr_ceo_decisions;
--     select * from public.gw_hr_hearings;
--     select * from public.gw_hr_hearing_pay;          -- 給与。控えの扱いに注意
--     select * from public.gw_hr_office_intakes;
--     select * from public.gw_hr_office_intake_events;
--   応募者の安全装置（gw_hr_applicants_guard）も外れる：契約の履歴がある応募者の削除・画面からの直接の
--   承諾済み／完了／社員の結びつけ／合格の書き込みは、DB では止まらなくなる（API の確かめは残る）。
--
-- ■ 残るもの
--   既存の表・列・制約・trigger（db/081・100・129・132・133・137・139）。gw_hr_applicants の decision・status、
--   gw_hr_offers（handoff_at・accepted_at・formal_signed_at）、社員登録（employee_id）には触らない
--   （db/143 はそれらを書き換えていないので、戻すものも無い）。
-- =============================================================================
begin;

do $$
begin
  if to_regclass('public.gw_hr_office_intakes') is not null
     and exists (select 1 from public.gw_hr_office_intakes where returned_at is null) then
    raise exception 'rollback_143: 有効な早期引き渡し（Office で手続き中）があります。記録が消えるため、何も変えずに止めます'
      using hint = 'select id, applicant_id, office_status, handed_at from public.gw_hr_office_intakes where returned_at is null;';
  end if;
end $$;

drop trigger if exists gw_hr_applicants_guard on public.gw_hr_applicants;
drop function if exists public.gw_hr_applicants_guard();

-- 参照される順の逆に消す（履歴 → 引き渡し → 給与 → ヒアリング → 社長判断）
drop table if exists public.gw_hr_office_intake_events;
drop table if exists public.gw_hr_office_intakes;
drop table if exists public.gw_hr_hearing_pay;
drop table if exists public.gw_hr_hearings;
drop table if exists public.gw_hr_ceo_decisions;

drop function if exists public.gw_hr_office_intake_events_check();
drop function if exists public.gw_hr_office_intakes_guard();
drop function if exists public.gw_hr_office_intakes_lock_hearing();
drop function if exists public.gw_hr_office_intakes_check();
drop function if exists public.gw_hr_hearing_pay_guard();
drop function if exists public.gw_hr_hearings_guard();
drop function if exists public.gw_hr_ceo_decisions_check();
drop function if exists public.gw_hr_has_active_intake(uuid, uuid);
drop function if exists public.gw_hr_applicant_contract_history(uuid);
drop function if exists public.gw_hr_append_only();
drop function if exists public.gw_hr_is_hire_decider(uuid, uuid);

commit;

notify pgrst, 'reload schema';
