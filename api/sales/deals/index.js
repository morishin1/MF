// 営業の案件（db/100_sales_deals.sql）
//
// GET   /api/sales/deals?companyId=…   … その会社の案件（新しい順）
// GET   /api/sales/deals                … テナントの案件すべて（分析用。最大5,000件）
// POST  /api/sales/deals { companyId, title, service?, amount?, probability?, stage?, expectedCloseOn?, ownerId?, note? }
//         … 案件を作る。もとのアタックは「その会社に最後に送ったアタック」に自動で決める（あとから変えない）
// PATCH /api/sales/deals { id, stage?, amount?, probability?, title?, service?, expectedCloseOn?, lostReason?, ownerId?, note? }
//         … 段階・金額などを直す。成約・失注の日付はサーバが入れる
//
// ■ 会社のステータス
//   案件の段階に合わせて「商談」「提案」「成約」へ進める（後ろへは戻さない）。失注は会社に写さない。
//   その会社の案件がすべて失注になったら suggestCompanyLost: true を返す（会社を失注にするかは人が決める）
//
// ■ 消す API は無い（DB でも消せない）。間違えた案件は「失注」にするか、金額を直す

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { COMPANY_FIELDS, STATUS_LABEL, isUuid, autoNext } from "../../../lib/sales.js";
import {
  DEAL_FIELDS, DEAL_STAGE_LABEL, shapeDeal, normalizeDeal, stageDates, advanceCompanyStatus, allLost,
} from "../../../lib/sales-deals.js";

const SQL = "db/100_sales_deals.sql";
const ALL_LIMIT = 5000;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return create(req, res, sb, ctx, user);
  if (req.method === "PATCH") return update(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

function fail(res, error) {
  const hint = dbSetupHint(error, SQL);
  if (hint) return json(res, 503, { error: "not_ready", message: hint });
  if (error.code === "23514" || error.code === "23503") return json(res, 409, { error: "conflict", detail: error.message });
  return json(res, error.code === "42501" ? 403 : 500, { error: "db_failed", detail: error.message });
}

async function names(sb, ctx) {
  const { data } = await sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId).limit(500);
  const m = new Map((data || []).map((e) => [e.id, e.display_name]));
  return (id) => m.get(id) || null;
}

async function loadCompany(sb, ctx, id) {
  const { data } = await sb.from("gw_sales_companies").select(COMPANY_FIELDS)
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data || null;
}

async function list(req, res, sb, ctx) {
  const companyId = new URL(req.url, "http://localhost").searchParams.get("companyId");
  if (companyId && !isUuid(companyId)) return json(res, 400, { error: "invalid_query" });
  let q = sb.from("gw_sales_deals").select(DEAL_FIELDS).eq("tenant_id", ctx.tenantId);
  if (companyId) q = q.eq("company_id", companyId);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(companyId ? 100 : ALL_LIMIT);
  if (error) return fail(res, error);
  const nameOf = await names(sb, ctx);
  return json(res, 200, { deals: (data || []).map((d) => shapeDeal(d, nameOf)), truncated: !companyId && (data || []).length >= ALL_LIMIT });
}

/** 案件に合わせて会社のステータスを進める。進めたら新しいステータスを返す */
async function syncCompany(sb, ctx, user, company, deal, dealsOfCompany) {
  const next = advanceCompanyStatus(company, deal.stage);
  let status = company.status;
  if (next) {
    const patch = { status: next, updated_at: new Date().toISOString() };
    // 画面から「商談」にしたときと同じく、NEXT が空なら自動で入れる
    if (next === "meeting" && !company.next_action && !company.next_action_on) Object.assign(patch, autoNext("meeting"));
    await sb.from("gw_sales_companies").update(patch).eq("id", company.id).eq("tenant_id", ctx.tenantId);
    await sb.from("gw_sales_events").insert({
      tenant_id: ctx.tenantId, company_id: company.id, event_key: "status", label: `ステータス：${STATUS_LABEL[next]}`,
      detail: `${STATUS_LABEL[company.status] || company.status} → ${STATUS_LABEL[next]}（案件「${deal.title}」）`,
      employee_id: ctx.employee?.id || null, created_by: user.id,
    });
    status = next;
  }
  return { companyStatus: status, suggestCompanyLost: status !== "lost" && allLost(dealsOfCompany) };
}

async function create(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.companyId)) return json(res, 400, { error: "invalid_body", required: ["companyId", "title"] });
  const n = normalizeDeal(body, { create: true });
  if (n.error) return json(res, 400, n);
  const c = await loadCompany(sb, ctx, body.companyId);
  if (!c) return json(res, 404, { error: "not_found" });

  // もとのアタック＝その会社に最後に送ったアタック（送信完了したもの）
  const { data: last, error: e1 } = await sb.from("gw_sales_approaches").select("id, sent_at")
    .eq("tenant_id", ctx.tenantId).eq("company_id", c.id).not("sent_at", "is", null)
    .order("sent_at", { ascending: false }).limit(1);
  if (e1) return fail(res, e1);

  const row = {
    ...n.value,
    tenant_id: ctx.tenantId, company_id: c.id, approach_id: last?.[0]?.id || null,
    owner_id: n.value.owner_id ?? (c.owner_id || ctx.employee?.id || null),
    service: n.value.service ?? (c.service || null),
    stage: n.value.stage || "meeting",
    created_by: user.id, updated_by: user.id,
  };
  const { data: made, error } = await sb.from("gw_sales_deals").insert(row).select(DEAL_FIELDS).single();
  if (error) return fail(res, error);

  const amountTxt = made.amount != null ? `（${Number(made.amount).toLocaleString("ja-JP")}円）` : "";
  await sb.from("gw_sales_events").insert({
    tenant_id: ctx.tenantId, company_id: c.id, event_key: "deal", label: `案件を追加：${made.title}${amountTxt}`,
    detail: DEAL_STAGE_LABEL[made.stage], employee_id: ctx.employee?.id || null, created_by: user.id,
  });
  const { data: all } = await sb.from("gw_sales_deals").select("id, stage").eq("tenant_id", ctx.tenantId).eq("company_id", c.id);
  const sync = await syncCompany(sb, ctx, user, c, made, all || [made]);
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.deal_create",
    target: `sales_company:${c.id}`, detail: { dealId: made.id, stage: made.stage, amount: made.amount ?? null } });
  const nameOf = await names(sb, ctx);
  return json(res, 200, { deal: shapeDeal(made, nameOf), ...sync });
}

async function update(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id"] });
  if (body.approachId !== undefined || body.companyId !== undefined) {
    return json(res, 400, { error: "fixed_fields", hint: "会社・もとのアタックは案件を作ったあとは変えられません" });
  }
  const n = normalizeDeal(body);
  if (n.error) return json(res, 400, n);
  const { data: before, error: e0 } = await sb.from("gw_sales_deals").select(DEAL_FIELDS)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (e0) return fail(res, e0);
  if (!before) return json(res, 404, { error: "not_found" });

  const dates = stageDates(before, n.value);
  if (dates.error) return json(res, 400, dates);
  const patch = { ...n.value, ...dates.patch, updated_by: user.id, updated_at: new Date().toISOString() };
  // 成約・失注でない案件に失注理由は残さない
  if ((patch.stage ?? before.stage) !== "lost" && before.lost_reason && !("lost_reason" in n.value)) patch.lost_reason = null;
  if (Object.keys(n.value).length === 0) return json(res, 400, { error: "nothing_to_update" });

  const { data: after, error } = await sb.from("gw_sales_deals").update(patch)
    .eq("id", before.id).eq("tenant_id", ctx.tenantId).select(DEAL_FIELDS).single();
  if (error) return fail(res, error);

  let sync = { companyStatus: null, suggestCompanyLost: false };
  if (after.stage !== before.stage) {
    await sb.from("gw_sales_events").insert({
      tenant_id: ctx.tenantId, company_id: after.company_id, event_key: "deal",
      label: `案件「${after.title}」：${DEAL_STAGE_LABEL[before.stage]} → ${DEAL_STAGE_LABEL[after.stage]}`,
      detail: after.stage === "lost" ? after.lost_reason || null
        : after.stage === "won" ? `${Number(after.amount).toLocaleString("ja-JP")}円` : null,
      employee_id: ctx.employee?.id || null, created_by: user.id,
    });
    const c = await loadCompany(sb, ctx, after.company_id);
    const { data: all } = await sb.from("gw_sales_deals").select("id, stage").eq("tenant_id", ctx.tenantId).eq("company_id", after.company_id);
    if (c) sync = await syncCompany(sb, ctx, user, c, after, all || [after]);
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.deal_update",
    target: `sales_company:${after.company_id}`,
    detail: { dealId: after.id, fields: Object.keys(n.value), stage: after.stage, amount: after.amount ?? null } });
  const nameOf = await names(sb, ctx);
  return json(res, 200, { deal: shapeDeal(after, nameOf), ...sync });
}
