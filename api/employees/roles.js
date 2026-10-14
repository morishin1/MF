// POST /api/employees/roles  { employeeId, role, grant }
// 内部ロール（owner / hr / finance / manager / recruiter / sales / it / labor_advisor）の付け外し。
//
// 内部ロールは「アプリの中で何ができるか」を決める。アプリへ入れるか（採用HR・Sales・Office）は、
// アプリ利用権限（POST /api/employees/apps, gw_app_grants）が決める。ロールを付けても入口は開かない。
// メンバー一覧の「詳細設定」から使う。付け外しの規則（owner の扱い・最後の経営者）は lib/role-change.js。
//
// これは会計側の権限（memberships.role）とは別軸で、会計の可否には影響しない。
// 付け外しができるのは人事権限を持つ人だけ（RLS: gw_role_grants_hr_write）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient } from "../../lib/supabase.js";
import { changeRole, afterChange } from "../../lib/role-change.js";

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

  const r = await changeRole({ ctx, user, sb: userClient(req), employeeId, role, grant });
  if (r.status !== 200) return json(res, r.status, r.body);
  return json(res, 200, { ...r.body, ...(await afterChange(ctx.tenantId, r.target)) });
}
