// POST /api/ai/feedback … AIの回答への評価（役に立った／違っている）。
// 1メッセージにつき本人の評価は1つ（押し直すと上書き）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";

const SQL = "db/113_ai_assistant.sql";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  const body = await readJson(req);
  const messageId = body.messageId;
  const rating = body.rating;
  if (!messageId || !["up", "down"].includes(rating)) {
    return json(res, 400, { error: "invalid_body" });
  }

  const sb = admin();
  try {
    const { data: message } = await sb.from("gw_ai_messages")
      .select("id, tenant_id, thread_id, role").eq("id", messageId).maybeSingle();
    if (!message || message.tenant_id !== ctx.tenantId || message.role !== "assistant") {
      return json(res, 404, { error: "not_found" });
    }
    const { data: thread } = await sb.from("gw_ai_threads")
      .select("id, employee_id").eq("id", message.thread_id).maybeSingle();
    if (!thread || thread.employee_id !== ctx.employee.id) return json(res, 404, { error: "not_found" });

    const { error } = await sb.from("gw_ai_feedback").upsert({
      tenant_id: ctx.tenantId, message_id: messageId, employee_id: ctx.employee.id,
      rating, comment: body.comment ? String(body.comment).slice(0, 500) : null,
    }, { onConflict: "message_id,employee_id" });
    if (error) throw error;

    return json(res, 200, { ok: true });
  } catch (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { notReady: true, message: hint });
    return json(res, 500, { error: "db_error", detail: error.message });
  }
}
