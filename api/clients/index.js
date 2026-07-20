// GET  /api/clients            … アクセスできる取引先一覧（RLSで分離）
// POST /api/clients  {name, useMf} … 取引先を追加（admin/staff のみ）
//   useMf=true  → accounting_software='mf'（MF連携を使う）
//   useMf=false → accounting_software='none'（MFを使わない：試算表は自社集計）

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships } from "../../lib/auth.js";
import { userClient, admin } from "../../lib/supabase.js";
import { audit } from "../../lib/audit.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    const sb = userClient(req); // ← RLS が auth.uid() を解決
    const { data, error } = await sb
      .from("clients")
      .select("id, name, industry, accounting_software")
      .order("name", { ascending: true });
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
    return json(res, 200, { clients: data || [] });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const name = (body?.name || "").trim();
    const useMf = body?.useMf !== false; // 既定はMF連携あり
    let tenantId = body?.tenantId || null;
    if (!name) return json(res, 400, { error: "invalid_body", required: ["name"] });

    // admin/staff のテナントを特定（tenantId指定時はその所属を確認）
    const memberships = await getMemberships(user.id);
    const staffTenants = memberships.filter((m) => m.role === "admin" || m.role === "staff").map((m) => m.tenant_id);
    if (!staffTenants.length) return json(res, 403, { error: "forbidden_not_admin" });
    if (tenantId) {
      if (!staffTenants.includes(tenantId)) return json(res, 403, { error: "forbidden_tenant" });
    } else {
      tenantId = staffTenants[0];
    }

    const sb = admin();
    const { data: created, error } = await sb
      .from("clients")
      .insert({ tenant_id: tenantId, name, accounting_software: useMf ? "mf" : "none" })
      .select("id, name, industry, accounting_software")
      .single();
    if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

    await audit({
      tenantId, clientId: created.id, actorId: user.id,
      action: "client.created", target: `client:${created.id}`,
      detail: { name, accounting_software: created.accounting_software },
    });
    return json(res, 200, { client: created });
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}
