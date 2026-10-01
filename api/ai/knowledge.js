// GET /api/ai/knowledge  … ナレッジ一覧（管理画面用。無効なものも含め全部）
// POST /api/ai/knowledge … ナレッジを追加
// どちらも管理者・人事（canManageHr）のみ。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { CATEGORY_CODES } from "../../lib/ai-knowledge.js";
import { gwLog } from "../../lib/gw-audit.js";

const SQL = "db/110_ai_assistant.sql";
const SCOPES = ["all", "hr", "finance", "admin"];

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = admin();

  if (req.method === "GET") {
    try {
      const { data, error } = await sb.from("gw_ai_knowledge")
        .select("id, title, category, content, source_type, source_id, access_scope, link_url, link_label, is_active, updated_at")
        .eq("tenant_id", ctx.tenantId).order("updated_at", { ascending: false }).limit(500);
      if (error) throw error;
      return json(res, 200, { knowledge: data || [] });
    } catch (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 200, { notReady: true, message: hint, knowledge: [] });
      return json(res, 500, { error: "db_error", detail: error.message });
    }
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const title = String(body.title || "").trim();
    const content = String(body.content || "").trim();
    if (!title || !content) return json(res, 400, { error: "title_and_content_required" });
    if (!CATEGORY_CODES.includes(body.category)) return json(res, 400, { error: "invalid_category" });
    const accessScope = SCOPES.includes(body.accessScope) ? body.accessScope : "all";

    try {
      const { data, error } = await sb.from("gw_ai_knowledge").insert({
        tenant_id: ctx.tenantId, title, category: body.category, content,
        source_type: body.sourceType === "file" ? "file" : "manual", source_id: body.sourceId || null,
        access_scope: accessScope,
        link_url: body.linkUrl || null, link_label: body.linkLabel || null,
        is_active: body.isActive !== false, created_by: user.id,
      }).select("id, title, category, is_active").single();
      if (error) throw error;

      await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "ai.knowledge.create", target: data.id, detail: { title } });
      return json(res, 200, { knowledge: data });
    } catch (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 200, { notReady: true, message: hint });
      return json(res, 500, { error: "db_error", detail: error.message });
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}
