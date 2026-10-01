// PATCH /api/ai/knowledge-item?id=... … ナレッジの編集・有効/無効の切り替え。
// 管理者・人事（canManageHr）のみ。削除は行わない（無効化で十分。履歴も残る）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { CATEGORY_CODES } from "../../lib/ai-knowledge.js";
import { gwLog } from "../../lib/gw-audit.js";

const SQL = "db/110_ai_assistant.sql";
const SCOPES = ["all", "hr", "finance", "admin"];

export default async function handler(req, res) {
  if (req.method !== "PATCH") return methodNotAllowed(res, ["PATCH"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const id = new URL(req.url, "http://x").searchParams.get("id");
  if (!id) return json(res, 400, { error: "id_required" });

  const body = await readJson(req);
  const patch = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) {
    const title = String(body.title || "").trim();
    if (!title) return json(res, 400, { error: "title_required" });
    patch.title = title;
  }
  if (body.content !== undefined) {
    const content = String(body.content || "").trim();
    if (!content) return json(res, 400, { error: "content_required" });
    patch.content = content;
  }
  if (body.category !== undefined) {
    if (!CATEGORY_CODES.includes(body.category)) return json(res, 400, { error: "invalid_category" });
    patch.category = body.category;
  }
  if (body.accessScope !== undefined) {
    if (!SCOPES.includes(body.accessScope)) return json(res, 400, { error: "invalid_access_scope" });
    patch.access_scope = body.accessScope;
  }
  if (body.linkUrl !== undefined) patch.link_url = body.linkUrl || null;
  if (body.linkLabel !== undefined) patch.link_label = body.linkLabel || null;
  if (body.isActive !== undefined) patch.is_active = Boolean(body.isActive);

  const sb = admin();
  try {
    const { data: existing } = await sb.from("gw_ai_knowledge").select("id, tenant_id").eq("id", id).maybeSingle();
    if (!existing || existing.tenant_id !== ctx.tenantId) return json(res, 404, { error: "not_found" });

    const { error } = await sb.from("gw_ai_knowledge").update(patch).eq("id", id);
    if (error) throw error;

    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "ai.knowledge.update", target: id, detail: patch });
    return json(res, 200, { ok: true });
  } catch (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { notReady: true, message: hint });
    return json(res, 500, { error: "db_error", detail: error.message });
  }
}
