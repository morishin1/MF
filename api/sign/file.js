// GET /api/sign/file?id=…&kind=signed|original
//   → 契約書PDFの閲覧用URL（短時間だけ有効）を返す
//
// ■ 誰が取れるか
//   本人（自分あての契約書だけ）と、人事・管理者。
//   Storage のポリシーではなく、ここで判断している。
//   署名済みPDFは service_role で作って置いているので、
//   バケットのパス規約に頼った判定ができない（db/012 の hr_files_rw は
//   2つめのパス要素を procedure_id として見る作りになっている）。
//
// ■ 開いた記録を残す
//   ダウンロードも監査ログに残す。「渡していない」「受け取っていない」の
//   言い合いになったときに、これしか手がかりが無い。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { signEvent } from "../../lib/sign-audit.js";

const BUCKET = "hr";
const TTL = 60 * 5;

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const q = new URL(req.url, "http://localhost").searchParams;
  const id = q.get("id");
  const kind = q.get("kind") === "original" ? "original" : "signed";
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const sb = admin();
  const { data: r } = await sb.from("gw_sign_requests")
    .select("id, title, employee_id, status, pdf_path, signed_pdf_path, signed_pdf_sha256, pdf_sha256")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!r) return json(res, 404, { error: "not_found" });

  const mine = ctx.employee && r.employee_id === ctx.employee.id;
  if (!mine && !canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  // 署名済みが無ければ、署名前を返す。
  // 「まだ署名していない契約書を読みたい」は普通の用なので、断らない
  const path = kind === "signed" && r.signed_pdf_path ? r.signed_pdf_path : r.pdf_path;
  if (!path) return json(res, 404, { error: "pdf_missing" });

  const { data: signed, error } = await sb.storage.from(BUCKET).createSignedUrl(path, TTL);
  if (error) return json(res, 404, { error: "pdf_missing", detail: error.message });

  await signEvent(ctx, r.id, "downloaded", req,
    { id: user.id, name: ctx.employee?.display_name }, { kind, by: mine ? "本人" : "会社" });

  return json(res, 200, {
    url: signed.signedUrl,
    kind: path === r.signed_pdf_path ? "signed" : "original",
    filename: `${r.title}${path === r.signed_pdf_path ? "（署名済）" : ""}.pdf`,
    hash: path === r.signed_pdf_path ? r.signed_pdf_sha256 : r.pdf_sha256,
    expiresInSec: TTL,
  });
}
