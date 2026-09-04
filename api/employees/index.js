// GET    /api/employees          … 社員名簿の一覧（管理者・人事）
// POST   /api/employees          … 社員を追加（入社予定者は user_id なしで登録できる）
// PATCH  /api/employees {id,...} … 社員情報を更新
//
// 可視範囲・書き込み可否は RLS（db/005_groupware_core.sql）が決める。
// ここでの分岐は入口の親切表示のため。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";

const EMPLOYMENT_TYPES = ["正社員", "契約社員", "パート", "アルバイト", "業務委託", "役員", "その他"];
const STATUSES = ["invited", "active", "leaving", "left"];

const FIELDS =
  "id, tenant_id, user_id, display_name, email, department, position, employment_type, joined_on, left_on, work_location, status, created_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const { data, error } = await sb
      .from("gw_employees")
      .select(FIELDS)
      .eq("tenant_id", ctx.tenantId)
      .order("status", { ascending: true })
      .order("display_name", { ascending: true })
      .limit(500);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    // 社内ロールを添える。読めない立場（メンバー等）では空のまま返る
    const { data: grants } = await sb
      .from("gw_role_grants")
      .select("employee_id, role")
      .eq("tenant_id", ctx.tenantId);
    const byEmployee = new Map();
    for (const g of grants || []) {
      if (!byEmployee.has(g.employee_id)) byEmployee.set(g.employee_id, []);
      byEmployee.get(g.employee_id).push(g.role);
    }

    return json(res, 200, {
      employees: (data || []).map((e) => ({ ...e, roles: byEmployee.get(e.id) || [] })),
      canManage: canManageHr(ctx),
      canGrantRoles: ctx.isHr,
    });
  }

  if (req.method === "POST") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, row);

    const { data, error } = await sb
      .from("gw_employees")
      .insert({ ...row.value, tenant_id: ctx.tenantId })
      .select(FIELDS)
      .single();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    return json(res, 200, { employee: data });
  }

  if (req.method === "PATCH") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
    const row = normalize(body, { partial: true });
    if (row.error) return json(res, 400, row);

    const { data, error } = await sb
      .from("gw_employees")
      .update({ ...row.value, updated_at: new Date().toISOString() })
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .select(FIELDS)
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "employee_not_found" });
    return json(res, 200, { employee: data });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("display_name")) {
    const name = String(body.display_name ?? "").trim();
    if (!name) return { error: "invalid_body", detail: "display_name は必須です" };
    v.display_name = name;
  }
  if (has("email")) v.email = String(body.email || "").trim() || null;
  if (has("department")) v.department = String(body.department || "").trim() || null;
  if (has("position")) v.position = String(body.position || "").trim() || null;
  if (has("work_location")) v.work_location = String(body.work_location || "").trim() || null;
  if (has("joined_on")) v.joined_on = body.joined_on || null;
  if (has("left_on")) v.left_on = body.left_on || null;

  if (has("employment_type") && body.employment_type) {
    if (!EMPLOYMENT_TYPES.includes(body.employment_type)) {
      return { error: "invalid_employment_type", detail: EMPLOYMENT_TYPES.join(", ") };
    }
    v.employment_type = body.employment_type;
  }
  if (has("status") && body.status) {
    if (!STATUSES.includes(body.status)) return { error: "invalid_status", detail: STATUSES.join(", ") };
    v.status = body.status;
  }
  // user_id はここでは受け付けない。他人のアカウントに紐づけ替えられてしまうため、
  // 招待の受け入れ（アカウントとの紐づけ）は別の口で扱う。
  return { value: v };
}
