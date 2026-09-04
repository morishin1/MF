// POST   /api/onboarding/upload  { itemId, filename, mimeType, sizeBytes }
//          → 書き込み用の署名URLを発行する { fileId, uploadUrl, storagePath }
// PATCH  /api/onboarding/upload  { fileId }
//          → アップロード完了後の確定。人事フォルダへコピーし、項目を「提出済み」にする
// GET    /api/onboarding/upload?fileId=…
//          → 閲覧用の署名URLを返す（見てよい人かは RLS が決める）
//
// 証憑（documents）とは別のバケット 'hr' に保存する。
// マイナンバー確認書類などを、同じ取引先のメンバーから見えない場所に置くため。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { hrConfigured } from "../../lib/gdrive.js";
import { ensureProcedureFolder } from "../../lib/hr-drive.js";
import { uploadFile } from "../../lib/gdrive.js";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg", "image/png", "image/heic", "image/webp",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const VIEW_TTL = 60 * 5;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  if (req.method === "POST") return issueUploadUrl(req, res, ctx, user);
  if (req.method === "PATCH") return confirmUpload(req, res, ctx);
  if (req.method === "GET") return viewUrl(req, res, ctx);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

// ---- 署名URLの発行 --------------------------------------------------------
async function issueUploadUrl(req, res, ctx, user) {
  const body = await readJson(req);
  const { itemId, filename, mimeType, sizeBytes } = body || {};
  if (!itemId || !filename || !mimeType || !sizeBytes) {
    return json(res, 400, { error: "invalid_body", required: ["itemId", "filename", "mimeType", "sizeBytes"] });
  }
  if (!ALLOWED_MIME.has(mimeType)) return json(res, 400, { error: "unsupported_mime", mimeType });
  if (sizeBytes > MAX_BYTES) return json(res, 400, { error: "file_too_large", max: MAX_BYTES });

  const item = await loadItemForWrite(ctx, itemId);
  if (item.error) return json(res, item.status, { error: item.error, hint: item.hint });

  const sb = admin();
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase().slice(0, 8) : "bin";
  const fileId = crypto.randomUUID();
  const storagePath = `${ctx.tenantId}/${item.procedureId}/${fileId}.${ext}`;

  const { error: ie } = await sb.from("gw_procedure_files").insert({
    id: fileId,
    tenant_id: ctx.tenantId,
    procedure_id: item.procedureId,
    item_id: itemId,
    filename, mime_type: mimeType, size_bytes: sizeBytes,
    storage_path: storagePath,
    uploaded_by: user.id,
  });
  if (ie) return json(res, 500, { error: "db_insert_failed", detail: ie.message });

  const { data: signed, error: se } = await sb.storage.from("hr").createSignedUploadUrl(storagePath);
  if (se) {
    await sb.from("gw_procedure_files").delete().eq("id", fileId);
    return json(res, 500, { error: "sign_failed", detail: se.message });
  }

  return json(res, 200, { fileId, storagePath, uploadUrl: signed.signedUrl, token: signed.token });
}

// ---- アップロード完了後の確定 ---------------------------------------------
async function confirmUpload(req, res, ctx) {
  const body = await readJson(req);
  const fileId = body?.fileId;
  if (!fileId) return json(res, 400, { error: "invalid_body", required: ["fileId"] });

  const sb = admin();
  const { data: file, error } = await sb
    .from("gw_procedure_files")
    .select("id, procedure_id, item_id, filename, mime_type, storage_path, drive_file_id")
    .eq("id", fileId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!file) return json(res, 404, { error: "file_not_found" });

  // 発行時と同じ判定をもう一度通す。署名URLだけ先に取って放置された場合に備える
  const item = await loadItemForWrite(ctx, file.item_id);
  if (item.error) return json(res, item.status, { error: item.error, hint: item.hint });

  // 項目を「提出済み」にする。人事が確認済み（done/na）なら触らない
  if (item.status !== "done" && item.status !== "na") {
    await sb
      .from("gw_procedure_items")
      .update({ status: "submitted", document_id: null, updated_at: new Date().toISOString() })
      .eq("id", file.item_id);
  }

  // 人事フォルダへのコピー。未設定・失敗でも提出自体は成立させる
  const drive = await copyToDrive(sb, ctx, file, item);

  return json(res, 200, { ok: true, fileId, drive });
}

// ---- 閲覧用URL ------------------------------------------------------------
async function viewUrl(req, res, ctx) {
  const fileId = new URL(req.url, "http://localhost").searchParams.get("fileId");
  if (!fileId) return json(res, 400, { error: "invalid_query", required: ["fileId"] });

  // 見てよい人かは RLS が決める。読めなければ 0 件になる
  const { data: file } = await userClient(req)
    .from("gw_procedure_files")
    .select("id, filename, storage_path")
    .eq("id", fileId)
    .maybeSingle();
  if (!file) return json(res, 404, { error: "file_not_found" });

  const { data: signed, error } = await admin()
    .storage.from("hr")
    .createSignedUrl(file.storage_path, VIEW_TTL);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });

  return json(res, 200, { url: signed.signedUrl, filename: file.filename, expiresInSec: VIEW_TTL });
}

// ---- 共通 -----------------------------------------------------------------

// 「この項目にファイルを付けてよいか」を判定して、必要な情報を返す。
// 本人（自分の手続きの、自分が担当の項目）か、人事・管理者だけを通す。
async function loadItemForWrite(ctx, itemId) {
  if (!itemId) return { error: "invalid_body", status: 400, hint: "itemId が必要です" };

  const { data: item, error } = await admin()
    .from("gw_procedure_items")
    .select("id, status, owner, procedure_id, gw_procedures!inner(id, kind, target_on, employee_id, tenant_id)")
    .eq("id", itemId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (error) return { error: "db_query_failed", status: 500, hint: error.message };
  if (!item) return { error: "item_not_found", status: 404 };

  const proc = item.gw_procedures;
  const isMine = ctx.employee && proc.employee_id === ctx.employee.id;
  if (!isMine && !canManageHr(ctx)) return { error: "forbidden", status: 403 };
  if (isMine && !canManageHr(ctx) && item.owner !== "employee") {
    return { error: "not_your_item", status: 403, hint: "会社側で対応する項目です" };
  }

  return {
    itemId, status: item.status, procedureId: item.procedure_id,
    kind: proc.kind, targetOn: proc.target_on, employeeId: proc.employee_id,
  };
}

// 提出ファイルを人事フォルダへコピーする。失敗しても提出は取り消さない。
async function copyToDrive(sb, ctx, file, item) {
  if (!hrConfigured()) return { skipped: "not_configured" };
  if (file.drive_file_id) return { skipped: "already" };

  try {
    const { data: employee } = await sb
      .from("gw_employees").select("display_name").eq("id", item.employeeId).maybeSingle();

    const folder = await ensureProcedureFolder({
      kind: item.kind, targetOn: item.targetOn, displayName: employee?.display_name,
    });
    if (folder.skipped) return { skipped: folder.skipped };

    const { data: signed } = await sb.storage.from("hr").createSignedUrl(file.storage_path, 60);
    const r = await fetch(signed.signedUrl);
    if (!r.ok) throw new Error("download_failed: " + r.status);
    const buffer = Buffer.from(await r.arrayBuffer());

    const up = await uploadFile({
      name: file.filename, mimeType: file.mime_type, buffer, parentId: folder.folderId,
    });
    await sb
      .from("gw_procedure_files")
      .update({ drive_file_id: up.id, drive_link: up.webViewLink || null })
      .eq("id", file.id);

    return { fileId: up.id, link: up.webViewLink };
  } catch (e) {
    console.error("[onboarding] hr drive copy failed:", e?.message || e);
    return { error: String(e?.message || e) };
  }
}
