// POST /api/employees/link  { employeeId, email, clientId?, create?, password? }
// 社員名簿の行を、ログインアカウント（auth.users）に紐づける。
//
// アカウントが無ければここで作る（招待）。password を省略すると自動生成し、
// その1回だけ応答に含めて画面に出す。メール送信の設定に依存させないため、
// 本人へは管理者が直接伝える方式。
//
// 紐づけると、同じ auth.users を使っている社内システムにもまとめて登録される
// （無限道場・タイムカード・会計）。仕組みは lib/accounts.js の頭に書いた。
//
// 人事権限が必要。auth.users の操作は service_role で行う。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { attachAccount } from "../../lib/accounts.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.isHr) return json(res, 403, { error: "forbidden", hint: "紐づけには人事権限が必要です" });

  const body = await readJson(req);
  const { employeeId } = body || {};
  const email = String(body?.email || "").trim().toLowerCase();
  if (!employeeId || !email) return json(res, 400, { error: "invalid_body", required: ["employeeId", "email"] });

  const sb = admin();

  const { data: employee, error: ee } = await sb
    .from("gw_employees")
    .select("id, display_name, user_id, employment_type")
    .eq("id", employeeId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (ee) return json(res, 500, { error: "db_query_failed", detail: ee.message });
  if (!employee) return json(res, 404, { error: "employee_not_found" });

  const r = await attachAccount(sb, {
    tenantId: ctx.tenantId,
    employee,
    email,
    password: body?.password,
    create: body?.create !== false,
    clientId: body?.clientId,
  });
  if (!r.ok) {
    const { ok, status, ...rest } = r;
    return json(res, status || 400, rest);
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: r.createdPassword ? "account.create" : "account.link",
    target: `employee:${employeeId}`,
    detail: { email, name: employee.display_name },   // パスワードは残さない
  });

  return json(res, 200, {
    ok: true, employeeId,
    userId: r.userId, createdPassword: r.createdPassword,
    membership: r.membership, systems: r.systems,
  });
}
