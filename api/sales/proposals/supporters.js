// /sales 提案の共同担当設定。主担当は変えず提案・CS・クロージング各段階にメンバーを追加。
// 他人の案件は閲覧のみ。DB の db/142 RPC でも認証・現担当者・テナントを再確認する。
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { loadProposal, loadPeople, salesMembers } from "../../../lib/sales-proposals-db.js";
import { isUuid } from "../../../lib/sales-proposals.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx)) return json(res, 403, { error: "forbidden" });
  const b = await readJson(req);
  if (!isUuid(b.id) || !["proposal", "cs", "closing"].includes(b.stage)
    || !Array.isArray(b.members) || b.members.length > 10 ||
    b.members.some((id) => !isUuid(id)) || new Set(b.members).size !== b.members.length) {
    return json(res, 400, { error: "invalid_body", hint: "各段階の共同担当は最大10人。社員を選択してください" });
  }
  const sb = userClient(req);
  const { proposal, error } = await loadProposal(sb, ctx.tenantId, b.id);
  if (error) return json(res, 500, { error: "db_failed" });
  if (!proposal) return json(res, 404, { error: "not_found" });
  if (proposal.archived_at || !ctx.employee?.id || proposal.sales_owner_id !== ctx.employee.id) {
    return json(res, 403, { error: "readonly", hint: "共同担当を変更できるのは現在の主担当者だけです" });
  }
  const staff = await loadPeople(ctx.tenantId);
  const allowed = new Set((await salesMembers(ctx.tenantId, staff.employees)).map((x) => x.id));
  if (b.members.some((id) => !allowed.has(id))) {
    return json(res, 400, { error: "invalid_member", hint: "在籍中のSales利用者を選んでください" });
  }
  const { data, error: e } = await sb.rpc("gw_sales_set_supporters", {
    p_proposal: proposal.id, p_stage: b.stage, p_members: b.members,
  });
  if (e) {
    const hint = dbSetupHint(e, "db/142_sales_team_proposals_bulk.sql");
    if (hint) return json(res, 503, { error: "not_ready", hint });
    return json(res, e.code === "42501" ? 403 : e.code === "23514" ? 409 : 500, {
      error: "save_failed", hint: ["42501", "23514"].includes(e.code) ? e.message : "共同担当を更新できませんでした",
    });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.proposal_supporters",
    target: "sales_proposal:" + proposal.id, detail: { stage: b.stage, count: data } });
  return json(res, 200, { ok: true, count: data });
}
