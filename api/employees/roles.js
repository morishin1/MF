// POST /api/employees/roles  { employeeId, role, grant }
// 社内ロール（owner / hr / manager / labor_advisor）の付け外し。
//
// これは会計側の権限（memberships.role）とは別軸で、会計の可否には影響しない。
// 付け外しができるのは人事権限を持つ人だけ（RLS: gw_role_grants_hr_write）。
//
// 自分の owner を自分で外して、誰も管理できなくなる事故を防ぐため、
// 最後の owner は外せないようにしている。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const ROLES = ["owner", "hr", "manager", "labor_advisor"];

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.isHr) return json(res, 403, { error: "forbidden", hint: "社内ロールの変更は人事権限が必要です" });

  const body = await readJson(req);
  const { employeeId, role } = body || {};
  const grant = body?.grant !== false;
  if (!employeeId || !role) return json(res, 400, { error: "invalid_body", required: ["employeeId", "role"] });
  if (!ROLES.includes(role)) return json(res, 400, { error: "invalid_role", detail: ROLES.join(", ") });

  const sb = userClient(req);

  if (grant) {
    const { error } = await sb
      .from("gw_role_grants")
      .upsert(
        { tenant_id: ctx.tenantId, employee_id: employeeId, role, granted_by: user.id },
        { onConflict: "employee_id,role", ignoreDuplicates: true }
      );
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "role.grant",
      target: `employee:${employeeId}`, detail: { role },
    });
    return json(res, 200, { ok: true, employeeId, role, granted: true });
  }

  // 最後の owner を外させない
  if (role === "owner") {
    const { count } = await admin()
      .from("gw_role_grants")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId)
      .eq("role", "owner");
    if ((count ?? 0) <= 1) {
      return json(res, 409, { error: "last_owner", hint: "経営者権限を持つ人が居なくなるため外せません" });
    }
  }

  const { error } = await sb
    .from("gw_role_grants")
    .delete()
    .eq("tenant_id", ctx.tenantId)
    .eq("employee_id", employeeId)
    .eq("role", role);
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "role.revoke",
    target: `employee:${employeeId}`, detail: { role },
  });
  return json(res, 200, { ok: true, employeeId, role, granted: false });
}
