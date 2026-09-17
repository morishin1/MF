// 入社手続き画面を、誰が開いているか。純粋関数。
//
// ■ ここで決めるのは「開けるか」だけ
//
//   開けたあとに何が見えるかは、ここでは決めない（DB の RLS が決める。
//   lib/gw.js の注記と同じ考え方）。ここで決めるのは、
//   「他人の入社手続きを開こうとしているこの人に、そもそも入口を見せてよいか」
//   という、画面に入る前の1回だけの判定。
//
// ■ 3つしかない
//
//   本人（self）・管理者（admin）・社労士（advisor）。
//   それ以外の一般メンバーは、他人の入社手続きを開けない。

export const VIEWER_ROLES = ["self", "admin", "advisor"];
export const ROLE_LABEL = { self: "本人", admin: "管理者", advisor: "社労士" };

/**
 * @param {object} ctx        gwContext() の戻り値（employee / isAdmin / isHr / isAdvisor）
 * @param {string|null} employeeId  見ようとしている相手。空なら自分
 * @returns {{ok:true, role:string, employeeId:string}|{ok:false, reason:string}}
 */
export function resolveViewer(ctx, employeeId) {
  if (!ctx?.employee) return { ok: false, reason: "no_employee" };

  const target = employeeId || ctx.employee.id;
  if (target === ctx.employee.id) return { ok: true, role: "self", employeeId: target };

  if (ctx.isAdmin || ctx.isHr) return { ok: true, role: "admin", employeeId: target };
  if (ctx.isAdvisor) return { ok: true, role: "advisor", employeeId: target };

  return { ok: false, reason: "forbidden" };
}

export const roleLabel = (role) => ROLE_LABEL[role] || role;
