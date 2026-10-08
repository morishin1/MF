// GET /api/retiree
// 退職者ポータル（/retiree/）の中身。本人の名前・退職日と、退職書類の一覧（種類ごとに1行）。
//
// ■ 見せるもの
//   公開中の発行済みの書類だけ、見る・保存するができる（id を返す）。
//   手続き中は「手続き中」、それ以外（下書き・未公開・未登録）は「準備中」。下書きの存在や中身は返さない。
//   社内メモ・保存先・ハッシュ・本文・退職理由は返さない。
//
// POST /api/retiree {action:"cert_request", items, ndaAgreed:true}
//   退職証明書の発行を申請する（記載してほしい項目・誓約。db/127・lib/retire-cert-request-db.js）。
//   GET の certRequest に、選べる項目・誓約の文面・自分の申請（最新）を返す。表が無い（db/127 未適用）ときは null（申請の欄を出さない）
//
// ■ 誰が使えるか
//   退職者として扱う本人だけ（lib/retiree-gate.js）。社員 ID は、ログイン中の本人からサーバーで引く。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { requireRetiree } from "../../lib/retiree-gate.js";
import { portalView } from "../../lib/retire.js";
import { selfState, createRequest, CERT_SQL } from "../../lib/retire-cert-request-db.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const who = await requireRetiree(req, res);
  if (!who) return;
  const { employee } = who;

  if (req.method === "POST") {
    const body = await readJson(req);
    if (body?.action !== "cert_request") return json(res, 400, { error: "invalid_action", detail: "cert_request" });
    try {
      const r = await createRequest(admin(), { tenantId: employee.tenant_id, employee, user: who.user, req, body });
      return json(res, r.status, r.body);
    } catch (e) {
      const hint = dbSetupHint(e, CERT_SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: "退職証明書の申請は、まだ使えません" });
      console.error("[retiree] cert_request", e?.message || e);
      return json(res, 500, { error: "cert_request_failed" });
    }
  }

  let rows = [];
  const { data, error } = await admin()
    .from("gw_retire_docs")
    .select("id, kind, version, state, published, issued_on, expected_on")
    .eq("tenant_id", employee.tenant_id).eq("employee_id", employee.id);
  if (error) {
    // 表が無い（db/121 未適用）ときは、すべて「準備中」として返す（ポータルは開く）
    if (!dbSetupHint(error, "db/121_retire_docs.sql")) return json(res, 500, { error: "db_query_failed" });
  } else rows = data || [];

  // 退職証明書の申請（db/127 が無ければ null。ポータルは開く）
  let certRequest = null;
  try { certRequest = await selfState(admin(), employee.tenant_id, employee.id); }
  catch (e) { if (!dbSetupHint(e, CERT_SQL)) return json(res, 500, { error: "db_query_failed" }); }

  res.setHeader?.("Cache-Control", "no-store");
  return json(res, 200, {
    name: employee.display_name,
    leftOn: employee.left_on || null,
    docs: portalView(rows),
    certRequest,
  });
}
