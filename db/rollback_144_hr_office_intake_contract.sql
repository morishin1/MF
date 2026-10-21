-- =============================================================================
-- db/144_hr_office_intake_contract.sql のやり直し（早期引き渡しと Office の契約手続きをつなぐ安全装置を外す）
--
-- ■ 先にやること
--   アプリを db/144 より前の版へ戻すか、環境変数 HR_OFFICE_INTAKE を外す（既定は OFF）。
--   db/143 も戻すときは、この SQL を先に流す（db/143 の関数 gw_hr_has_active_intake を使っているため）。
--
-- ■ 消えるもの（データは消えない）
--   trigger 2つと関数2つだけ。外すと DB では次が止まらなくなる（API の確かめは残る）：
--     ・引き渡しに別の応募者の版を結ぶ／社員登録前の完了／社員登録後の辞退／版を作ったあとの差し戻し
--     ・Office へ引き渡し済みの人の版を、画面から直接（authenticated）足す・変える
--
-- ■ 残るもの
--   db/143 の表・データ（引き渡し・履歴・offer_id の値）と、既存の表・列・制約・trigger（db/081〜139）。
-- =============================================================================
begin;

drop trigger if exists gw_hr_offers_intake_guard on public.gw_hr_offers;
drop function if exists public.gw_hr_offers_intake_guard();

do $$
begin
  if to_regclass('public.gw_hr_office_intakes') is not null then
    execute 'drop trigger if exists gw_hr_office_intakes_link on public.gw_hr_office_intakes';
  end if;
end $$;
drop function if exists public.gw_hr_office_intakes_link();

commit;

notify pgrst, 'reload schema';
