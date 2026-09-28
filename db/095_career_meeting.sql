-- =============================================================================
-- 095: 契約・キャリア面談（本人への確認依頼と、本人の「確認しました」）
--
-- ■ 何をするものか
--   管理画面（admin-career.html）の「契約・キャリア面談を開始」から
--     現在の契約 → 現在地 → 1年後/3年後 → 次のLevel → 本人へ確認依頼
--   を1本で進め、本人は career.html で「内容を確認しました」を押す。
--
-- ■ 新しい表は作らない
--   進み具合（未設定・面談準備・契約準備・本人確認待ち・署名待ち・開始・評価時期）は
--   既存のデータから毎回計算する（lib/career.js flowOf）。
--     契約準備   … gw_doc_orders（requested / uploaded）
--     署名待ち   … gw_sign_requests（sent）
--     評価時期   … gw_employee_careers.next_review_on・gw_career_reviews（draft）
--   ここで足すのは、既存のどこにも無い「確認を頼んだ日時」と「本人が確認した日時」だけ。
--   gw_employee_careers に列を足す（1人につき active は1行なので、それで足りる）。
--
-- ■ キャリアの確認は法的な署名ではない
--   契約書は 046/056 の電子署名（gw_sign_requests）。キャリアプランは本人の「確認しました」だけ。
--   キャリアプランを雇用契約書に混ぜない。給与もここには持たない（gw_contracts の active を読む）。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 092_career.sql
-- =============================================================================

begin;

alter table public.gw_employee_careers
  add column if not exists confirm_requested_at timestamptz;
alter table public.gw_employee_careers
  add column if not exists confirm_requested_by uuid references auth.users(id) on delete set null;
alter table public.gw_employee_careers
  add column if not exists employee_confirmed_at timestamptz;

comment on column public.gw_employee_careers.confirm_requested_at is
  '本人へキャリアプランの確認を依頼した日時。employee_confirmed_at がこれより前（または空）なら本人確認待ち';
comment on column public.gw_employee_careers.employee_confirmed_at is
  '本人が「内容を確認しました」を押した日時。法的な電子署名ではない（契約書の署名は gw_sign_requests）';

commit;

notify pgrst, 'reload schema';

-- 確認:
--   select employee_id, confirm_requested_at, employee_confirmed_at
--     from public.gw_employee_careers where is_active order by confirm_requested_at desc nulls last;
