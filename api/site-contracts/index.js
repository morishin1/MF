// GET    /api/site-contracts?employeeId=…  … 現場契約の一覧（対象者で絞れる）
// POST   /api/site-contracts               … 追加
// PATCH  /api/site-contracts {id,...}      … 更新
// DELETE /api/site-contracts?id=…          … 削除
//
// 単価・精算条件は機微情報。可視範囲・書き込み可否は RLS
// （db/076_site_contracts.sql、社内スタッフだけ）が決める。ここでの分岐は入口の親切表示のため。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { normalizeSiteContract } from "../../lib/site-contracts.js";

const SQL = "db/076_site_contracts.sql";
const FIELDS = "id, tenant_id, employee_id, engagement_kind, site_company, prime_company, "
  + "period_from, period_to, unit_price, unit_price_type, settlement_condition, "
  + "renewal_status, note, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 単価・精算条件という、社外は元より社内でも見る人を絞りたい情報を返す
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return create(req, res, sb, ctx, user);
  if (req.method === "PATCH") return update(req, res, sb, ctx, user);
  if (req.method === "DELETE") return remove(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

async function list(req, res, sb, ctx) {
  const employeeId = new URL(req.url, "http://localhost").searchParams.get("employeeId");
  let q = sb.from("gw_site_contracts").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).order("period_from", { ascending: false }).limit(500);
  if (employeeId) q = q.eq("employee_id", employeeId);

  const { data, error } = await q;
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { contracts: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  return json(res, 200, { contracts: data || [] });
}

async function create(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });
  const row = normalizeSiteContract(body);
  if (row.error) return json(res, 400, row);

  const { data: emp } = await sb.from("gw_employees").select("id, display_name")
    .eq("id", body.employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  const { data, error } = await sb.from("gw_site_contracts")
    .insert({ ...row.value, tenant_id: ctx.tenantId, employee_id: body.employeeId, created_by: user.id })
    .select(FIELDS).single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "site_contract.create",
    target: `site_contract:${data.id}`, detail: { employee: emp.display_name, site: data.site_company },
  });
  return json(res, 200, { contract: data });
}

async function update(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const row = normalizeSiteContract(body, { partial: true });
  if (row.error) return json(res, 400, row);

  const { data, error } = await sb.from("gw_site_contracts")
    .update({ ...row.value, updated_at: new Date().toISOString() })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select(FIELDS).maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "site_contract.update",
    target: `site_contract:${data.id}`, detail: { site: data.site_company, renewalStatus: data.renewal_status },
  });
  return json(res, 200, { contract: data });
}

async function remove(req, res, sb, ctx, user) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { data: target } = await sb.from("gw_site_contracts").select("id, site_company")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!target) return json(res, 404, { error: "not_found" });

  const { error } = await sb.from("gw_site_contracts").delete()
    .eq("id", id).eq("tenant_id", ctx.tenantId);
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "site_contract.delete",
    target: `site_contract:${id}`, detail: { site: target.site_company },
  });
  return json(res, 200, { ok: true, id });
}
