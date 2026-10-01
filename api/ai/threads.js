// GET /api/ai/threads … 自分のAI相談の一覧（新しい順）。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";

const SQL = "db/110_ai_assistant.sql";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  const sb = admin();
  try {
    const { data: threads, error } = await sb.from("gw_ai_threads")
      .select("id, title, category, status, updated_at, created_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id)
      .order("updated_at", { ascending: false }).limit(50);
    if (error) throw error;

    const ids = (threads || []).map((t) => t.id);
    let lastByThread = new Map();
    if (ids.length) {
      const { data: msgs } = await sb.from("gw_ai_messages")
        .select("thread_id, role, content, created_at")
        .in("thread_id", ids).order("created_at", { ascending: false });
      for (const m of msgs || []) if (!lastByThread.has(m.thread_id)) lastByThread.set(m.thread_id, m);
    }

    return json(res, 200, {
      threads: (threads || []).map((t) => ({ ...t, lastMessage: lastByThread.get(t.id) || null })),
    });
  } catch (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { notReady: true, message: hint, threads: [] });
    return json(res, 500, { error: "db_error", detail: error.message });
  }
}
