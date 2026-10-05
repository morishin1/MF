// 内部ロール（gw_role_grants）の付け外し。POST /api/employees/roles と、経営ボタン（POST /api/employees/apps の keiei）が共有する。
//
// これは会計側の権限（memberships.role）とは別軸で、会計の可否には影響しない。
// 付け外しができるのは人事権限を持つ人だけ（RLS: gw_role_grants_hr_write）。
//
// ■ owner（経営者）だけは別扱い
//   経営（/keiei）に入れるのは owner だけなので、owner の付与・剥奪ができるのは
//   いまの owner だけ。管理者・人事は、ほかのロールは付け外しできても owner は触れない。
//   （この処理と、DB の RLS・トリガ db/099 の両方で止める）
//
//   ・最後の（在籍中の）owner は外せない。経営画面に誰も入れなくなるため
//   ・owner の付与・剥奪は必ず履歴に残す（gw_activity_log の owner.grant / owner.revoke）
import { isOwner } from "./gw.js";
import { admin } from "./supabase.js";
import { gwLog } from "./gw-audit.js";
import { guardLastOwner, INACTIVE } from "./owner-guard.js";
import { adminFlags, accessForMember } from "./member-access.js";
import { readApps, resolveApps } from "./app-grants.js";

// it=IT・管理（PC・アカウント・権限）、finance=経理（給与・精算）。
// 入退社のチェックリストは、この役割から担当者を1人決める（lib/hr-flow.js）。
// 役割が誰にも付いていないと「担当未定」のまま誰もやらない。
// recruiter=採用担当 / sales=営業担当（どちらも、アプリの中の役割。入口はアプリ利用権限 gw_app_grants）
export const ROLES = ["owner", "hr", "it", "finance", "manager", "labor_advisor", "recruiter", "sales"];

/**
 * @returns {Promise<{status:number, body:object, target?:object}>} 成功したときは target（社員の行）も返す
 */
export async function changeRole({ ctx, user, sb, employeeId, role, grant }) {
  if (!employeeId || !role) return { status: 400, body: { error: "invalid_body", required: ["employeeId", "role"] } };
  if (!ROLES.includes(role)) return { status: 400, body: { error: "invalid_role", detail: ROLES.join(", ") } };

  // owner の付与・剥奪は、いまの owner だけ。管理者・人事でも触れない
  if (role === "owner" && !isOwner(ctx)) {
    return { status: 403, body: { error: "owner_only", hint: "経営者権限の付与・剥奪は、いまの経営者だけができます" } };
  }

  // 対象は、このテナントの社員であること
  const { data: target } = await admin()
    .from("gw_employees").select("id, display_name, status, user_id")
    .eq("tenant_id", ctx.tenantId).eq("id", employeeId).maybeSingle();
  if (!target) return { status: 404, body: { error: "employee_not_found" } };

  if (grant) {
    // 退職した人に経営者権限を付けても、誰も入れない。付けた気になるのを防ぐ
    if (role === "owner" && INACTIVE.includes(target.status)) {
      return { status: 409, body: { error: "employee_inactive", hint: "退職（手続き中を含む）の人には、経営者権限を付けられません" } };
    }
    const { error } = await sb
      .from("gw_role_grants")
      .upsert(
        { tenant_id: ctx.tenantId, employee_id: employeeId, role, granted_by: user.id },
        { onConflict: "employee_id,role", ignoreDuplicates: true }
      );
    if (error) return { status: error.code === "42501" ? 403 : 500, body: { error: "db_insert_failed", detail: error.message } };
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
    return { status: 200, body: { ok: true, employeeId, role, granted: true }, target };
  }

  // 最後の（在籍中の）owner を外させない。自分を外して誰もいなくなる事故も、ここで止まる
  if (role === "owner") {
    const stop = await guardLastOwner(admin(), ctx.tenantId, employeeId, "外す");
    if (stop) return { status: stop.status, body: stop.body };
  }

  const { error } = await sb
    .from("gw_role_grants")
    .delete()
    .eq("tenant_id", ctx.tenantId)
    .eq("employee_id", employeeId)
    .eq("role", role);
  if (error) return { status: error.code === "42501" ? 403 : 500, body: { error: "db_delete_failed", detail: error.message } };
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
  return { status: 200, body: { ok: true, employeeId, role, granted: false }, target };
}

/**
 * 変更したあとの、その人の内部ロール・4つのボタン・「利用できる業務」。画面は、これで同じ行をその場で直す。
 * 判定は lib/gw.js の accessOf（= その人が画面を再読込したあとに /api/me で受け取る access）そのもの。
 * 読めなかったときは何も返さない（付け外しそのものは成功している。画面は名簿を読み直す）
 */
export async function afterChange(tenantId, target) {
  try {
    const sb = admin();
    const [{ data, error }, appsRead] = await Promise.all([
      sb.from("gw_role_grants").select("role").eq("tenant_id", tenantId).eq("employee_id", target.id),
      readApps(sb, target.id),
    ]);
    if (error) return {};
    const roles = (data || []).map((g) => g.role);
    const { apps, state } = resolveApps(appsRead, roles);
    // access・accessMeta・apps（4つのボタン）・appLocks。画面は同じ行の表示と注記を、これで直す
    return { roles, appsState: state, ...accessForMember(roles, target.user_id, await adminFlags(sb, [target.user_id]), apps) };
  } catch { return {}; }
}
