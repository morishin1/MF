// GET /api/requests/grants?year=YYYY   … 全員の有給の付与日数と残日数（管理部）
// PUT /api/requests/grants             … 付与日数の登録・更新（管理部）
//
// 付与のルール（勤続年数に応じた日数、繰越の上限、時季指定義務）は労務側の判断で、
// ここでは計算しない。管理部が入れた数をそのまま残日数の元にする。
// 中途半端に自動計算すると、合っているのか間違っているのか誰にも分からなくなる。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { fiscalYear, leaveBalance } from "../../lib/requests.js";
import { gwLog } from "../../lib/gw-audit.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = admin();

  if (req.method === "GET") {
    const year = Number(new URL(req.url, "http://localhost").searchParams.get("year")) || fiscalYear();

    const { data: employees, error } = await sb
      .from("gw_employees")
      .select("id, display_name, department, employment_type, status")
      .eq("tenant_id", ctx.tenantId)
      .neq("status", "left")
      .order("display_name");
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    const rows = await Promise.all((employees || []).map(async (e) => ({
      employee: e,
      ...(await leaveBalance(e.id, year)),
    })));
    return json(res, 200, { year, rows });
  }

  if (req.method === "PUT") {
    const body = await readJson(req);
    const year = Number(body?.year) || fiscalYear();
    if (!body?.employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

    const granted = num(body.grantedDays);
    const carried = num(body.carriedDays);
    if (granted === null || carried === null) {
      return json(res, 400, { error: "invalid_days", hint: "0以上の数字（0.5刻み）で入れてください" });
    }

    const { error } = await sb.from("gw_leave_grants").upsert({
      employee_id: body.employeeId,
      tenant_id: ctx.tenantId,
      fiscal_year: year,
      granted_days: granted,
      carried_days: carried,
      note: body.note ? String(body.note).slice(0, 300) : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "employee_id,fiscal_year" });
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    // 付与日数は残日数の根拠になる。誰がいつ変えたかを追えるようにする
    await gwLog({
      tenantId: ctx.tenantId, actorId: ctx.employee?.id || null,
      action: "leave.grant_updated", target: body.employeeId,
      detail: { year, granted, carried },
    });
    return json(res, 200, { ok: true, balance: await leaveBalance(body.employeeId, year) });
  }

  return methodNotAllowed(res, ["GET", "PUT"]);
}

// 0.5刻みの日数。負の値と刻みのずれを弾く
function num(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 400) return null;
  // 0.5 刻みから外れた値は黙って丸めず弾く。入力の間違いに気づけなくなるため
  if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) return null;
  return Math.round(n * 2) / 2;
}
