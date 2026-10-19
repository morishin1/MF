-- =============================================================================
-- 140: /sales 提案管理の起点を「マッチング確定」にする（提案待ち・提案準備・提案送信を分ける）
--
-- ■ 何が変わるか（docs/sales-proposals.md）
--   これまで：dx.enger で企業向けの提案メールを送った（T0）ときに起票 → すぐ「電話待ち」＋30分以内の電話
--   これから：dx.enger の提案管理でマッチングが確定した（案件×人材の組を登録した）ときに起票
--             → 「マッチング済み・提案待ち」＋営業担当の「提案準備」タスク（Slack・ベルで即時通知）
--             → 企業へ提案を送ったら「電話待ち」へ進め、送った時刻から30分以内の電話タスクを作る
--   マッチング確定と企業への提案送信は別の事実として持つ。まだ企業へ提案していない段階で
--   「30分以内に電話」の期限を始めない。
--
-- ■ 変えるもの（db/138 の表に足す・制約を広げる。データは消さない）
--   gw_sales_proposals
--     ・matched_at（マッチング確定の日時）・slack_notified_at（Slack に知らせた日時。同じ提案で2回流さない）を足す
--     ・sent_at（企業へ提案を送った日時）は、提案待ちの間は空にできる（NOT NULL を外す）
--     ・状態に proposal_wait（マッチング済み・提案待ち）を足す
--     ・提案待ちは sent_at が空・起点（matched_at か sent_at）は必ずある（CHECK）
--     ・sent_at は「空 → 日時」の1回だけ入れられる。入ったあとは変えられない。matched_at も同じ（トリガー）
--   gw_sales_proposal_activities … 記録の種類に matched（マッチング確定）を足す
--   gw_sales_proposal_tasks      … タスクの種類に prepare（提案準備）を足す
--   gw_sales_proposal_settings   … slack_members（社員ID → Slack のメンバーID。メンションに使う）を足す
--
-- ■ 既存の行
--   db/138 のときに起票した提案（送った時点で起票・sent_at あり）はそのまま。matched_at は空のまま。
--
-- 何度流しても同じ結果になる。前提：db/138 が適用済み（無ければ何も変えずに止まる）。
-- 戻すとき：db/rollback_140_sales_proposal_matching.sql（提案待ちの提案が残っていると止まる）
-- 確認：db/check_140_sales_proposal_matching.sql（❌ が無いこと）
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0) 前提が無ければ止まる
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_sales_proposals') is null or to_regclass('public.gw_sales_proposal_tasks') is null
     or to_regclass('public.gw_sales_proposal_activities') is null or to_regclass('public.gw_sales_proposal_settings') is null then
    raise exception 'db/140: 提案管理の表がありません（先に db/138_sales_proposals.sql を適用してください）。何も変更していません';
  end if;
  if to_regprocedure('public.gw_sales_proposals_guard()') is null then
    raise exception 'db/140: gw_sales_proposals_guard がありません（先に db/138 を適用してください）。何も変更していません';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1) 提案：マッチング確定・Slack の通知済み・提案待ち
-- -----------------------------------------------------------------------------
alter table public.gw_sales_proposals add column if not exists matched_at timestamptz;          -- マッチング確定（起票の起点）
alter table public.gw_sales_proposals add column if not exists slack_notified_at timestamptz;   -- Slack に知らせた（同じ提案で2回流さない）
alter table public.gw_sales_proposals alter column sent_at drop not null;                      -- 企業へ提案を送るまでは空

comment on column public.gw_sales_proposals.matched_at is
  'dx.enger の提案管理でマッチングが確定した日時（案件×人材の組を登録した）。起票の起点。db/138 のときの提案は空（db/140）';
comment on column public.gw_sales_proposals.sent_at is
  '企業へ提案を送った日時（T0）。30分以内の電話・経過日数はここから数える。提案待ちの間は空。空 → 日時の1回だけ入る（db/140）';
comment on column public.gw_sales_proposals.slack_notified_at is
  'Slack に起票を知らせた日時。先に入れた1件だけが送る（同じ提案で2回流さない）（db/140）';

-- 状態に proposal_wait を足す（db/138 の列の CHECK は名前が付いていないので、既定の名前で外して付け直す）
alter table public.gw_sales_proposals drop constraint if exists gw_sales_proposals_status_check;
alter table public.gw_sales_proposals drop constraint if exists gw_sales_proposals_status_chk;
alter table public.gw_sales_proposals add constraint gw_sales_proposals_status_chk check (status in (
  'proposal_wait',    -- マッチング済み・提案待ち（まだ企業へ提案していない）
  'call_wait', 'mail_wait', 'reply_wait', 'meeting_adjust', 'meeting_done', 'considering', 'reproposal',
  'won', 'lost', 'stopped', 'closed_no_reply'
));
-- 提案待ちは、まだ企業へ送っていない
alter table public.gw_sales_proposals drop constraint if exists gw_sales_proposals_wait_chk;
alter table public.gw_sales_proposals add constraint gw_sales_proposals_wait_chk
  check (status <> 'proposal_wait' or sent_at is null);
-- 起点（マッチング確定か提案送信）は必ずある
alter table public.gw_sales_proposals drop constraint if exists gw_sales_proposals_start_chk;
alter table public.gw_sales_proposals add constraint gw_sales_proposals_start_chk
  check (sent_at is not null or matched_at is not null);

create index if not exists idx_gw_sales_proposals_matched
  on public.gw_sales_proposals(tenant_id, matched_at desc) where matched_at is not null;

-- 書き込みの見張り（db/138 と同じ判定に、sent_at・matched_at の「空 → 日時の1回だけ」を足す）
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
       or new.source_proposal_id is distinct from old.source_proposal_id then
      raise exception 'gw_sales_proposals: テナント・連携元・連携キーは変えられません' using errcode = '23514';
    end if;
    -- 企業へ提案を送った日時・マッチング確定の日時は、空 → 日時の1回だけ（入ったあとは変えない・消さない）
    if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
      raise exception 'gw_sales_proposals: 送信日時は変えられません' using errcode = '23514';
    end if;
    if old.matched_at is not null and new.matched_at is distinct from old.matched_at then
      raise exception 'gw_sales_proposals: マッチング確定の日時は変えられません' using errcode = '23514';
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

-- -----------------------------------------------------------------------------
-- 2) 記録の種類に matched（マッチング確定）を足す
-- -----------------------------------------------------------------------------
alter table public.gw_sales_proposal_activities drop constraint if exists gw_sales_proposal_activities_kind_check;
alter table public.gw_sales_proposal_activities drop constraint if exists gw_sales_proposal_activities_kind_chk;
alter table public.gw_sales_proposal_activities add constraint gw_sales_proposal_activities_kind_chk check (kind in (
  'matched',       -- マッチング確定（dx.enger から）
  'sent', 'call', 'mail', 'reply', 'check', 'meeting', 'result', 'decision', 'assign', 'due_change', 'task', 'memo', 'contact', 'link', 'sync'
));

-- -----------------------------------------------------------------------------
-- 3) タスクの種類に prepare（提案準備）を足す
-- -----------------------------------------------------------------------------
alter table public.gw_sales_proposal_tasks drop constraint if exists gw_sales_proposal_tasks_kind_check;
alter table public.gw_sales_proposal_tasks drop constraint if exists gw_sales_proposal_tasks_kind_chk;
alter table public.gw_sales_proposal_tasks add constraint gw_sales_proposal_tasks_kind_chk check (kind in (
  'prepare',         -- 提案準備（提案内容を確認して企業へ提案する）。企業へ提案を送った記録で完了
  'call', 'mail', 'reply_check', 'refollow', 'manager_review', 'meeting_fix', 'meeting_result', 'manual'
));

-- -----------------------------------------------------------------------------
-- 4) 設定：Slack のメンバーID（社員ID → U… / W…）。メンションに使う。無ければ名前だけ出す
-- -----------------------------------------------------------------------------
alter table public.gw_sales_proposal_settings add column if not exists slack_members jsonb not null default '{}'::jsonb;
alter table public.gw_sales_proposal_settings drop constraint if exists gw_sales_proposal_settings_slack_chk;
alter table public.gw_sales_proposal_settings add constraint gw_sales_proposal_settings_slack_chk
  check (jsonb_typeof(slack_members) = 'object');
comment on column public.gw_sales_proposal_settings.slack_members is
  '社員ID → Slack のメンバーID（U0123ABCD）。起票の Slack 通知で営業担当をメンションする。無い人は名前だけ（db/140）';

commit;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- 確認用（流したあと。db/check_140_sales_proposal_matching.sql にまとめてある）
-- -----------------------------------------------------------------------------
-- select status, count(*) from public.gw_sales_proposals group by status order by 1;
-- 提案待ちのまま期限を過ぎた提案準備
-- select p.company_name, t.due_at from public.gw_sales_proposal_tasks t join public.gw_sales_proposals p on p.id = t.proposal_id
--  where t.kind = 'prepare' and t.status = 'open' and t.due_at < now() order by t.due_at;
