// Sales営業のバトンタッチ：提案→CS→クロージング、CSの進行判断、Slack再共有。
// 引継ぎの本体は db/141 のトランザクションRPC。RLS/テナント・所有者チェックはDB側でも再検証。
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import { canManageProposals, isUuid, isClosed, readWhen } from "../../../lib/sales-proposals.js";
import { loadProposal, loadPeople, loadSettingsRow, SQL_FILE } from "../../../lib/sales-proposals-db.js";
import { notifyCsDecisionShared, notifyHandoffShared } from "../../../lib/sales-proposal-handoff-slack.js";

const DECISIONS = ["advance", "needs_detail", "hold", "decline"];
const clean = (v, n) => String(v ?? "").trim().slice(0, n);
const errorText = (e) => String(e?.message || "");
const dbError = (res, e) => {
  const setup = dbSetupHint(e, SQL_FILE + "・db/141_sales_cs_closing_handoff.sql");
  if (setup) return json(res, 503, { error: "not_ready", hint: "db/141を適用してください" });
  const message = errorText(e);
  if (/cs_contact_required|cs_approval_required|invalid_handoff_transition|target_not_in_configured_team|proposal_not_active/.test(message))
    return json(res, 409, { error: "handoff_blocked", hint: message });
  return json(res, e?.code === "42501" ? 403 : e?.code === "23514" ? 409 : 500,
    { error: e?.code === "42501" ? "forbidden" : "db_failed", hint: e?.code === "23514" ? message : "保存できませんでした" });
};

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", field: "id" });
  const sb = userClient(req);
  const { proposal, error: e0 } = await loadProposal(sb, ctx.tenantId, body.id);
  if (e0) return dbError(res, e0);
  if (!proposal) return json(res, 404, { error: "not_found" });
  const me = ctx.employee?.id || null;
  const manager = canManageProposals(ctx);
  if (!me || me !== proposal.sales_owner_id || proposal.archived_at)
    return json(res, 403, { error: "readonly", hint: "引継ぎできるのは現在の担当者本人です" });
  const action = clean(body.action, 30);
  const priv = admin();

  if (action === "transfer") {
    if (isClosed(proposal.status) || !proposal.sent_at)
      return json(res, 409, { error: "not_sent_or_closed", hint: "企業へ提案送信済みで対応中の案件のみ引き継げます" });
    const toStage = clean(body.toStage, 30);
    if (!["cs", "closing"].includes(toStage) || !isUuid(body.ownerId))
      return json(res, 400, { error: "invalid_body", hint: "段階と引継ぎ先を選んでください" });
    const reason = clean(body.reason, 500);
    const nextAction = clean(body.nextAction, 500);
    const decision = clean(body.decision, 30);
    const nextAt = readWhen(body.nextAt);
    if (!reason || !nextAction || !["advance", "needs_detail", "hold", "other"].includes(decision) || nextAt === undefined)
      return json(res, 400, { error: "invalid_body", hint: "判断・引継ぎ理由・次のアクションを記入してください" });
    const { data: handoffId, error } = await sb.rpc("gw_sales_transfer_proposal_owner", {
      p_proposal: proposal.id, p_to_stage: toStage, p_to_owner: body.ownerId,
      p_reason: reason, p_decision: decision, p_next_action: nextAction, p_next_at: nextAt,
    });
    if (error) return dbError(res, error);
    const people = await loadPeople(ctx.tenantId);
    const settingsRow = await loadSettingsRow(priv, ctx.tenantId);
    const shared = await notifyHandoffShared(priv, {
      tenantId: ctx.tenantId, handoffId, settingsRow, employees: people.employees,
    });
    await notify([{ tenantId: ctx.tenantId, employeeId: body.ownerId, kind: "sales",
      title: "提案の引継ぎ：" + proposal.company_name,
      body: "引継ぎ理由・判断・次の対応をSalesで確認してください。",
      link: "/sales/proposals.html?id=" + proposal.id,
      dedupeKey: "sales_handoff:" + handoffId }]);
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.proposal_handoff",
      target: "sales_proposal:" + proposal.id,
      detail: { handoffId, from: proposal.handoff_stage, to: toStage, toOwner: body.ownerId, decision } });
    return json(res, 200, { ok: true, handoffId, stage: toStage, slack: shared });
  }

  if (action === "cs_decision") {
    if (proposal.handoff_stage !== "cs" || !proposal.cs_owner_id || isClosed(proposal.status) || !proposal.sent_at)
      return json(res, 409, { error: "not_cs", hint: "CSへの引継ぎ後、担当者が一次対応の判断を記録してください" });
    const decision = clean(body.decision, 30);
    const reason = clean(body.reason, 500);
    const nextAction = clean(body.nextAction, 500);
    if (!DECISIONS.includes(decision) || !reason || !nextAction)
      return json(res, 400, { error: "invalid_body", hint: "判断・理由・次の対応をすべて記入してください" });
    // 「連絡できた」は電話の通話成功または企業からの返信という根拠が必要。
    const { data: connected, error: ec } = await sb.from("gw_sales_proposal_activities")
      .select("id, kind, result").eq("proposal_id", proposal.id)
      .in("kind", ["call", "reply"]).limit(500);
    if (ec) return dbError(res, ec);
    if (!(connected || []).some((a) => a.kind === "reply" || a.result === "connected"))
      return json(res, 409, { error: "not_connected", hint: "まず通話結果「通話できた」または企業からの返信を記録してください" });
    const { data: row, error: e1 } = await sb.from("gw_sales_proposal_activities").insert({
      tenant_id: ctx.tenantId, proposal_id: proposal.id, company_id: proposal.company_id,
      kind: "cs_decision", result: decision, occurred_at: new Date().toISOString(),
      employee_id: me, created_by: user.id, note: reason,
      detail: { nextAction },
    }).select("id").single();
    if (e1) return dbError(res, e1);
    const people = await loadPeople(ctx.tenantId);
    const settingsRow = await loadSettingsRow(priv, ctx.tenantId);
    const shared = await notifyCsDecisionShared(priv, { tenantId: ctx.tenantId,
      activityId: row.id, settingsRow, employees: people.employees });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.proposal_cs_decision",
      target: "sales_proposal:" + proposal.id, detail: { decision, activityId: row.id } });
    return json(res, 200, { ok: true, activityId: row.id, slack: shared });
  }

  if (action === "resend" && manager) {
    const settingsRow = await loadSettingsRow(priv, ctx.tenantId);
    const people = await loadPeople(ctx.tenantId);
    if (isUuid(body.handoffId)) {
      const s = await notifyHandoffShared(priv, { tenantId: ctx.tenantId, handoffId: body.handoffId,
        settingsRow, employees: people.employees });
      return json(res, 200, { ok: Boolean(s.sent || s.skipped === "already_sent"), slack: s });
    }
    if (isUuid(body.activityId)) {
      const s = await notifyCsDecisionShared(priv, { tenantId: ctx.tenantId, activityId: body.activityId,
        settingsRow, employees: people.employees });
      return json(res, 200, { ok: Boolean(s.sent || s.skipped === "already_sent"), slack: s });
    }
    return json(res, 400, { error: "invalid_body", hint: "再共有する引継ぎまたはCS判断を指定してください" });
  }
  return json(res, 400, { error: "unknown_action" });
}
