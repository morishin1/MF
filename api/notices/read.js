// POST /api/notices/read  { noticeId }
// お知らせを既読にする。既に既読なら何もしない（冪等）。
//
// 既読は「自分の分だけ」しか作れない（RLS: gw_notice_reads_insert）。
// employee_id はクライアントから受け取らず、サーバ側でログインユーザーから引く。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships } from "../../lib/auth.js";
import { userClient, admin } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const body = await readJson(req);
  const noticeId = body?.noticeId;
  if (!noticeId) return json(res, 400, { error: "invalid_body", required: ["noticeId"] });

  const memberships = await getMemberships(user.id);
  if (!memberships.length) return json(res, 403, { error: "no_membership" });
  const staff = memberships.find((m) => m.role === "admin" || m.role === "staff");
  const tenantId = (staff || memberships[0]).tenant_id;

  const { data: employee } = await admin()
    .from("gw_employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!employee) return json(res, 200, { ok: true, skipped: "not_enrolled" });

  // 読めないお知らせを既読にはできない。select は RLS 越しに行う
  const sb = userClient(req);
  const { data: notice } = await sb
    .from("gw_notices")
    .select("id")
    .eq("id", noticeId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!notice) return json(res, 404, { error: "notice_not_found" });

  const { error } = await sb
    .from("gw_notice_reads")
    .upsert(
      { tenant_id: tenantId, notice_id: noticeId, employee_id: employee.id },
      { onConflict: "notice_id,employee_id", ignoreDuplicates: true }
    );
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });

  return json(res, 200, { ok: true });
}
