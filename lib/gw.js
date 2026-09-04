// グループウェア共通のコンテキスト解決。
//
// 「このリクエストの人は、どのテナントの、誰で、何ができるのか」を1か所にまとめる。
// api/me.js は既存の会計画面が依存しているので触らず、新しい画面はこちらを使う。
//
// 注意: ここで返す isHr / isAdvisor は画面の出し分けと入口チェックのためのもの。
//       実際の可視範囲は DB 側の RLS が決める。API 層の if は境界ではない。

import { getMemberships } from "./auth.js";
import { admin } from "./supabase.js";

/**
 * @returns {Promise<{
 *   tenantId: string|null, isAdmin: boolean, memberships: object[],
 *   employee: object|null, roles: string[], isHr: boolean, isAdvisor: boolean
 * }>}
 */
export async function gwContext(userId) {
  const memberships = await getMemberships(userId);
  const staff = memberships.find((m) => m.role === "admin" || m.role === "staff");

  const sb = admin();

  // 社員名簿の行。会計側のメンバーシップが無い人（社労士など）もここで拾う。
  // 社労士に会計の権限を持たせないため、テナントの特定を memberships だけに
  // 頼らない。テーブル未作成（マイグレーション未適用）でも落とさない。
  let employee = null;
  {
    const { data } = await sb
      .from("gw_employees")
      .select("id, tenant_id, display_name, email, department, position, employment_type, joined_on, status")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    employee = data || null;
  }

  const tenantId =
    (staff || memberships[0])?.tenant_id || employee?.tenant_id || null;

  const base = {
    tenantId, isAdmin: !!staff, memberships,
    employee: null, roles: [], isHr: false, isAdvisor: false,
  };
  // 名簿の行が別テナントのものだった場合は使わない（多重所属は想定しない）
  if (!tenantId || !employee || employee.tenant_id !== tenantId) return base;

  const { data: grants } = await sb
    .from("gw_role_grants")
    .select("role")
    .eq("employee_id", employee.id);
  const roles = (grants || []).map((g) => g.role);

  return {
    ...base,
    employee,
    roles,
    isHr: roles.includes("hr") || roles.includes("owner"),
    isAdvisor: roles.includes("labor_advisor"),
  };
}

// 人事の操作（社員名簿・手続きの編集）ができるか
export const canManageHr = (ctx) => ctx.isAdmin || ctx.isHr;
