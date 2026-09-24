// GET /api/billing-submission/file?id=…  … 届いた1件を見るための、短い署名付きURL

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";

const BUCKET = "billing-submissions";
const VIEW_TTL = 60 * 5;

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  // 社内スタッフかどうかは RLS（is_tenant_staff）が決める。読めなければ 0 件
  const { data: file } = await userClient(req)
    .from("gw_submissions").select("id, file_name, storage_path")
    .eq("id", id).maybeSingle();
  if (!file) return json(res, 404, { error: "file_not_found" });

  const { data: signed, error } = await admin()
    .storage.from(BUCKET).createSignedUrl(file.storage_path, VIEW_TTL);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });

  return json(res, 200, { url: signed.signedUrl, filename: file.file_name, expiresInSec: VIEW_TTL });
}
