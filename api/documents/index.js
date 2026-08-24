// GET    /api/documents?clientId=...&period=YYYY-MM&docType=...&status=...
//   テナント分離（RLS）に守られた書類一覧。月次管理・承認画面の共通データ源。
// DELETE /api/documents?documentId=...
//   誤アップロードの取り消し。DB行 → Storage実体 → Driveの順に片付ける。
//   MF登録済み（sent）は証憑を消せないため拒否する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships, canAccessClient } from "../../lib/auth.js";
import { userClient, admin } from "../../lib/supabase.js";
import { audit } from "../../lib/audit.js";
import { isConfigured as driveConfigured, trashFile } from "../../lib/gdrive.js";

export default async function handler(req, res) {
  if (req.method === "GET")    return listDocuments(req, res);
  if (req.method === "DELETE") return deleteDocument(req, res);
  return methodNotAllowed(res, ["GET", "DELETE"]);
}

async function listDocuments(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const sb = userClient(req); // ← RLS が auth.uid() を解決
  const { clientId, period, docType, status } = req.query || {};

  let q = sb.from("documents")
    .select("id, tenant_id, client_id, uploaded_by, filename, mime_type, size_bytes, storage_path, doc_type, doc_date, period, ai_summary, is_accounting, status, uploaded_at")
    .order("uploaded_at", { ascending: false })
    .limit(500);
  if (clientId) q = q.eq("client_id", clientId);
  if (period)   q = q.eq("period", period);
  if (docType)  q = q.eq("doc_type", docType);
  if (status)   q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  return json(res, 200, { documents: data || [] });
}

async function deleteDocument(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const { documentId } = req.query || {};
  if (!documentId) return json(res, 400, { error: "invalid_query", required: ["documentId"] });

  const sb = admin();
  const { data: doc, error } = await sb
    .from("documents")
    .select("id, tenant_id, client_id, uploaded_by, filename, mime_type, size_bytes, storage_path, doc_type, doc_date, period, status, drive_file_id, drive_link")
    .eq("id", documentId).single();
  if (error || !doc) return json(res, 404, { error: "document_not_found" });

  const memberships = await getMemberships(user.id);
  if (!canAccessClient(memberships, doc.client_id, doc.tenant_id)) {
    return json(res, 403, { error: "forbidden" });
  }

  // 会計ソフトへ送信済みの証憑は消させない（帳簿の裏付けが消えるため）
  if (doc.status === "sent") {
    return json(res, 409, { error: "document_already_sent", detail: "会計ソフトへ登録済みの書類は削除できません" });
  }
  const { data: journals, error: eJ } = await sb
    .from("journals").select("id, status").eq("document_id", doc.id);
  if (eJ) return json(res, 500, { error: "db_query_failed", detail: eJ.message });
  if ((journals || []).some((j) => j.status === "sent")) {
    return json(res, 409, { error: "journal_already_sent", detail: "この書類の仕訳は会計ソフトへ登録済みのため削除できません" });
  }

  // 1) DB行を先に消す（journals / ai_questions は FK の on delete cascade で連鎖）。
  //    ここで失敗しても実体は無傷なので、やり直しが効く。
  const { error: eDel } = await sb.from("documents").delete().eq("id", doc.id);
  if (eDel) return json(res, 500, { error: "db_delete_failed", detail: eDel.message });

  // 2) 実体の片付け。ここから先の失敗は「消し残り」でしかないので警告に留める。
  const warnings = [];

  const { error: eStore } = await sb.storage.from("documents").remove([doc.storage_path]);
  if (eStore) warnings.push({ step: "storage", detail: eStore.message });

  if (doc.drive_file_id && driveConfigured()) {
    try {
      await trashFile(doc.drive_file_id);
    } catch (e) {
      warnings.push({ step: "drive", detail: e?.message || String(e) });
    }
  }

  await audit({
    tenantId: doc.tenant_id, clientId: doc.client_id, actorId: user.id,
    action: "document.delete", target: `document:${doc.id}`,
    detail: {
      filename: doc.filename, mimeType: doc.mime_type, sizeBytes: doc.size_bytes,
      storagePath: doc.storage_path, docType: doc.doc_type, docDate: doc.doc_date,
      period: doc.period, status: doc.status,
      driveFileId: doc.drive_file_id, driveLink: doc.drive_link,
      uploadedBy: doc.uploaded_by,
      deletedJournalIds: (journals || []).map((j) => j.id),
      warnings,
    },
  });

  return json(res, 200, {
    deleted: true,
    documentId: doc.id,
    filename: doc.filename,
    deletedJournals: (journals || []).length,
    driveTrashed: Boolean(doc.drive_file_id && driveConfigured() && !warnings.some((w) => w.step === "drive")),
    warnings,
  });
}
