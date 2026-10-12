-- =============================================================================
-- 133: 採用HR：正式契約の要否・承諾を確認して Office へ引き渡す（gw_hr_offers に3列を足す）
--
-- ■ 何をするか（列を足すだけ。既存の行・既存の列・ステータス・db/132 の trigger/function は変えない）
--   1 offer version（gw_hr_offers の1行）＝ 1条件通知書 ＝ 1承諾記録 ＝ 1正式契約 ＝ 1引き渡し（db/132 の考え方のまま）。
--     formal_contract_required … このオファーで正式契約（LegalSign）が必要か。オファーごとに確定する
--                                （区分の既定：正社員・幹部候補／業務委託／パート・アルバイト／スポット・副業 = true、育成枠 = false。
--                                  区分だけで固定せず、送る前ならオファーごとに 必要／不要 を変えられる）
--     handoff_at                … HR が承諾内容を確認して Office へ引き渡した日時
--     handoff_by                … 引き渡した人（auth.users）
--   「Office へ引き渡す」＝ Office 担当者の入社準備キューに載せること。本人に Office の管理権限を与える意味ではない。
--   引き渡しただけでは社員にしない（社員名簿・アカウントは、Office 側で既存の社員登録を使って作る）。
--
-- ■ 正式契約の要否（formal_contract_required）
--   ・区分のあるオファーには必ず入る（CHECK）。アプリが渡さなければ、区分の既定で入れる（BEFORE INSERT の trigger）
--   ・この SQL を流した時点の既存の行は、区分の既定で埋める（区分の無い古い合格通知は空のまま）
--   ・本人へ送ったあと（sent_at・notice_pdf_path・accepted_at のどれかがある）は変えられない
--     （条件通知書PDFに、正式契約の有無を書いて送るため。service role でも同じ）
--
-- ■ 引き渡せる版（CHECK 制約。service role でも同じ。API も同じ条件で止める）
--   ・本人が承諾した版だけ（accepted_at がある・辞退していない・無効化されていない）
--   ・正式契約が必要な版（formal_contract_required = true）は、正式契約済み（formal_signed_at）になってから
--   ・正式契約が不要な版（false）は、条件承諾済みのまま、HR の確認で引き渡せる
--   ・育成枠（offer_type = training）・区分の無い古い合格通知は引き渡さない（育成枠は LMS・育成開始へ進む）
--   ・日時と人は、必ずそろって入る
--
-- ■ 書き換えさせない（API だけでなく DB でも止める）
--   handoff_at・handoff_by は、一度入ったら変更も削除（null へ戻す）もできない（trigger。service role でも同じ）。
--   db/132 の gw_hr_offers_lock_documents には手を入れず、db/133 専用の関数・trigger で止める。
--   handoff_by の人（auth.users）は、引き渡しの記録があるかぎり削除できない（on delete restrict。記録を消さないため）。
--
-- ■ 権限
--   既存の表に列を足すだけなので、RLS・ポリシーは変えない（081 のまま）。
--
-- ■ 適用の順番
--   この SQL → アプリのデプロイ。デプロイが先でも、これまでの流れ（条件承諾・LegalSign・本採用へ進める）は動く
--   （正式契約の要否は区分の既定で扱い、［承諾を確認してOfficeへ引き渡す］と Office の「HRから引き渡し」だけが
--     「db/133 を流してください」と出る）。
--
-- ■ 番号
--   128・129・130・132 は本番適用済み。131 は開いている PR #105（AI営業）が使う。
--
-- 実行方法: Supabase の SQL Editor に、このファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 081（gw_hr_offers）・129（offer_type）・132（条件通知書・承諾記録・LegalSign の列）
-- 確認: 流したあと db/check_133_hr_offer_handoff.sql を Run（1つの表で ✅／❌ を見る。読み取りだけ）
-- 戻す: db/rollback_133_hr_offer_handoff.sql（列ごと消える。本番で流す前に必ず確認）
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_hr_offers') is null then
    raise exception 'gw_hr_offers がありません。先に db/081_hr_recruiting.sql を流してください';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'formal_signed_at') then
    raise exception 'gw_hr_offers.formal_signed_at がありません。先に db/132_hr_offer_documents.sql を流してください';
  end if;
end $$;

alter table public.gw_hr_offers
  add column if not exists formal_contract_required boolean,
  add column if not exists handoff_at timestamptz,
  add column if not exists handoff_by uuid references auth.users(id) on delete restrict;

-- 既存の行の正式契約の要否を、区分の既定で埋める（書き換え防止の trigger を一度外してから。区分の無い古い合格通知は空のまま）
drop trigger if exists gw_hr_offers_lock_handoff on public.gw_hr_offers;
update public.gw_hr_offers
   set formal_contract_required = (offer_type <> 'training')
 where formal_contract_required is null and offer_type is not null;

-- 値の形・引き渡せる版（既存の行は handoff_at が空なので、そのまま満たす）
do $$
begin
  -- 区分のあるオファーは、正式契約の要否が必ず決まっている
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_formal_required_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_formal_required_chk
      check (offer_type is null or formal_contract_required is not null);
  end if;
  -- 日時と人は、必ずそろって入る
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_handoff_pair_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_handoff_pair_chk
      check ((handoff_at is null) = (handoff_by is null));
  end if;
  -- 本人が承諾した版だけ（辞退・無効化した版は引き渡さない。引き渡した版は無効化・辞退にできない）
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_handoff_accepted_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_handoff_accepted_chk
      check (handoff_at is null or (accepted_at is not null and declined_at is null and revoked_at is null));
  end if;
  -- 正式契約が必要な版は、正式契約済みになってから。不要な版は承諾のまま（要否が決まっていない版は引き渡さない）
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_handoff_formal_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_handoff_formal_chk
      check (handoff_at is null
             or (formal_contract_required is not null and (formal_contract_required = false or formal_signed_at is not null)));
  end if;
  -- 育成枠・区分の無い古い合格通知は、Office へ引き渡さない（育成枠は LMS・育成開始へ）
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_handoff_type_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_handoff_type_chk
      check (handoff_at is null or (offer_type is not null and offer_type <> 'training'));
  end if;
end $$;

-- Office の「HRから引き渡し」の一覧（引き渡した版だけ）
create index if not exists idx_gw_hr_offers_handoff
  on public.gw_hr_offers(tenant_id, handoff_at desc) where handoff_at is not null;

-- 正式契約の要否の既定（アプリが渡さなかったときだけ、区分の既定で入れる）
create or replace function public.gw_hr_offers_formal_default()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.formal_contract_required is null and new.offer_type is not null then
    new.formal_contract_required := (new.offer_type <> 'training');
  end if;
  return new;
end $$;

comment on function public.gw_hr_offers_formal_default() is
  '採用HR：正式契約の要否が渡されなかったオファーに、区分の既定（育成枠だけ false）を入れる（db/133）';

drop trigger if exists gw_hr_offers_formal_default on public.gw_hr_offers;
create trigger gw_hr_offers_formal_default
  before insert on public.gw_hr_offers
  for each row execute function public.gw_hr_offers_formal_default();

-- 一度入ったら変えさせない（db/132 の関数とは別。db/132 の trigger・function は変えない）
create or replace function public.gw_hr_offers_lock_handoff()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.handoff_at is not null and new.handoff_at is distinct from old.handoff_at then
    raise exception 'gw_hr_offers.handoff_at は確定後に変更できません（db/133）'
      using errcode = '55000', hint = 'Office へ引き渡した記録は書き換えられません';
  end if;
  if old.handoff_by is not null and new.handoff_by is distinct from old.handoff_by then
    raise exception 'gw_hr_offers.handoff_by は確定後に変更できません（db/133）'
      using errcode = '55000', hint = 'Office へ引き渡した記録は書き換えられません';
  end if;
  -- 正式契約の要否は、本人へ送ったら変えない（条件通知書PDFに書いて送っているため）
  if (old.sent_at is not null or old.notice_pdf_path is not null or old.accepted_at is not null)
     and new.formal_contract_required is distinct from old.formal_contract_required then
    raise exception 'gw_hr_offers.formal_contract_required はオファー送付後に変更できません（db/133）'
      using errcode = '55000', hint = '本人へ送った条件通知書の正式契約の要否は変えられません';
  end if;
  return new;
end $$;

comment on function public.gw_hr_offers_lock_handoff() is
  '採用HR：Office へ引き渡した記録（handoff_at・handoff_by）は一度入ったら、正式契約の要否は本人へ送ったら、変えさせない（db/133）';

create trigger gw_hr_offers_lock_handoff
  before update on public.gw_hr_offers
  for each row execute function public.gw_hr_offers_lock_handoff();

comment on column public.gw_hr_offers.formal_contract_required is
  'このオファーで正式契約（LegalSign）が必要か。区分の既定（育成枠だけ false）。送る前だけ変えられる（db/133）';
comment on column public.gw_hr_offers.handoff_at is
  'HR が承諾内容を確認して Office へ引き渡した日時。承諾した版だけ・正式契約が必要な版は正式契約済みのあと・育成枠は不可。一度入ったら変えない（db/133）';
comment on column public.gw_hr_offers.handoff_by is
  'Office へ引き渡した人。一度入ったら変えない（db/133）';

commit;

notify pgrst, 'reload schema';

-- ■ 確認：db/check_133_hr_offer_handoff.sql を Supabase の SQL Editor で Run（読み取りだけ）
