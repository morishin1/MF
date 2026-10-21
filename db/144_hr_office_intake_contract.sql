-- =============================================================================
-- 144: 採用HR → Office の早期引き渡し（db/143）を、Office の契約手続き（PR B）とつなぐ安全装置
--
-- ■ 運用の正本（docs/hr-office-handoff.md「Office の手続き（PR B）」・docs/hr-contract-procedure.md）
--   早期引き渡しを受けた人の契約手続き（採用条件の版・社労士・正式PDF・本人の同意・LegalSign・社員登録へ進める準備）は
--   Office の人事・労務が、HR と同じ表（gw_hr_offers・db/139）と同じ処理で進める。新しい契約の表は作らない。
--
-- ■ 作るもの（新しい表・列は無い。trigger 2つと関数2つだけ。既存の表・列・制約・trigger・データは変えない）
--   1) gw_hr_office_intakes_link（before update）… 引き渡しの次の書き込みを DB でも止める（service role でも）
--        ・offer_id（引き渡しと版を結ぶ）は、同じ会社・同じ応募者の版だけ
--        ・完了（completed）は、社員登録（gw_hr_applicants.employee_id）のあとだけ
--        ・辞退・不成立（withdrawn）は、社員登録の前だけ
--        ・差し戻し（returned_at）は、その応募者に採用条件の版（gw_hr_offers）が1つも無いときだけ
--          （版を作ったあとは辞退・不成立として記録する。差し戻すと旧フローへ戻ってしまうため）
--   2) gw_hr_offers_intake_guard（before insert / update）… 画面から直接（authenticated。PostgREST）は、
--        Office へ引き渡し済み（差し戻していない引き渡しがある）応募者の版を足せない・変えられない。
--        HR の API は 409 で止めるが、RLS（gw_is_recruiting）は採用担当に書き込みを許しているので DB でも止める。
--        サーバ（service role）の流れ＝ Office の API・本人の承諾（api/hr/offers/public.js）は止めない。
--
-- ■ 適用の順番
--   db/check_143_hr_office_intake.sql で ❌ が無いこと → この SQL → db/check_144_hr_office_intake_contract.sql で ❌ が無いこと → アプリ。
--   アプリ側は環境変数 HR_OFFICE_INTAKE=1 のときだけ新フローを使う（既定は OFF）。
--   戻すときは db/rollback_144_hr_office_intake_contract.sql（db/143 を戻すときは、先にこちらを戻す）。
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 0) 前提が無ければ止まる（何も変えない）
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_hr_office_intakes') is null or to_regclass('public.gw_hr_hearings') is null then
    raise exception 'db/144: gw_hr_office_intakes がありません（先に db/143_hr_office_intake.sql）。何も変更していません';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'doc_route') then
    raise exception 'db/144: gw_hr_offers.doc_route がありません（先に db/139_hr_contract_procedure.sql）。何も変更していません';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1) 引き渡しの次の書き込み（版との結びつけ・完了・辞退／不成立・差し戻し）
-- -----------------------------------------------------------------------------
create or replace function public.gw_hr_office_intakes_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  emp uuid;
begin
  if new.offer_id is not null and new.offer_id is distinct from old.offer_id
     and not exists (select 1 from public.gw_hr_offers o
                      where o.id = new.offer_id and o.tenant_id = new.tenant_id and o.applicant_id = new.applicant_id) then
    raise exception 'gw_hr_office_intakes.offer_id は、同じ会社・同じ応募者の版だけを結べます（db/144）' using errcode = '23514';
  end if;
  select a.employee_id into emp from public.gw_hr_applicants a where a.id = new.applicant_id and a.tenant_id = new.tenant_id;
  if new.office_status = 'completed' and old.office_status is distinct from 'completed' and emp is null then
    raise exception 'gw_hr_office_intakes: 入社完了は社員登録のあとだけです（db/144）' using errcode = '23514';
  end if;
  if new.office_status = 'withdrawn' and old.office_status is distinct from 'withdrawn' and emp is not null then
    raise exception 'gw_hr_office_intakes: 社員登録が済んだ人は辞退・不成立にできません（退社の手続きで進めます）（db/144）' using errcode = '23514';
  end if;
  if new.returned_at is not null and old.returned_at is null then
    if new.offer_id is not null or exists (select 1 from public.gw_hr_offers o where o.applicant_id = new.applicant_id) then
      raise exception 'gw_hr_office_intakes: 採用条件の版を作ったあとは差し戻せません（辞退・不成立として記録します）（db/144）' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

comment on function public.gw_hr_office_intakes_link() is
  '採用HR：引き渡しと版は同じ応募者だけ結ぶ。完了は社員登録のあと・辞退は社員登録の前・差し戻しは版を作る前だけ（db/144）';

drop trigger if exists gw_hr_office_intakes_link on public.gw_hr_office_intakes;
create trigger gw_hr_office_intakes_link
  before update on public.gw_hr_office_intakes
  for each row execute function public.gw_hr_office_intakes_link();

-- -----------------------------------------------------------------------------
-- 2) Office へ引き渡し済みの人の版は、画面から直接（authenticated）は書けない
--    security definer にしない（current_user で「画面から直接か・サーバか」を見るため。db/143 gw_hr_applicants_guard と同じ）
-- -----------------------------------------------------------------------------
create or replace function public.gw_hr_offers_intake_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if public.gw_hr_has_active_intake(new.tenant_id, new.applicant_id) then
    raise exception 'gw_hr_offers: Office へ引き渡し済みの応募者の採用条件・契約は、Office の手続きで進めます（db/144）'
      using errcode = '42501', hint = 'Office 人事・労務の「HRからの引き継ぎ」から操作します（HR では見るだけです）';
  end if;
  return new;
end $$;

comment on function public.gw_hr_offers_intake_guard() is
  '採用HR：Office へ早期引き渡し済みの応募者の版を、画面から直接（authenticated）足したり変えたりさせない（db/144）';

drop trigger if exists gw_hr_offers_intake_guard on public.gw_hr_offers;
create trigger gw_hr_offers_intake_guard
  before insert or update on public.gw_hr_offers
  for each row execute function public.gw_hr_offers_intake_guard();

commit;

notify pgrst, 'reload schema';
