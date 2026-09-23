// GET /api/guests/options
//   外部メンバーへの許可（プロジェクト・チャット・資料・タスク）を選ぶための候補。
//   多すぎると選べなくなるので、それぞれ上限を絞って返す。
//
//   プロジェクトは gw_tasks.category の値そのもの（新しいマスタは無い）。
//   チャットはグループだけを候補にする（1対1は相手が2人しかおらず、
//   外部の人を混ぜる意味が無い）

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  const [tasksR, threadsR, libraryR] = await Promise.all([
    soft(() => sb.from("gw_tasks").select("id, title, category")
      .eq("tenant_id", ctx.tenantId).neq("status", "cancelled").eq("is_template", false)
      .order("created_at", { ascending: false }).limit(300)),
    soft(() => sb.from("gw_threads").select("id, title")
      .eq("tenant_id", ctx.tenantId).eq("kind", "group")
      .order("last_message_at", { ascending: false }).limit(200)),
    soft(() => sb.from("gw_library").select("id, title")
      .eq("tenant_id", ctx.tenantId).eq("published", true)
      .order("sort_order", { ascending: true }).limit(300)),
  ]);

  const tasks = tasksR.rows;
  const projects = [...new Set(tasks.map((t) => t.category).filter(Boolean))].sort();

  return json(res, 200, {
    projects: projects.map((p) => ({ key: p, label: p })),
    threads: threadsR.rows.map((t) => ({ key: t.id, label: t.title || "（無題のグループ）" })),
    documents: libraryR.rows.map((d) => ({ key: d.id, label: d.title })),
    tasks: tasks.map((t) => ({ key: t.id, label: t.title })),
  });
}

/** 列・表がまだ無い環境でも落とさない */
async function soft(fn) {
  try {
    const r = await fn();
    return { rows: r.error ? [] : (r.data || []) };
  } catch {
    return { rows: [] };
  }
}
