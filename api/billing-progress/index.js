// GET   /api/billing-progress?month=YYYY-MM[&employeeId=…][&siteContractId=…]
//         … 進捗の一覧（対象月は必須。対象者・契約で絞れる）
// POST  /api/billing-progress { employeeId, siteContractId, billingMonth }
//         … その月・その契約の行を用意する（無ければ作る。あれば、あるものを返す＝二重に作らない）
// PATCH /api/billing-progress { id, stage, done }
//         … 1段だけ進める・戻す
//
// 対象月×メンバー×契約で一意（db/077 の unique 制約が最後の砦）。
// 請求書そのものはここでは作らない。進捗の5つの印だけを持つ。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { STAGE_KEYS, isBillingMonth } from "../../lib/billing-progress.js";

const SQL = "db/077_billing_progress.sql";
const FIELDS = "id, tenant_id, employee_id, site_contract_id, billing_month, "
  + STAGE_KEYS.map((k) => `${k}, ${k}_at`).join(", ") + ", note, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return ensure(req, res, sb, ctx, user);
  if (req.method === "PATCH") return update(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

async function list(req, res, sb, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const month = q.get("month");
  if (!isBillingMonth(month)) return json(res, 400, { error: "invalid_query", detail: "month は YYYY-MM で指定してください" });

  let query = sb.from("gw_billing_progress").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("billing_month", month).limit(1000);
  if (q.get("employeeId")) query = query.eq("employee_id", q.get("employeeId"));
  if (q.get("siteContractId")) query = query.eq("site_contract_id", q.get("siteContractId"));

  const { data, error } = await query;
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { progress: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  return json(res, 200, { progress: data || [] });
}

async function ensure(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.employeeId || !body?.siteContractId || !isBillingMonth(body?.billingMonth)) {
    return json(res, 400, { error: "invalid_body", required: ["employeeId", "siteContractId", "billingMonth"] });
  }

  // 対象月×メンバー×契約で、すでにあればそれを返す（二重に作らない）
  const { data: existing } = await sb.from("gw_billing_progress").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", body.employeeId)
    .eq("site_contract_id", body.siteContractId).eq("billing_month", body.billingMonth)
    .maybeSingle();
  if (existing) return json(res, 200, { progress: existing, created: false });

  const { data, error } = await sb.from("gw_billing_progress")
    .insert({
      tenant_id: ctx.tenantId, employee_id: body.employeeId,
      site_contract_id: body.siteContractId, billing_month: body.billingMonth,
    })
    .select(FIELDS).single();
  if (error) {
    // 一意制約に競り負けた（同時に2回押された等）。作られたものを読み直して返す
    if (error.code === "23505") {
      const { data: made } = await sb.from("gw_billing_progress").select(FIELDS)
        .eq("tenant_id", ctx.tenantId).eq("employee_id", body.employeeId)
        .eq("site_contract_id", body.siteContractId).eq("billing_month", body.billingMonth)
        .maybeSingle();
      if (made) return json(res, 200, { progress: made, created: false });
    }
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }
  return json(res, 200, { progress: data, created: true });
}

async function update(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  if (!STAGE_KEYS.includes(body.stage)) {
    return json(res, 400, { error: "invalid_stage", detail: STAGE_KEYS.join(", ") });
  }
  const done = !!body.done;
  const now = new Date().toISOString();
  const patch = {
    [body.stage]: done,
    [`${body.stage}_at`]: done ? now : null,
    updated_at: now,
  };

  const { data, error } = await sb.from("gw_billing_progress")
    .update(patch).eq("id", body.id).eq("tenant_id", ctx.tenantId).select(FIELDS).maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });
  return json(res, 200, { progress: data });
}
