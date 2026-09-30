// /api/office/terms — 契約条件（単価・精算条件）
//
//   GET    ?contract=<現場契約id>            … その契約の条件の一覧（期間の新しい順）
//   POST   { siteContractId, id?, month?, …条件 }  … 登録（id なし）／更新（id あり）
//   DELETE ?id=<条件id>&month=YYYY-MM         … 削除
//
// ■ 入れる人・二段階認証・DB の条件は api/office/index.js と同じ
//   経営者 OR 責任者 OR 経理。単価は機微情報なので、二段階認証は最初から必須（strict）。
//
// ■ gw_site_contracts.unit_price / settlement_condition は、読まない・書かない
//   意味が確定していない（売上か仕入か）。新しい条件は sales_unit_price / purchase_unit_price（gw_site_contract_terms）。
//
// ■ 読むのはログインした人の権限（RLS）、書くのは権限を確かめたあとの service_role
//
// ■ 期間が重なる条件は登録させない（同じ契約で）
//   月の途中で条件が変わるときは、前の条件の終了日と、次の条件の開始日を、重ならないように置く。
//   重なると、その月にどちらを使うかが決められない。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { isBillingMonth } from "../../lib/billing-progress.js";
import { jstDate } from "../../lib/timecard.js";
import { parseTermsInput, normalizeTerms, describeTerms } from "../../lib/office-calc.js";

const SQL = "db/102_office_contract_terms.sql";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = "id, site_contract_id, valid_from, valid_to, pricing_type, sales_unit_price, purchase_unit_price, "
  + "settlement_mode, settle_min_minutes, settle_max_minutes, settle_unit_minutes, rounding_mode, rounding_scope, "
  + "over_rate_per_hour, under_rate_per_hour, prorate, amount_rounding, created_at, updated_at";

export default async function handler(req, res) {
  if (!["GET", "POST", "DELETE"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST", "DELETE"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canAccessOffice(ctx)) return json(res, 403, { error: "forbidden" });
  if (!(await requireMfa(req, res, ctx, user, { strict: true }))) return;

  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") return await list(req, res, ctx);
    if (req.method === "POST") return await save(req, res, ctx, user);
    return await remove(req, res, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[office/terms]", e?.message || e);
    return json(res, 500, { error: "terms_failed" });
  }
}

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

const view = (r) => {
  const t = normalizeTerms(r);
  return { ...t, description: describeTerms(t), updatedAt: r.updated_at || null };
};

async function contractOf(req, ctx, id) {
  if (!id || !UUID.test(String(id))) return null;
  return must(userClient(req).from("gw_site_contracts").select("id, employee_id, site_company, engagement_kind")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
}

async function list(req, res, ctx) {
  const id = new URL(req.url, "http://localhost").searchParams.get("contract");
  const c = await contractOf(req, ctx, id);
  if (!c) return json(res, 404, { error: "contract_not_found" });
  const rows = await must(userClient(req).from("gw_site_contract_terms").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("site_contract_id", c.id).order("valid_from", { ascending: false }).limit(200));
  // 画面の見出し用（氏名は、名簿から判定のあとに読む。人事の機微の列は読まない）
  const emp = await must(admin().from("gw_employees").select("id, display_name")
    .eq("id", c.employee_id).eq("tenant_id", ctx.tenantId).maybeSingle());
  return json(res, 200, {
    siteContractId: c.id,
    contract: { siteCompany: c.site_company, engagementKind: c.engagement_kind, employeeName: emp?.display_name || "" },
    terms: (rows || []).map(view),
  });
}

const overlaps = (a, b) => a.valid_from <= (b.valid_to || "9999-12-31") && b.valid_from <= (a.valid_to || "9999-12-31");
const monthOf = (v) => (isBillingMonth(v) ? v : jstDate().slice(0, 7));

async function event(ctx, user, c, month, kind, detail) {
  try {
    await must(admin().from("gw_office_events").insert({
      tenant_id: ctx.tenantId, billing_month: month, employee_id: c.employee_id, site_contract_id: c.id, kind,
      actor_id: user.id, actor_name: ctx.employee?.display_name || null, detail,
    }));
  } catch (e) { console.error("[office/terms] event failed:", e?.message || e); }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `office.${kind}`, target: `site_contract:${c.id}`, detail });
}

async function save(req, res, ctx, user) {
  const body = (await readJson(req)) || {};
  const c = await contractOf(req, ctx, body.siteContractId);
  if (!c) return json(res, 404, { error: "contract_not_found" });
  if (body.id && !UUID.test(String(body.id))) return json(res, 400, { error: "invalid_request", detail: "id が正しくありません" });
  const parsed = parseTermsInput(body);
  if (!parsed.ok) return json(res, 400, { error: "invalid_input", errors: parsed.errors });

  const sb = admin();
  const others = await must(sb.from("gw_site_contract_terms").select("id, valid_from, valid_to")
    .eq("tenant_id", ctx.tenantId).eq("site_contract_id", c.id).limit(200));
  const clash = (others || []).find((o) => o.id !== body.id && overlaps(parsed.value, o));
  if (clash) {
    return json(res, 409, {
      error: "overlap",
      hint: `期間が、すでにある条件（${clash.valid_from}〜${clash.valid_to || "期限なし"}）と重なっています。前の条件の終了日と、次の条件の開始日を、重ならないようにしてください`,
    });
  }

  const now = new Date().toISOString();
  const month = monthOf(body.month);
  if (body.id) {
    const rows = await must(sb.from("gw_site_contract_terms").update({ ...parsed.value, updated_at: now })
      .eq("id", body.id).eq("tenant_id", ctx.tenantId).eq("site_contract_id", c.id).select(FIELDS));
    if (!rows?.length) return json(res, 404, { error: "terms_not_found" });
    await event(ctx, user, c, month, "terms.update", { termsId: body.id, validFrom: parsed.value.valid_from, pricingType: parsed.value.pricing_type });
    return json(res, 200, { term: view(rows[0]) });
  }
  const row = await must(sb.from("gw_site_contract_terms").insert({
    ...parsed.value, tenant_id: ctx.tenantId, site_contract_id: c.id, created_by: user.id,
  }).select(FIELDS).single());
  await event(ctx, user, c, month, "terms.create", { termsId: row.id, validFrom: parsed.value.valid_from, pricingType: parsed.value.pricing_type });
  return json(res, 200, { term: view(row) });
}

async function remove(req, res, ctx, user) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const id = q.get("id");
  if (!id || !UUID.test(id)) return json(res, 400, { error: "invalid_request", detail: "id が正しくありません" });
  const sb = admin();
  const row = await must(sb.from("gw_site_contract_terms").select("id, site_contract_id")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!row) return json(res, 404, { error: "terms_not_found" });
  const c = await contractOf(req, ctx, row.site_contract_id);
  if (!c) return json(res, 404, { error: "contract_not_found" });
  await must(sb.from("gw_site_contract_terms").delete().eq("id", id).eq("tenant_id", ctx.tenantId));
  await event(ctx, user, c, monthOf(q.get("month")), "terms.delete", { termsId: id });
  return json(res, 200, { ok: true });
}
