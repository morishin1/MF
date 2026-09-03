// GET /api/me
// ログインユーザーの基本情報とメンバーシップ（ロール）を返す。
// フロントの画面出し分け（member=アップロードのみ / admin=承認・分析）に使う。
//
// 出力: { email, userId, isAdmin, roles, memberships, gw, appRole }
//   gw      … 社内グループウェアの所属・ロール（db/005_groupware_core.sql 適用後に値が入る）
//              未適用の環境では available:false になるだけで、既存の会計機能には影響しない。
//   appRole … ログイン後の振り分け先（要件セクション4）
//              member → メンバー用ホーム / admin・owner → 管理者ダッシュボード / sr → 限定画面

import { json, methodNotAllowed } from "../lib/http.js";
import { requireUser, getMemberships } from "../lib/auth.js";
import { admin } from "../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const memberships = await getMemberships(user.id);
  const roles = [...new Set(memberships.map((m) => m.role))];
  // admin / staff は「管理者側」（承認・分析ができる）とみなす
  const isAdmin = memberships.some((m) => m.role === "admin" || m.role === "staff");

  // 社内グループウェアの所属テナント。自社1社運用なので staff 側の所属を優先する。
  const staffMembership = memberships.find((m) => m.role === "admin" || m.role === "staff");
  const tenantId = (staffMembership || memberships[0])?.tenant_id || null;

  const gw = await loadGroupware(user.id, tenantId);

  return json(res, 200, {
    email: user.email || null,
    userId: user.id,
    isAdmin,
    roles,
    memberships,
    gw,
    appRole: resolveAppRole({ isAdmin, gwRoles: gw.roles }),
  });
}

// 社員名簿と社内ロールを引く。005 未適用でも落とさない。
async function loadGroupware(userId, tenantId) {
  const empty = { available: false, tenantId, employee: null, roles: [], isHr: false, isOwner: false };
  if (!tenantId) return empty;

  const sb = admin();
  const { data: employee, error } = await sb
    .from("gw_employees")
    .select("id, display_name, email, department, position, employment_type, joined_on, status")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();

  // テーブルが無い（マイグレーション未適用）場合はここで抜ける。
  // 会計機能はグループウェアに依存しないので、エラーにはしない。
  if (error) return empty;

  if (!employee) return { ...empty, available: true };

  const { data: grants } = await sb
    .from("gw_role_grants")
    .select("role")
    .eq("employee_id", employee.id);

  const gwRoles = (grants || []).map((g) => g.role);
  return {
    available: true,
    tenantId,
    employee,
    roles: gwRoles,
    isHr: gwRoles.includes("hr") || gwRoles.includes("owner"),
    isOwner: gwRoles.includes("owner"),
  };
}

function resolveAppRole({ isAdmin, gwRoles }) {
  if (gwRoles.includes("labor_advisor")) return "sr";
  if (gwRoles.includes("owner")) return "owner";
  if (isAdmin) return "admin";
  return "member";
}
