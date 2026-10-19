-- =============================================================================
-- db/140_sales_proposal_matching.sql のやり直し（起点を「提案送信」に戻す＝db/138 の形）
--
-- ■ 先にやること
--   1. dx.enger 側を、マッチング確定（proposal.matched）を送らない版へ戻す（送り続けると 400 になり、dx.enger の控えに失敗として残る）
--   2. アプリ（/sales）を 140 より前の版へ戻す
--   3. 提案待ちの提案を片付ける：企業へ提案を送ったものは「提案した」を記録（電話待ちへ進む）、
--      やめたものは「結果・状態」で見送り・連絡停止にする。送信日時の無い提案が残っていると、このやり直しは止まる
--
-- ■ 消えるもの
--   matched_at・slack_notified_at・slack_members の列（マッチング確定の日時・Slack の通知済みの印・Slack のメンバーID）。
--   行は消さない：マッチング確定の記録は「dx.enger からの更新」、提案準備のタスクは「手動タスク」として残す。
-- =============================================================================
begin;

do $$
declare
  n int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_sales_proposals' and column_name = 'matched_at') then
    raise notice 'db/140 は当たっていません（何もしません）';
    return;
  end if;
  select count(*) into n from public.gw_sales_proposals where sent_at is null;
  if n > 0 then
    raise exception 'rollback_140: 企業へまだ提案していない提案（送信日時が空）が % 件あります。提案した記録をつけるか、見送り等で閉じてから戻してください。何も変更していません', n;
  end if;
end $$;

-- 新しい種類の行は消さずに、db/138 にある種類へ写す（履歴は残す）
--   マッチング確定の記録 → dx.enger からの更新（sync）。提案準備のタスク → 手動タスク（manual）
update public.gw_sales_proposal_activities
   set kind = 'sync', note = coalesce('マッチング確定：' || note, 'マッチング確定（dx.enger）')
 where kind = 'matched';
update public.gw_sales_proposal_tasks set kind = 'manual' where kind = 'prepare';

alter table public.gw_sales_proposal_tasks drop constraint if exists gw_sales_proposal_tasks_kind_chk;
alter table public.gw_sales_proposal_tasks drop constraint if exists gw_sales_proposal_tasks_kind_check;
alter table public.gw_sales_proposal_tasks add constraint gw_sales_proposal_tasks_kind_check check (kind in (
  'call', 'mail', 'reply_check', 'refollow', 'manager_review', 'meeting_fix', 'meeting_result', 'manual'));

alter table public.gw_sales_proposal_activities drop constraint if exists gw_sales_proposal_activities_kind_chk;
alter table public.gw_sales_proposal_activities drop constraint if exists gw_sales_proposal_activities_kind_check;
alter table public.gw_sales_proposal_activities add constraint gw_sales_proposal_activities_kind_check check (kind in (
  'sent', 'call', 'mail', 'reply', 'check', 'meeting', 'result', 'decision', 'assign', 'due_change', 'task', 'memo', 'contact', 'link', 'sync'));

alter table public.gw_sales_proposals drop constraint if exists gw_sales_proposals_wait_chk;
alter table public.gw_sales_proposals drop constraint if exists gw_sales_proposals_start_chk;
alter table public.gw_sales_proposals drop constraint if exists gw_sales_proposals_status_chk;
alter table public.gw_sales_proposals drop constraint if exists gw_sales_proposals_status_check;
alter table public.gw_sales_proposals add constraint gw_sales_proposals_status_check check (status in (
  'call_wait', 'mail_wait', 'reply_wait', 'meeting_adjust', 'meeting_done', 'considering', 'reproposal',
  'won', 'lost', 'stopped', 'closed_no_reply'));
alter table public.gw_sales_proposals alter column sent_at set not null;
drop index if exists public.idx_gw_sales_proposals_matched;
alter table public.gw_sales_proposals drop column if exists matched_at;
alter table public.gw_sales_proposals drop column if exists slack_notified_at;

alter table public.gw_sales_proposal_settings drop constraint if exists gw_sales_proposal_settings_slack_chk;
alter table public.gw_sales_proposal_settings drop column if exists slack_members;

-- 見張りを db/138 の形に戻す（送信日時はあとから変えられない）
create or replace function public.gw_sales_proposals_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid;
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id is distinct from old.tenant_id
       or new.source_system is distinct from old.source_system
       or new.source_proposal_id is distinct from old.source_proposal_id
       or new.sent_at is distinct from old.sent_at then
      raise exception 'gw_sales_proposals: テナント・連携元・連携キー・送信日時は変えられません' using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  if new.sales_owner_id is not null
     and (tg_op = 'INSERT' or new.sales_owner_id is distinct from old.sales_owner_id)
     and not public.gw_sales_employee_ok(new.sales_owner_id, new.tenant_id) then
    raise exception 'gw_sales_proposals: 営業担当が同じテナントの在籍中の社員ではありません' using errcode = '23503';
  end if;
  if new.company_id is not null and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id) then
    select tenant_id into v_tenant from public.gw_sales_companies where id = new.company_id;
    if v_tenant is null or v_tenant <> new.tenant_id then
      raise exception 'gw_sales_proposals: 企業が見つかりません' using errcode = '23503';
    end if;
  end if;
  return new;
end $$;

commit;

notify pgrst, 'reload schema';
