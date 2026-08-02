// GET /api/drive/status?clientId=...
// Drive連携の設定状況と、未同期の書類件数を返す（管理者のみ）。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";
import { isConfigured, rootFolderId } from "../../lib/gdrive.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const { clientId } = req.query || {};
  if (!clientId) return json(res, 400, { error: "invalid_query", required: ["clientId"] });

  const sb = admin();
  const { data: client, error } = await sb.from("clients").select("id, tenant_id, name").eq("id", clientId).single();
  if (error || !client) return json(res, 404, { error: "client_not_found" });

  const memberships = await getMemberships(user.id);
  const isAdmin = memberships.some((m) => m.tenant_id === client.tenant_id && (m.role === "admin" || m.role === "staff"));
  if (!isAdmin) return json(res, 403, { error: "forbidden_not_admin" });

  const configured = isConfigured();
  let pending = null, total = null;
  if (configured) {
    const p = await sb.from("documents").select("id", { count: "exact", head: true })
      .eq("client_id", clientId).is("drive_file_id", null);
    const t = await sb.from("documents").select("id", { count: "exact", head: true })
      .eq("client_id", clientId);
    pending = p.count ?? null;
    total = t.count ?? null;
  }

  return json(res, 200, {
    configured,
    rootFolderId: configured ? rootFolderId() : null,
    rootFolderUrl: configured ? `https://drive.google.com/drive/folders/${rootFolderId()}` : null,
    pending, total,
  });
}
