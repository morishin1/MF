// 監査ログ（追記専用）
import { admin } from "./supabase.js";

/**
 * @param {object} entry { tenantId, clientId, actorId, action, target, detail }
 */
export async function audit(entry) {
  try {
    const sb = admin();
    await sb.from("audit_log").insert({
      tenant_id: entry.tenantId ?? null,
      client_id: entry.clientId ?? null,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      target: entry.target ?? null,
      detail: entry.detail ?? null,
    });
  } catch (e) {
    // 監査ログ書込失敗は本処理を止めない。サーバログには出す。
    console.error("[audit] failed:", e?.message || e);
  }
}
