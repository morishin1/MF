// POST /api/employees/roles  { employeeId, role, grant }
// 社内ロール（owner / hr / manager / labor_advisor …）の付け外し。
//
// これは会計側の権限（memberships.role）とは別軸で、会計の可否には影響しない。
// 付け外しができるのは人事権限を持つ人だけ（RLS: gw_role_grants_hr_write）。
//
// ■ owner（経営者）だけは別扱い
//   経営（/keiei）に入れるのは owner だけなので、owner の付与・剥奪ができるのは
//   いまの owner だけ。管理者・人事は、ほかのロールは付け外しできても owner は触れない。
//   （この API と、DB の RLS・トリガ db/099 の両方で止める）
//
//   ・最後の（在籍中の）owner は外せない。経営画面に誰も入れなくなるため
//   ・owner の付与・剥奪は必ず履歴に残す（gw_activity_log の owner.grant / owner.revoke）

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr, isOwner } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { guardLastOwner, INACTIVE } from "../../lib/owner-guard.js";
import { adminFlags, accessForMember } from "../../lib/member-access.js";

// it=IT・管理（PC・アカウント・権限）、finance=経理（給与・精算）。
// 入退社のチェックリストは、この役割から担当者を1人決める（lib/hr-flow.js）。
// 役割が誰にも付いていないと「担当未定」のまま誰もやらない。
// recruiter=採用担当（採用HR /hr だけを許可。人事の全権限は渡さない）
// sales=営業担当（営業アタック管理 /sales だけを許可。db/088）
const ROLES = ["owner", "hr", "it", "finance", "manager", "labor_advisor", "recruiter", "sales"];

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 個人情報を返す。対象の人は二段階認証（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "社内ロールの変更には管理者権限が必要です" });
  }

  const body = await readJson(req);
  const { employeeId, role } = body || {};
  const grant = body?.grant !== false;
  if (!employeeId || !role) return json(res, 400, { error: "invalid_body", required: ["employeeId", "role"] });
  if (!ROLES.includes(role)) return json(res, 400, { error: "invalid_role", detail: ROLES.join(", ") });

  // owner の付与・剥奪は、いまの owner だけ。管理者・人事でも触れない
  if (role === "owner" && !isOwner(ctx)) {
    return json(res, 403, {
      error: "owner_only",
      hint: "経営者権限の付与・剥奪は、いまの経営者だけができます",
    });
  }

  const sb = userClient(req);

  // 対象は、このテナントの社員であること
  const { data: target } = await admin()
    .from("gw_employees").select("id, display_name, status, user_id")
    .eq("tenant_id", ctx.tenantId).eq("id", employeeId).maybeSingle();
  if (!target) return json(res, 404, { error: "employee_not_found" });

  if (grant) {
    // 退職した人に経営者権限を付けても、誰も入れない。付けた気になるのを防ぐ
    if (role === "owner" && INACTIVE.includes(target.status)) {
      return json(res, 409, {
        error: "employee_inactive",
        hint: "退職（手続き中を含む）の人には、経営者権限を付けられません",
      });
    }
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
    if (role === "owner") {
      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id, action: "owner.grant",
        target: `employee:${employeeId}`, detail: { name: target.display_name, via: "api" },
      });
    }
    return json(res, 200, { ok: true, employeeId, role, granted: true, ...(await accessAfter(ctx.tenantId, target)) });
  }

  // 最後の（在籍中の）owner を外させない。自分を外して誰もいなくなる事故も、ここで止まる
  if (role === "owner") {
    const stop = await guardLastOwner(admin(), ctx.tenantId, employeeId, "外す");
    if (stop) return json(res, stop.status, stop.body);
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
  if (role === "owner") {
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "owner.revoke",
      target: `employee:${employeeId}`,
      detail: { name: target.display_name, via: "api", self: ctx.employee?.id === employeeId },
    });
  }
  return json(res, 200, { ok: true, employeeId, role, granted: false, ...(await accessAfter(ctx.tenantId, target)) });
}

/**
 * 変更したあとの、その人の社内権限と「利用できる業務」。画面は、これで同じ行をその場で直す。
 * 判定は lib/gw.js の accessOf（= その人が画面を再読込したあとに /api/me で受け取る access）そのもの。
 * 読めなかったときは何も返さない（権限の付け外しそのものは成功している。画面は名簿を読み直す）
 */
async function accessAfter(tenantId, target) {
  try {
    const { data, error } = await admin().from("gw_role_grants").select("role")
      .eq("tenant_id", tenantId).eq("employee_id", target.id);
    if (error) return {};
    const roles = (data || []).map((g) => g.role);
    // access と accessMeta（accessOf に渡した isAdmin）。画面は同じ行の「利用できる業務」と注記を、この2つで直す
    return { roles, ...accessForMember(roles, target.user_id, await adminFlags(admin(), [target.user_id])) };
  } catch { return {}; }
}
