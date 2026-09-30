-- =============================================================================
-- 100: Office（/office）が読む表に、Office 権限の読み取りを足す／経営（/keiei）の判定を新設
--
-- ■ 何をするか
--   1) gw_is_keiei を新設する … 経営者（owner）だけ。責任者にも公開しない
--        gw_is_office / gw_is_recruiting / gw_is_sales とは別の条件。4つを混同しない
--        （lib/gw.js の canAccessKeiei と同じ。画面 /keiei はこれから作る）
--
--   2) Phase 2 の /office 一覧が読む表に、gw_is_office の「読み取りだけ」のポリシーを足す
--        gw_site_contracts   … 現場契約（客先・期間・区分）
--        gw_billing_progress … 月次請求進捗（勤務表受領〜BP請求書受領の印）
--        gw_submissions      … 届いた勤務表・請求書のファイル一覧
--        gw_partner_companies … BP 会社の名簿（会社名を出すため）
--
-- ■ /api/office/* は、ログインした人の権限（RLS）で読む
--   画面・API・DB の3か所を、同じ条件（経営者 OR 責任者 OR 経理）にそろえるため。
--   API の入口（canAccessOffice ＋ 二段階認証）を抜けても、DB が Office 権限のない人には返さない。
--   （gw_employees は、ここでは開けない。名簿には人事の機微が載っているので、
--     /api/office は氏名・区分・所属など必要な列だけを、API の判定のあとで読む）
--
-- ■ 既存の RLS は変えない（方針A）
--   上の4表の既存ポリシー（is_tenant_staff。月初作業管理の API が使う）は、そのまま残す。
--   足すのは Office 権限の読み取りだけで、書き込みは足さない。人事（hr）は増やさない：
--   人事が請求額・単価・仕入額まで見える方向には広げない。
--   月初作業管理を /office に統合するときに、既存ポリシーを Office 権限へ統一する
--   （そのとき、会計の管理者・人事が単価・請求額を見られなくなる点も確認する）。
--
-- ■ 適用の順番（重要）
--   099 → この 100 → アプリのデプロイ。
--   100 を先に流さずにデプロイすると、責任者・経理は /office を開けても、一覧が空になる
--   （/api/office は、その状態を検知して画面に知らせる）。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 075・076・077・080（上の4表）、099_access_hr_office.sql（gw_is_office）
-- =============================================================================

begin;

create or replace function public.gw_is_keiei(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'owner')
$$;

comment on function public.gw_is_keiei(uuid) is
  '経営（/keiei）を使える人。社内権限の owner（経営者）だけ。責任者・経理・人事・会計側の管理者にも公開しない'
  '（db/100。lib/gw.js canAccessKeiei と同じ）';

drop policy if exists gw_site_contracts_office_select on public.gw_site_contracts;
create policy gw_site_contracts_office_select on public.gw_site_contracts
  for select using (public.gw_is_office(tenant_id));

drop policy if exists gw_billing_progress_office_select on public.gw_billing_progress;
create policy gw_billing_progress_office_select on public.gw_billing_progress
  for select using (public.gw_is_office(tenant_id));

drop policy if exists gw_submissions_office_select on public.gw_submissions;
create policy gw_submissions_office_select on public.gw_submissions
  for select using (public.gw_is_office(tenant_id));

drop policy if exists gw_partner_companies_office_select on public.gw_partner_companies;
create policy gw_partner_companies_office_select on public.gw_partner_companies
  for select using (public.gw_is_office(tenant_id));

commit;

notify pgrst, 'reload schema';

-- 確認1（適用後・ログインした状態で）: 自分が Office・経営の権限を持つか
--
--   select public.gw_is_office(tenant_id) as office,
--          public.gw_is_keiei(tenant_id)  as keiei,
--          display_name
--     from public.gw_employees where user_id = auth.uid();
--
-- 確認2（適用後）: 足したポリシーが4つあるか（読み取りだけ）
--
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public' and policyname like '%\_office\_select' escape '\'
--    order by tablename;
