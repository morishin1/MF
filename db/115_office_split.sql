-- =============================================================================
-- 115: Office の権限を業務ごとに分ける（人事・労務 officeHr／経理・事務 officeFinance）
--
-- ■ 何のためか
--   Office は1つのアプリだが、中の業務は担当で分かれる（lib/gw.js canOfficeHr / canOfficeFinance）。
--     人事・労務 … 管理者・経営者・人事（hr）
--     経理・事務 … 管理者・経営者・経理（finance）
--   これまで経費・月次・請求提出まで人事（hr）の権限で、経理（finance）は通れなかった。
--   API（lib/gw.js・各 api/*）は同じ基準にそろえた。この SQL は、DB（RLS）を同じ基準にそろえる。
--   API が ユーザーの権限（RLS）で読む表（経費・請求・月初提出・社内文書）は、ここを流さないと
--   経理が API を通っても、一覧が空・保存できない状態になる。
--
-- ■ 何をするか
--   1) gw_is_office_finance を新設 … 管理者（is_tenant_staff）・経営者（owner）・経理（finance）
--   2) 休暇・稟議（人事・労務）が使っていた gw_expense_can_review を、専用の gw_request_can_review に分ける
--        gw_request_can_review … これまでの gw_expense_can_review と同じ（管理者・人事・経営者）
--        申請の表（gw_requests・gw_leave_grants）はこちらを見る → 人事の権限は変わらない
--   3) gw_expense_can_review を 経理・事務の判定（gw_is_office_finance）に変える
--        経費の表（gw_expense_reports・gw_expense_lines）と領収書の置き場（storage の expense_files_rw）は、
--        この関数を見ているので、ポリシーは書き換えずに経理基準になる（人事は外れる）
--   4) 月次請求進捗（gw_billing_progress）・月初の提出リンク（gw_submission_links）に、経理の権限を足す
--   5) 社内文書（gw_library）・書類の雛形（gw_doc_templates）の編集を、人事から経理・事務へ
--        社員が読める公開済みの文書（published）は、これまでどおり全員が読める
--
-- ■ 変えないもの
--   gw_is_hr（人事の台帳・雇用契約・勤怠など、人事・労務の表）、gw_is_office（/office の読み取り＝経営者・責任者・経理）。
--   責任者（manager）は officeHr・officeFinance に含めない（/office の月末月初だけ。変更なし）。
--
-- ■ 適用の順番（重要）
--   この SQL を先に流し、そのあとアプリをデプロイする。
--   デプロイを先にすると、経理は API を通っても一覧が空になる／人事は経費を見られなくなる。
--   （2) 3) は同じトランザクションの中で、申請の人事権限を先に切り分けてから経費を切り替える。
--     途中で人事の休暇・稟議が見えなくなる時間は無い）
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 016（経費）・019（申請）・020（社内文書）・011（雛形）・077・080（請求）・099（gw_is_office）
-- =============================================================================

begin;

-- 1) 経理・事務の判定
create or replace function public.gw_is_office_finance(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_tenant_staff(p_tenant)
      or public.gw_has_role(p_tenant, 'owner')
      or public.gw_has_role(p_tenant, 'finance')
$$;

comment on function public.gw_is_office_finance(uuid) is
  'Office の経理・事務を使える人。管理者（is_tenant_staff）・経営者（owner）・経理（finance）。'
  '人事（hr）・責任者（manager）は含めない（db/115。lib/gw.js canOfficeFinance と同じ）';

-- 2) 休暇・稟議（人事・労務）の承認判定。これまでの gw_expense_can_review と同じ中身
create or replace function public.gw_request_can_review(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_tenant_staff(p_tenant)
      or public.gw_is_hr(p_tenant)
      or public.gw_has_role(p_tenant, 'owner')
$$;

comment on function public.gw_request_can_review(uuid) is
  '休暇・稟議を承認・全件閲覧できる人。管理者・人事・経営者（人事・労務。db/115。lib/expenses.js canReviewRequest と同じ）';

-- 申請の表は、専用の判定へ（人事の権限は変わらない）
drop policy if exists gw_requests_select on public.gw_requests;
create policy gw_requests_select on public.gw_requests
  for select
  using (
    public.gw_request_can_review(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_requests_update on public.gw_requests;
create policy gw_requests_update on public.gw_requests
  for update
  using (public.gw_request_can_review(tenant_id))
  with check (public.gw_request_can_review(tenant_id));

drop policy if exists gw_requests_delete on public.gw_requests;
create policy gw_requests_delete on public.gw_requests
  for delete
  using (public.gw_request_can_review(tenant_id));

drop policy if exists gw_leave_grants_select on public.gw_leave_grants;
create policy gw_leave_grants_select on public.gw_leave_grants
  for select
  using (
    public.gw_request_can_review(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

-- 3) 経費の承認判定を、経理・事務の基準へ（経費の表・領収書の置き場は、この関数を見ている）
create or replace function public.gw_expense_can_review(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_is_office_finance(p_tenant)
$$;

comment on function public.gw_expense_can_review(uuid) is
  '経費を承認・全件閲覧できる人。管理者・経営者・経理（経理・事務。db/115。lib/expenses.js canReviewExpense と同じ）。'
  '以前は人事（hr）も含んでいた';

-- 4) 請求（経理・事務）。月次請求進捗の読み書きと、月初の提出リンクの読み取り
drop policy if exists gw_billing_progress_finance on public.gw_billing_progress;
create policy gw_billing_progress_finance on public.gw_billing_progress
  for all
  using (public.gw_is_office_finance(tenant_id))
  with check (public.gw_is_office_finance(tenant_id));

drop policy if exists gw_submission_links_finance on public.gw_submission_links;
create policy gw_submission_links_finance on public.gw_submission_links
  for select using (public.gw_is_office_finance(tenant_id));

-- 5) 社内文書・書類の雛形の編集を、人事から経理・事務へ
drop policy if exists gw_doc_templates_select on public.gw_doc_templates;
create policy gw_doc_templates_select on public.gw_doc_templates
  for select
  using (public.gw_is_office_finance(tenant_id));

drop policy if exists gw_doc_templates_write on public.gw_doc_templates;
create policy gw_doc_templates_write on public.gw_doc_templates
  for all
  using (public.gw_is_office_finance(tenant_id))
  with check (public.gw_is_office_finance(tenant_id));

drop policy if exists gw_library_select on public.gw_library;
create policy gw_library_select on public.gw_library
  for select
  using (
    public.gw_is_office_finance(tenant_id)
    or (published and public.gw_employee_id(tenant_id) is not null)
  );

drop policy if exists gw_library_write on public.gw_library;
create policy gw_library_write on public.gw_library
  for all
  using (public.gw_is_office_finance(tenant_id))
  with check (public.gw_is_office_finance(tenant_id));

commit;

notify pgrst, 'reload schema';

-- 確認1（適用後・ログインした状態で）: 自分がどの業務に入れるか
--
--   select public.gw_is_hr(tenant_id)             as office_hr,       -- 人事・労務（hr・owner・管理者）
--          public.gw_is_office_finance(tenant_id) as office_finance,  -- 経理・事務（finance・owner・管理者）
--          public.gw_is_office(tenant_id)         as office_app,      -- /office（owner・manager・finance）
--          display_name
--     from public.gw_employees where user_id = auth.uid();
--
-- 確認2（適用後）: 経費の判定が経理基準、申請の判定が人事基準になっているか
--
--   select public.gw_expense_can_review(tenant_id) as expense,  -- 人事（hr）だけの人は false
--          public.gw_request_can_review(tenant_id) as request   -- 人事（hr）は true
--     from public.gw_employees where user_id = auth.uid();
