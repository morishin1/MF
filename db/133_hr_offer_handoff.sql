-- =============================================================================
-- 133: 採用HR：承諾を確認して Office へ引き渡す（gw_hr_offers に2列を足す）
--
-- ■ 何をするか（列を足すだけ。既存の行・既存の列・ステータス・db/132 の trigger/function は変えない）
--   HR が「本人が承諾した版（gw_hr_offers の1行）」を確認し、［承諾を確認してOfficeへ引き渡す］を押した記録。
--   1 offer version ＝ 1条件通知書 ＝ 1承諾記録 ＝ 1正式契約 ＝ 1引き渡し（db/132 の考え方のまま）。
--     handoff_at … Office へ引き渡した日時（＝HR が承諾内容を確認した日時）
--     handoff_by … 引き渡した人（auth.users）
--   「Office へ引き渡す」＝ Office 担当者の入社準備キューに載せること。本人に Office の管理権限を与える意味ではない。
--   引き渡しただけでは社員にしない（社員名簿・アカウントは、Office 側で既存の社員登録を使って作る）。
--
-- ■ 引き渡せる版（CHECK 制約。service role でも同じ）
--   ・本人が承諾した版だけ（accepted_at がある・辞退していない・無効化されていない）
--   ・正式契約（LegalSign）を使う版は、正式契約済み（formal_signed_at）になってから。
--     「正式契約が必要か」は区分で固定せず、その版の既存のデータで決める：
--       LegalSign の URL を登録した、または本人へ正式契約を案内した版（legalsign_url / formal_sent_at がある）
--       → 正式契約済みになるまで引き渡せない
--       LegalSign を使わない版（URL も案内も無い）→ 条件承諾済みのまま、HR の確認で引き渡せる
--     引き渡したあとに LegalSign を始めることもできない（URL を入れると、この制約で止まる）
--   ・日時と人は、必ずそろって入る
--   育成枠を引き渡さない（LMS・育成開始へ進む）のは API で止める（実案件・業務委託・雇用へ進むときの扱いを DB で縛らない）。
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
--   （［承諾を確認してOfficeへ引き渡す］と Office の「HRから引き渡し」だけが「db/133 を流してください」と出る）。
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
  add column if not exists handoff_at timestamptz,
  add column if not exists handoff_by uuid references auth.users(id) on delete restrict;

-- 引き渡せる版（既存の行は handoff_at が空なので、そのまま満たす）
do $$
begin
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
  -- LegalSign を使う版（URL を登録した・案内した）は、正式契約済みになってから
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_handoff_formal_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_handoff_formal_chk
      check (handoff_at is null or formal_signed_at is not null or (legalsign_url is null and formal_sent_at is null));
  end if;
end $$;

-- Office の「HRから引き渡し」の一覧（引き渡した版だけ）
create index if not exists idx_gw_hr_offers_handoff
  on public.gw_hr_offers(tenant_id, handoff_at desc) where handoff_at is not null;

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
  return new;
end $$;

comment on function public.gw_hr_offers_lock_handoff() is
  '採用HR：Office へ引き渡した記録（handoff_at・handoff_by）を、一度入ったら変えさせない（db/133）';

drop trigger if exists gw_hr_offers_lock_handoff on public.gw_hr_offers;
create trigger gw_hr_offers_lock_handoff
  before update on public.gw_hr_offers
  for each row execute function public.gw_hr_offers_lock_handoff();

comment on column public.gw_hr_offers.handoff_at is
  'HR が承諾内容を確認して Office へ引き渡した日時。承諾した版だけ・LegalSign を使う版は正式契約済みのあと。一度入ったら変えない（db/133）';
comment on column public.gw_hr_offers.handoff_by is
  'Office へ引き渡した人。一度入ったら変えない（db/133）';

commit;

notify pgrst, 'reload schema';

-- ■ 確認：db/check_133_hr_offer_handoff.sql を Supabase の SQL Editor で Run（読み取りだけ）
