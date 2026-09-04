// GET   /api/notifications            … 自分あての通知（新しい順・最大50件）
// PATCH /api/notifications {id}       … 1件を既読にする
// PATCH /api/notifications {all:true} … すべて既読にする
//
// 見える範囲は RLS が決める（自分あてのみ）。管理者でも他人の通知は読めない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";

const FIELDS = "id, kind, title, body, link, read_at, created_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 社員名簿に未登録なら通知は届かない。エラーにはせず空で返す
  if (!ctx.tenantId || !ctx.employee) return json(res, 200, { notifications: [], unread: 0 });

  const sb = userClient(req);

  if (req.method === "GET") {
    const { data, error } = await sb
      .from("gw_notifications")
      .select(FIELDS)
      .eq("employee_id", ctx.employee.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    const list = data || [];
    return json(res, 200, {
      notifications: list,
      unread: list.filter((n) => !n.read_at).length,
    });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    const now = new Date().toISOString();

    let q = sb.from("gw_notifications").update({ read_at: now }).eq("employee_id", ctx.employee.id);
    if (body?.all) q = q.is("read_at", null);
    else if (body?.id) q = q.eq("id", body.id);
    else return json(res, 400, { error: "invalid_body", required: ["id または all"] });

    const { error } = await q;
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
    return json(res, 200, { ok: true });
  }

  return methodNotAllowed(res, ["GET", "PATCH"]);
}
