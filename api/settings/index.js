// GET   /api/settings        … 会社情報・取引先・部署一覧・連携状況
// PATCH /api/settings {name} … 会社名の変更（管理者・人事）
//
// tenants には UPDATE のポリシーを置いていない（会計側の既存挙動を変えないため）。
// そのため変更はここを唯一の口にして、権限を確かめてから service_role で書く。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { isConfigured as driveConfigured } from "../../lib/gdrive.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const [tenantRes, clientsRes, employeesRes] = await Promise.all([
      sb.from("tenants").select("id, name").eq("id", ctx.tenantId).maybeSingle(),
      sb.from("clients").select("id, name, accounting_software").order("name", { ascending: true }),
      sb.from("gw_employees").select("id, display_name, email, department, status, user_id")
        .eq("tenant_id", ctx.tenantId).limit(500),
    ]);

    const employees = employeesRes.data || [];
    const departments = [...new Set(employees.map((e) => e.department).filter(Boolean))].sort();

    return json(res, 200, {
      tenant: tenantRes.data || { id: ctx.tenantId, name: null },
      clients: clientsRes.data || [],
      departments,
      counts: {
        employees: employees.length,
        active: employees.filter((e) => e.status === "active").length,
        unlinked: employees.filter((e) => !e.user_id).length,
      },
      // 紐づけ待ちの人。管理設定の画面から結び付ける
      unlinked: employees
        .filter((e) => !e.user_id)
        .map(({ id, display_name, email, department }) => ({ id, display_name, email, department })),
      integrations: {
        drive: driveConfigured(),
        slack: !!process.env.SLACK_WEBHOOK_URL,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
      },
      me: { isAdmin: ctx.isAdmin, isHr: ctx.isHr, roles: ctx.roles, employee: ctx.employee },
      canManage: canManageHr(ctx),
    });
  }

  if (req.method === "PATCH") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    const name = String(body?.name || "").trim();
    if (!name) return json(res, 400, { error: "invalid_body", required: ["name"] });

    const { data, error } = await admin()
      .from("tenants")
      .update({ name })
      .eq("id", ctx.tenantId)
      .select("id, name")
      .single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    return json(res, 200, { tenant: data });
  }

  return methodNotAllowed(res, ["GET", "PATCH"]);
}
