// GET/POST: 合格記録に基づくOffice作成依頼。署名・成約・ENGERステージは変更しない。
import { json, methodNotAllowed } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { runContractRequests } from "../../../lib/sales-contract-requests-db.js";
export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  return runContractRequests(req, res, ctx, false);
}
