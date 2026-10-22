// 一覧の担当プルダウン専用。メンバーによる担当配置変更を履歴付きで保存。
// 工程を進める正式な引継ぎ（handoff.js）とは別。DB RPCでテナント/社員/競合/履歴を原子的に検証。
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { isUuid } from "../../../lib/sales-proposals.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";

const SQL = "db/145_sales_proposal_inline_owners.sql";
const ROLES = ["proposal", "cs", "closing"];
export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx) || !ctx.employee?.id)
    return json(res, 403, { error: "forbidden", hint: "Salesに登録されたメンバーだけが担当を選択できます" });

  const body = await readJson(req);
  const role = body.role;
  const owner = body.ownerId === "" || body.ownerId == null ? null : body.ownerId;
  const expected = body.expectedOwnerId === "" || body.expectedOwnerId == null ? null : body.expectedOwnerId;
  if (!isUuid(body.id) || !ROLES.includes(role) || owner !== null && !isUuid(owner)
    || expected !== null && !isUuid(expected) || body.expectedOwnerId === undefined)
    return json(res, 400, { error: "invalid_body", hint: "提案・役割・変更先が正しくありません" });
  if (expected === owner) return json(res, 200, { ok:true, unchanged:true });

  const sb = userClient(req);
  const { data: p, error: lookupError } = await sb.from("gw_sales_proposals")
    .select("id, tenant_id, company_name, archived_at").eq("id", body.id)
    .eq("tenant_id", ctx.tenantId).maybeSingle();
  if (lookupError) return json(res, 500, { error: "db_failed", hint: "提案を確認できませんでした" });
  if (!p) return json(res, 404, { error: "not_found" });
  if (p.archived_at) return json(res, 409, { error: "archived", hint: "復元してから担当を変更してください" });

  const { data: changed, error } = await sb.rpc("gw_sales_set_proposal_stage_owner", {
    p_proposal: body.id, p_stage: role, p_owner: owner, p_expected_owner: expected,
  });
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", hint });
    const reason = String(error.message || "");
    if (error.code === "40001" || /owner_changed/.test(reason))
      return json(res, 409, { error: "owner_changed", hint: "他のメンバーが先に変更しました。画面を再読み込みしてください" });
    if (/invalid_member/.test(reason))
      return json(res, 400, { error: "invalid_member", hint: "同じ会社の在籍中のSalesメンバーを選んでください" });
    if (/current_owner_required/.test(reason))
      return json(res, 409, { error: "current_owner_required", hint: "現在の工程の担当は未割当にできません" });
    if (/proposal_archived/.test(reason))
      return json(res, 409, { error: "archived", hint: "復元してから担当を変更してください" });
    if (error.code === "42501") return json(res, 403, { error: "forbidden", hint: "担当を変更できません。Sales権限を確認してください" });
    return json(res, 500, { error: "db_failed", hint: "担当の更新に失敗しました" });
  }
  if (changed) {
    await gwLog({ tenantId:ctx.tenantId, actorId:user.id, action:"sales.proposal_role_owner",
      target:"sales_proposal:"+body.id, detail:{ stage:role, from:expected, to:owner } });
    if (owner && owner !== ctx.employee.id) {
      try {
        await notify([{ tenantId:ctx.tenantId, employeeId:owner, kind:"sales",
          title:"提案の担当変更："+p.company_name,
          body:"担当者に設定されました。案件と次の対応をSalesで確認してください。",
          link:"/sales/proposals.html?id="+body.id,
          dedupeKey:"sales_owner_change:"+body.id+":"+role+":"+owner+":"+Date.now() }]);
      } catch (e) { console.error("[sales/proposals/owners] notify:", e?.message || e); }
    }
  }
  return json(res, 200, { ok:true, changed:Boolean(changed), role, ownerId:owner });
}
