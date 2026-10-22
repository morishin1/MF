// POST /api/sales/proposals/bulk
// 同一テナント・現在担当の提案に限る。1件でも他人の提案が混じれば全体を403。
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { isUuid, canManageProposals } from "../../../lib/sales-proposals.js";

const SQL_FILE = "db/145_sales_proposal_inline_owners.sql";
export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx) || !ctx.employee?.id) return json(res, 403, { error: "forbidden" });

  const body = await readJson(req);
  const ids = body.ids;
  const action = String(body.action || "");
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
      ids.some((id) => !isUuid(id)) || new Set(ids).size !== ids.length ||
      !["archive", "restore", "edit"].includes(action))
    return json(res, 400, { error: "invalid_selection", hint: "担当中の提案を1〜50件選択してください" });

  const service = action === "edit" && body.service != null ? String(body.service).trim() : null;
  const title = action === "edit" && body.title != null ? String(body.title).trim() : null;
  if (action === "edit" && (!service && !title || service != null && (service.length < 1 || service.length > 100)
        || title != null && (ids.length !== 1 || title.length < 1 || title.length > 200)))
    return json(res, 400, { error: "invalid_edit", hint: "種別は100文字以内、提案名は単一選択の場合だけ編集できます" });

  // サーバでテナントと現在担当をもう一度検証。RPC側も本人確認を行い全件を1トランザクションで処理。
  const sb = userClient(req);
  const { data: check, error: checkError } = await sb.from("gw_sales_proposals")
    .select("id, sales_owner_id, archived_at, source_system").eq("tenant_id", ctx.tenantId).in("id", ids);
  if (checkError) {
    const hint = dbSetupHint(checkError, SQL_FILE);
    if (hint) return json(res, 503, { error: "not_ready", hint });
    return json(res, 500, { error: "db_failed" });
  }
  if ((check || []).length !== ids.length || (!canManageProposals(ctx) && check.some((p) => p.sales_owner_id !== ctx.employee.id)))
    return json(res, 403, { error: "readonly", hint: "担当者本人またはSales管理者だけが一括操作できます" });

  const { data: changed, error } = await sb.rpc("gw_sales_bulk_proposals", {
    p_ids: ids, p_action: action, p_service: service, p_title: title,
  });
  if (error) {
    const hint = dbSetupHint(error, SQL_FILE);
    if (hint) return json(res, 503, { error: "not_ready", hint });
    if (error.code === "42501") return json(res, 403, { error: "readonly",
      hint: "担当が変更されたか、実行権限がありません。再読み込みしてください" });
    if (error.code === "23514") return json(res, 409, { error: "conflict",
      hint: "編集できない提案・アーカイブ済みの提案が含まれています。内容を確認してください" });
    console.error("[sales/proposals/bulk] failed", error.code || error.message);
    return json(res, 500, { error: "db_failed", hint: "更新できませんでした" });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
    action: "sales.proposal_bulk_" + action, target: "sales_proposals",
    detail: { ids, count: changed } });
  return json(res, 200, { ok: true, count: changed, action });
}
