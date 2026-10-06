// GET /api/retiree/file?id=…[&download=1]
// 退職書類の PDF を見る・保存するための URL（5分だけ有効）を返す。
//
// ■ 取れるのは、自分の「公開中の最新の発行済み」だけ
//   ・書類の id は、ログイン中の本人の社員 ID で絞って引く。他人の書類の id を渡しても 404（存在も教えない）
//   ・下書き・未公開・置き換え済み（古い版）・公開停止は 404
//   ・公開URL（永続）は作らない。private バケット hr の署名付き URL だけ
//   ・印影の画像・元データは、ここからは取れない（PDF に合成済みのものだけ）
//
// ■ 記録
//   見た・保存したを操作ログに残す（URL・本文は残さない）

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { requireRetiree } from "../../lib/retiree-gate.js";
import { liveOf, downloadName } from "../../lib/retire.js";

const BUCKET = "hr";
const TTL = 60 * 5;

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const who = await requireRetiree(req, res);
  if (!who) return;
  const { user, employee } = who;

  const q = new URL(req.url, "http://localhost").searchParams;
  const id = String(q.get("id") || "");
  const download = q.get("download") === "1";
  if (!/^[\w-]{1,64}$/.test(id)) return json(res, 404, { error: "not_found" });

  const sb = admin();
  const { data: rows, error } = await sb
    .from("gw_retire_docs")
    .select("id, kind, version, state, published, issued_on, storage_path")
    .eq("tenant_id", employee.tenant_id).eq("employee_id", employee.id);
  if (error) return json(res, 404, { error: "not_found" });

  const doc = (rows || []).find((r) => r.id === id);
  // 自分の書類で、いま公開中の最新の発行済みの版だけ
  const live = doc ? liveOf(rows, doc.kind) : null;
  if (!doc || !live || live.id !== doc.id || doc.state !== "issued" || !doc.published || !doc.storage_path) {
    return json(res, 404, { error: "not_found" });
  }

  const name = downloadName(doc.kind, employee.display_name, doc.issued_on);
  const { data, error: se } = await sb.storage.from(BUCKET)
    .createSignedUrl(doc.storage_path, TTL, download ? { download: name } : undefined);
  if (se || !data?.signedUrl) return json(res, 404, { error: "not_found" });

  await gwLog({
    tenantId: employee.tenant_id, actorId: user.id, action: download ? "retire.download" : "retire.view",
    target: `employee:${employee.id}`, detail: { docId: doc.id, kind: doc.kind, version: doc.version },
  });
  res.setHeader?.("Cache-Control", "no-store");
  return json(res, 200, { url: data.signedUrl, filename: name, download, expiresIn: TTL });
}
