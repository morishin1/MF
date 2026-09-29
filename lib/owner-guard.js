// 経営者（owner）の保護。
//
// 経営（/keiei）は owner だけが入る。その owner を、管理者や人事が
// 自分のものにしたり、外したり、ログインを乗っ取ったりできてはいけない。
// 「owner の付与だけ」を塞いでも、次のどれかが開いていれば意味がなくなる。
//
//   ・owner の付与・剥奪              （api/employees/roles.js）
//   ・owner のログイン（メール・パスワード）を書き換えて、その人になりすます
//                                     （api/employees/account.js・link.js）
//   ・owner を退職にする・名簿から消す （api/employees/index.js）
//
// ここに「対象が owner か」「最後の owner か」の判定を1か所にまとめ、
// 上のすべてから同じ関数を呼ぶ。DB 側は db/099 のトリガが同じ内容を守る（最後の砦）。

import { isOwner } from "./gw.js";

/** 在籍中とみなさない状態（api/employees/index.js の LEFT と同じ） */
export const INACTIVE = ["leaving", "left"];

/** その社員が owner か */
export async function isOwnerEmployee(sb, tenantId, employeeId) {
  if (!employeeId) return false;
  const { data } = await sb
    .from("gw_role_grants").select("id")
    .eq("tenant_id", tenantId).eq("employee_id", employeeId).eq("role", "owner")
    .limit(1).maybeSingle();
  return Boolean(data);
}

/**
 * 在籍中の owner の人数。exceptEmployeeId を渡すと、その人を除いて数える
 * （「この人を外したら、何人残るか」を見るため）
 */
export async function activeOwnerCount(sb, tenantId, exceptEmployeeId = null) {
  const { data: grants } = await sb
    .from("gw_role_grants").select("employee_id")
    .eq("tenant_id", tenantId).eq("role", "owner");
  const ids = [...new Set((grants || []).map((g) => g.employee_id))]
    .filter((id) => id !== exceptEmployeeId);
  if (!ids.length) return 0;
  const { data: emps } = await sb
    .from("gw_employees").select("id, status")
    .eq("tenant_id", tenantId).in("id", ids);
  return (emps || []).filter((e) => !INACTIVE.includes(e.status)).length;
}

const ownerOnly = (hint) => ({ status: 403, body: { error: "owner_only", hint } });

/**
 * 呼び出した人が owner でないのに、owner の社員を操作しようとしていないか。
 * 止めるべきなら { status, body }、問題なければ null。
 * 本人（owner 自身）と、ほかの owner は操作できる。
 */
export async function guardOwnerTarget(sb, ctx, employeeId, action = "変更") {
  if (isOwner(ctx)) return null;
  if (!(await isOwnerEmployee(sb, ctx.tenantId, employeeId))) return null;
  return ownerOnly(`経営者の${action}は、経営者だけができます`);
}

/**
 * 最後の（在籍中の）owner をいなくしてしまう操作を止める。
 * 止めるべきなら { status, body }、問題なければ null。
 *
 * 対象が owner でない、または もともと在籍中でない人は、人数が減らないので通す。
 * 「経営画面に誰も入れなくなる」事故を防ぐための、API 側の入口
 */
export async function guardLastOwner(sb, tenantId, employeeId, action = "外す") {
  if (!(await isOwnerEmployee(sb, tenantId, employeeId))) return null;
  const { data: emp } = await sb
    .from("gw_employees").select("id, status")
    .eq("tenant_id", tenantId).eq("id", employeeId).maybeSingle();
  if (emp && INACTIVE.includes(emp.status)) return null;
  if ((await activeOwnerCount(sb, tenantId, employeeId)) > 0) return null;
  return {
    status: 409,
    body: {
      error: "last_owner",
      hint: `在籍中の経営者がいなくなり、経営画面に誰も入れなくなるため${action}ことはできません。` +
            "先に、ほかの人に経営者権限を付けてください",
    },
  };
}
