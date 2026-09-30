// GET /api/office/file?id=…  … 届いた勤務表・請求書の1件を見るための、短い署名付きURL
//
// 入れる人・DB の条件は api/office/index.js と同じ（経営者 OR 責任者 OR 経理）。二段階認証（MFA）は要求しない。
//
// ■ 誰がいつ何を見たかを残す
//
//   勤務表・請求書には氏名・稼働・金額が載っている。閲覧のたびに gwLog に残す
//   （URL そのものは残さない。署名付きURLは短時間で切れるが、ログに残す理由も無い）。
//
// ■ ファイルの置き場所（storage_path）は、項目として返さない
//
//   返すのは、短時間だけ有効な署名付きURLとファイル名だけ（署名付きURLにはパスが含まれるが、
//   5分で切れる）。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const BUCKET = "billing-submissions";
const VIEW_TTL = 60 * 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canAccessOffice(ctx)) return json(res, 403, { error: "forbidden" });

  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });
  if (!UUID.test(id)) return json(res, 400, { error: "invalid_query", detail: "id の形が正しくありません" });

  res.setHeader("Cache-Control", "no-store");

  // Office 権限があるかは、DB（gw_is_office、db/100）も決める。読めなければ 0 件
  const { data: file } = await userClient(req)
    .from("gw_submissions")
    .select("id, employee_id, site_contract_id, target_month, kind, file_name, storage_path")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!file) return json(res, 404, { error: "file_not_found" });

  const { data: signed, error } = await admin()
    .storage.from(BUCKET).createSignedUrl(file.storage_path, VIEW_TTL);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "office.submission.view",
    target: `submission:${file.id}`,
    detail: { employeeId: file.employee_id, siteContractId: file.site_contract_id,
      kind: file.kind, targetMonth: file.target_month },
  });

  return json(res, 200, { url: signed.signedUrl, filename: file.file_name, expiresInSec: VIEW_TTL });
}
