// POST /api/expenses/upload  { filename, mimeType, sizeBytes }
//        → 領収書を置くための署名URLを発行する { path, uploadUrl, token }
// GET  /api/expenses/upload?path=…
//        → 閲覧用の署名URLを返す（見てよい人かは Storage のポリシーが決める）
//
// 申請を作る前にアップロードするので、パスは申請IDではなく社員IDで区切る。
//   <tenant_id>/<employee_id>/<uuid>.<ext>
// 会計の証憑（documents）とは別のバケットに置く。あちらに入れると
// AIの自動仕訳が走ってしまい、精算前の領収書が会計に混ざるため。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { canReviewExpense } from "../../lib/expenses.js";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg", "image/png", "image/heic", "image/webp",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const VIEW_TTL = 60 * 5;
const BUCKET = "expenses";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  if (req.method === "POST") return issueUploadUrl(req, res, ctx);
  if (req.method === "GET") return viewUrl(req, res, ctx);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function issueUploadUrl(req, res, ctx) {
  const { filename, mimeType, sizeBytes } = (await readJson(req)) || {};
  if (!filename || !mimeType || !sizeBytes) {
    return json(res, 400, { error: "invalid_body", required: ["filename", "mimeType", "sizeBytes"] });
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    return json(res, 400, { error: "unsupported_mime", mimeType, hint: "PDF・JPEG・PNG・HEIC・WebP に対応しています" });
  }
  if (sizeBytes > MAX_BYTES) {
    return json(res, 400, { error: "file_too_large", max: MAX_BYTES, hint: "10MBまでにしてください" });
  }

  const ext = String(filename).includes(".")
    ? String(filename).split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
    : "bin";
  const path = `${ctx.tenantId}/${ctx.employee.id}/${crypto.randomUUID()}.${ext}`;

  const { data, error } = await admin().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });

  return json(res, 200, { path, uploadUrl: data.signedUrl, token: data.token });
}

async function viewUrl(req, res, ctx) {
  const path = new URL(req.url, "http://localhost").searchParams.get("path");
  if (!path) return json(res, 400, { error: "invalid_query", required: ["path"] });

  // パスの持ち主か、承認できる立場か。Storage のポリシーと同じ判定をここでも通す。
  // 署名URLは service_role で作るため、ここを抜かすと誰でも他人の領収書を開ける
  const [tenantId, employeeId] = String(path).split("/");
  if (tenantId !== ctx.tenantId) return json(res, 403, { error: "forbidden" });
  if (employeeId !== ctx.employee.id && !canReviewExpense(ctx)) {
    return json(res, 403, { error: "forbidden" });
  }

  const { data, error } = await admin().storage.from(BUCKET).createSignedUrl(path, VIEW_TTL);
  if (error) return json(res, 404, { error: "file_not_found", detail: error.message });
  return json(res, 200, { url: data.signedUrl });
}
