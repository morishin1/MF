// POST /api/drive/sync  { clientId, limit? }
// まだ Drive に保存していない書類をまとめて同期する（管理者のみ）。
// 1回のリクエストで limit 件だけ処理し、残件数を返す。UI側で残りが0になるまで繰り返す。
//
// 出力: { synced, failed, remaining, periods, errors[] }

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";
import { isConfigured } from "../../lib/gdrive.js";
import { downloadDocument, syncDocumentToDrive, syncMonthlyCsv } from "../../lib/drive-sync.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  if (!isConfigured()) {
    return json(res, 503, {
      error: "drive_not_configured",
      hint: "Vercel に GOOGLE_SERVICE_ACCOUNT_JSON と GDRIVE_ROOT_FOLDER_ID を設定してください",
    });
  }

  const body = await readJson(req);
  const clientId = body?.clientId;
  const limit = Math.min(Number(body?.limit) || DEFAULT_LIMIT, MAX_LIMIT);
  if (!clientId) return json(res, 400, { error: "invalid_body", required: ["clientId"] });

  const sb = admin();
  const { data: client, error: ce } = await sb
    .from("clients").select("id, tenant_id, name").eq("id", clientId).single();
  if (ce || !client) return json(res, 404, { error: "client_not_found" });

  const memberships = await getMemberships(user.id);
  const isAdmin = memberships.some((m) => m.tenant_id === client.tenant_id && (m.role === "admin" || m.role === "staff"));
  if (!isAdmin) return json(res, 403, { error: "forbidden_not_admin" });

  // 未同期の書類（古い順に処理）
  const { data: pending, error: pe } = await sb
    .from("documents")
    .select("id, client_id, filename, mime_type, storage_path, doc_type, period, drive_file_id")
    .eq("client_id", clientId)
    .is("drive_file_id", null)
    .order("uploaded_at", { ascending: true })
    .limit(limit);
  if (pe) return json(res, 500, { error: "db_query_failed", detail: pe.message });

  const errors = [];
  const periods = new Set();
  let synced = 0;

  for (const doc of pending || []) {
    try {
      const buffer = await downloadDocument(sb, doc.storage_path);
      await syncDocumentToDrive(sb, { doc, clientName: client.name, buffer });
      if (doc.period) periods.add(doc.period);
      synced++;
    } catch (e) {
      errors.push({ documentId: doc.id, filename: doc.filename, detail: String(e?.message || e) });
    }
  }

  // 影響した月の仕訳一覧CSVを最新化
  for (const period of periods) {
    try { await syncMonthlyCsv(sb, { clientId, clientName: client.name, period }); }
    catch (e) { errors.push({ period, detail: String(e?.message || e) }); }
  }

  // 残件数
  const { count } = await sb
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .is("drive_file_id", null);

  return json(res, 200, {
    synced,
    failed: errors.length,
    remaining: typeof count === "number" ? count : null,
    periods: [...periods],
    errors,
  });
}
