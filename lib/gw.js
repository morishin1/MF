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
  const sb = admin();

  // ■ 待つ理由のないものを、順番に待たない
  //
  //   所属（memberships）と社員名簿（gw_employees）は、
  //   どちらも user_id で引くだけで、互いの結果を使わない。
  //   なのに順番に待っていたので、画面を出すまでの往復が1本ぶん多かった。
  //   ここは管理側のほぼ全部の API が通るので、1本でもよく効く。
  //
  //   社員名簿は、会計側のメンバーシップが無い人（社労士など）もここで拾う。
  //   社労士に会計の権限を持たせないため、テナントの特定を memberships だけに
  //   頼らない。テーブル未作成（マイグレーション未適用）でも落とさない。
  const [memberships, emp] = await Promise.all([
    getMemberships(userId),
    sb.from("gw_employees")
      .select("id, tenant_id, display_name, email, department, position, employment_type, "
            + "joined_on, status, manager_id, initial_role, work_style, job_family_code, autonomy_level")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle(),
  ]);
  const staff = memberships.find((m) => m.role === "admin" || m.role === "staff");
  const employee = emp.data || null;

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

/**
 * 端末の登録解除・資格情報の失効ができるか。
 *
 * 台帳を見る・停止するところまでは人事の担当者でもできる（canManageHr）。
 * ただし「削除」と「紛失」は取り消しがきかない。
 *
 *   ・削除  … そのPCからエージェントが消える。押し直しても戻らない
 *   ・紛失  … 資格情報がその場で死ぬ。入れ直すまで、そのPCは何も送れない
 *
 * 押し間違いの被害が大きいので、管理者と経営者だけにする。
 */
export const canWipeDevice = (ctx) => Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));

/**
 * 採用HR（/hr）を使えるか。管理者・経営者・人事・採用担当。
 * DB側の gw_is_recruiting（db/081）と同じ判定基準（gw_is_hr の上位互換）。
 * recruiter は採用機能だけを許可し、給与台帳・入退社機微・会計・他の人事機密は
 * canManageHr / gw_is_hr の対象のまま（recruiter 単体では届かない）
 */
export const canRecruit = (ctx) => canManageHr(ctx) || (ctx.roles || []).includes("recruiter");

/**
 * 採用判断（社長推薦の最終判断）ができるか。CEO REVIEWの実行権限。
 * 採用HRを使える人の中でも、経営者ロール・管理者だけに絞る
 * （recruiter・hr だけでは判断そのものは押せない。候補を挙げるところまで）
 */
export const canDecideHire = (ctx) => Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));

/**
 * 営業アタック管理（/sales）を使えるか。管理者・経営者・マネージャー・営業担当。
 * DB側の gw_is_sales（db/088）と同じ判定基準
 */
export const canSell = (ctx) => Boolean(ctx.isAdmin
  || ["owner", "manager", "sales"].some((r) => (ctx.roles || []).includes(r)));

/**
 * 直近30日以内にアタック済みの会社へ、それでもアタックできるか（要件 §20）。
 * 同じ会社へ短期間に何度もフォーム営業しないための例外なので、管理者・経営者だけ
 */
export const canForceAttack = (ctx) => Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));
