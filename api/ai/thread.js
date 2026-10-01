// GET /api/ai/thread?threadId=... … 1つのAI相談の中身（メッセージ・出典・自分の評価・
// 引き継ぎ済みの問い合わせの有無）。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";

const SQL = "db/113_ai_assistant.sql";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  const threadId = new URL(req.url, "http://x").searchParams.get("threadId");
  if (!threadId) return json(res, 400, { error: "thread_id_required" });

  const sb = admin();
  try {
    const { data: thread } = await sb.from("gw_ai_threads")
      .select("id, tenant_id, employee_id, title, category, status, created_at, updated_at")
      .eq("id", threadId).maybeSingle();
    if (!thread || thread.tenant_id !== ctx.tenantId || thread.employee_id !== ctx.employee.id) {
      return json(res, 404, { error: "not_found" });
    }

    const { data: messages, error } = await sb.from("gw_ai_messages")
      .select("id, role, content, created_at")
      .eq("thread_id", threadId).order("created_at", { ascending: true });
    if (error) throw error;

    const ids = (messages || []).map((m) => m.id);
    let sourcesByMessage = new Map();
    let myFeedback = new Map();
    if (ids.length) {
      const [{ data: sources }, { data: feedback }] = await Promise.all([
        sb.from("gw_ai_sources").select("id, message_id, knowledge_id, title, excerpt, link_url, link_label")
          .in("message_id", ids),
        sb.from("gw_ai_feedback").select("message_id, rating")
          .in("message_id", ids).eq("employee_id", ctx.employee.id),
      ]);
      for (const s of sources || []) {
        if (!sourcesByMessage.has(s.message_id)) sourcesByMessage.set(s.message_id, []);
        sourcesByMessage.get(s.message_id).push(s);
      }
      for (const f of feedback || []) myFeedback.set(f.message_id, f.rating);
    }

    const { data: inquiry } = await sb.from("gw_ai_inquiries")
      .select("id, status").eq("ai_thread_id", threadId).maybeSingle();

    return json(res, 200, {
      thread,
      messages: (messages || []).map((m) => ({
        ...m, sources: sourcesByMessage.get(m.id) || [], myRating: myFeedback.get(m.id) || null,
      })),
      inquiry: inquiry || null,
    });
  } catch (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { notReady: true, message: hint });
    return json(res, 500, { error: "db_error", detail: error.message });
  }
}
