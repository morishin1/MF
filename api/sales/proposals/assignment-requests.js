// Sales 提案の担当変更依頼と承認。実際の変更・履歴は db/143 のRPCで一括して保存する。
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { admin, userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import { canManageProposals, isUuid } from "../../../lib/sales-proposals.js";
import { loadPeople, loadProposal, salesMembers } from "../../../lib/sales-proposals-db.js";

const STAGES = new Set(["proposal", "cs", "closing"]);
const clean = (value, max) => String(value ?? "").trim().slice(0, max);

function fail(res, error) {
  if (dbSetupHint(error, "db/143_sales_proposal_assignment_requests.sql")) {
    return json(res, 503, { error: "not_ready", hint: "db/143 を適用してください" });
  }
  const message = String(error?.message || "");
  if (error?.code === "23505") return json(res, 409, { error: "request_pending", hint: "この段階には承認待ちの変更依頼があります" });
  if (error?.code === "23514" || /request_stale|request_not_pending|assignment_unchanged|request_not_needed|target_not_in_configured_team/.test(message)) {
    return json(res, 409, { error: "assignment_conflict", hint: "担当または設定が更新されています。画面を再読み込みしてください" });
  }
  if (error?.code === "42501") return json(res, 403, { error: "forbidden", hint: "この変更を確定する権限がありません" });
  return json(res, 500, { error: "db_failed", hint: "保存できませんでした" });
}

async function reviewRecipients(tenantId, { proposalId, stage, toOwnerId, requesterId, decision, companyName }) {
  const rows = [];
  if (requesterId) rows.push({
    tenantId, employeeId: requesterId, kind: "sales",
    title: decision === "approve" ? `担当変更が承認されました：${companyName}` : `担当変更が却下されました：${companyName}`,
    body: decision === "approve" ? "変更内容を提案管理で確認してください。" : "変更依頼への回答を提案管理で確認してください。",
    link: `/sales/proposals.html?id=${proposalId}`, dedupeKey: `sales_assignment_review:${proposalId}:${stage}:${Date.now()}`,
  });
  if (decision === "approve" && toOwnerId && toOwnerId !== requesterId) rows.push({
    tenantId, employeeId: toOwnerId, kind: "sales", title: `提案の担当になりました：${companyName}`,
    body: "提案管理で担当範囲と次の行動を確認してください。",
    link: `/sales/proposals.html?id=${proposalId}`, dedupeKey: `sales_assignment_approved:${proposalId}:${stage}:${Date.now()}`,
  });
  if (rows.length) await notify(rows);
}

async function managerIds(tenantId, people) {
  const sb = admin();
  const [{ data: roles }, { data: appUsers }, { data: staffMemberships }] = await Promise.all([
    sb.from("gw_role_grants").select("employee_id,role").eq("tenant_id", tenantId).in("role", ["owner", "manager"]),
    sb.from("gw_app_grants").select("employee_id").eq("tenant_id", tenantId).eq("app_key", "sales"),
    sb.from("memberships").select("user_id").eq("tenant_id", tenantId).in("role", ["admin", "staff"]),
  ]);
  const sales = new Set((appUsers || []).map((row) => row.employee_id));
  const owners = new Set((roles || []).filter((row) => row.role === "owner").map((row) => row.employee_id));
  const staffUsers = new Set((staffMemberships || []).map((row) => row.user_id));
  const staff = people.employees.filter((employee) => staffUsers.has(employee.user_id)).map((employee) => employee.id);
  return [...new Set([...(roles || []).map((row) => row.employee_id), ...staff])]
    .filter((id) => people.employees.some((employee) => employee.id === id && employee.status !== "left")
      && (sales.has(id) || owners.has(id)));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx) || !ctx.employee?.id) return json(res, 403, { error: "forbidden" });

  const body = await readJson(req);
  const action = clean(body.action, 20);
  const sb = userClient(req);
  const manager = canManageProposals(ctx);

  if (action === "direct") {
    if (!isUuid(body.proposalId) || !STAGES.has(body.stage) || (body.ownerId && !isUuid(body.ownerId))) {
      return json(res, 400, { error: "invalid_body", hint: "段階と担当者を選んでください" });
    }
    const reason = clean(body.reason, 500);
    if (!reason) return json(res, 400, { error: "invalid_body", field: "reason", hint: "担当を変える理由を入力してください" });
    const { proposal, error: proposalError } = await loadProposal(sb, ctx.tenantId, body.proposalId);
    if (proposalError) return fail(res, proposalError);
    if (!proposal) return json(res, 404, { error: "not_found" });
    const ownerId = body.ownerId || null;
    if (ownerId) {
      const people = await loadPeople(ctx.tenantId);
      const members = await salesMembers(ctx.tenantId, people.employees);
      if (!members.some((m) => m.id === ownerId)) {
        return json(res, 400, { error: "bad_owner", hint: "Sales を使える在籍中の社員から選んでください" });
      }
    }
    const { data: changeId, error } = await sb.rpc("gw_sales_proposal_assign_stage_owner", {
      p_proposal: body.proposalId, p_stage: body.stage, p_to_owner: ownerId, p_reason: reason,
    });
    if (error) return fail(res, error);
    if (ownerId && ownerId !== ctx.employee.id) await notify([{
      tenantId: ctx.tenantId, employeeId: ownerId, kind: "sales",
      title: `提案の担当になりました：${proposal.company_name}`,
      body: "提案管理で担当範囲と次の行動を確認してください。",
      link: `/sales/proposals.html?id=${body.proposalId}`, dedupeKey: `sales_assignment_direct:${changeId}`,
    }]);
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.proposal_assignment_direct",
      target: `sales_proposal:${body.proposalId}`, detail: { changeId, stage: body.stage, to: ownerId, reason } });
    return json(res, 200, { ok: true, changeId, status: "approved" });
  }

  if (action === "request") {
    if (!isUuid(body.proposalId) || !STAGES.has(body.stage) || !isUuid(body.ownerId)) {
      return json(res, 400, { error: "invalid_body", hint: "段階と希望する担当者を選んでください" });
    }
    const reason = clean(body.reason, 500);
    if (!reason) return json(res, 400, { error: "invalid_body", field: "reason", hint: "変更を希望する理由を入力してください" });
    const { data: requestId, error } = await sb.rpc("gw_sales_proposal_request_assignment", {
      p_proposal: body.proposalId, p_stage: body.stage, p_to_owner: body.ownerId, p_reason: reason,
    });
    if (error) return fail(res, error);

    const { proposal } = await loadProposal(sb, ctx.tenantId, body.proposalId);
    const people = await loadPeople(ctx.tenantId);
    const currentOwnerId = body.stage === "proposal" ? proposal?.sales_owner_id
      : body.stage === "cs" ? proposal?.cs_owner_id || proposal?.sales_owner_id
        : proposal?.closing_owner_id || proposal?.sales_owner_id;
    const recipients = currentOwnerId && currentOwnerId !== ctx.employee.id
      ? [currentOwnerId] : await managerIds(ctx.tenantId, people);
    if (recipients.length) await notify(recipients.map((employeeId) => ({
      tenantId: ctx.tenantId, employeeId, kind: "sales", title: `提案の担当変更依頼：${proposal?.company_name || "提案"}`,
      body: "提案管理で希望内容と理由を確認し、承認または却下してください。",
      link: `/sales/proposals.html?id=${body.proposalId}`, dedupeKey: `sales_assignment_request:${requestId}:${employeeId}`,
    })));
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.proposal_assignment_requested",
      target: `sales_proposal:${body.proposalId}`, detail: { requestId, stage: body.stage, to: body.ownerId, reason } });
    return json(res, 200, { ok: true, requestId, status: "pending" });
  }

  if (action === "approve" || action === "reject") {
    if (!isUuid(body.requestId)) return json(res, 400, { error: "invalid_body", field: "requestId" });
    const note = clean(body.note, 500);
    const { data: request, error: e0 } = await sb.from("gw_sales_proposal_assignment_requests")
      .select("id,proposal_id,stage,to_owner_id,requested_by_employee_id,status")
      .eq("id", body.requestId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (e0) return fail(res, e0);
    if (!request) return json(res, 404, { error: "not_found" });
    const { data: proposal } = await loadProposal(sb, ctx.tenantId, request.proposal_id);
    const { data: requestId, error } = await sb.rpc("gw_sales_proposal_review_assignment_request", {
      p_request: body.requestId, p_decision: action, p_note: note || null,
    });
    if (error) return fail(res, error);
    const decision = action;
    try {
      await reviewRecipients(ctx.tenantId, {
        proposalId: request.proposal_id, stage: request.stage, toOwnerId: request.to_owner_id,
        requesterId: request.requested_by_employee_id, decision, companyName: proposal?.company_name || "提案",
      });
    } catch (e) { console.error("[sales/proposals/assignment-requests] notify:", e?.message || e); }
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `sales.proposal_assignment_${action === "approve" ? "approved" : "rejected"}`,
      target: `sales_proposal:${request.proposal_id}`, detail: { requestId, stage: request.stage, to: request.to_owner_id, note } });
    return json(res, 200, { ok: true, requestId, status: decision === "approve" ? "approved" : "rejected" });
  }

  return json(res, 400, { error: "unknown_action" });
}
