// GET   /api/sales/templates          … 営業文テンプレート（使用回数・クリック率・返信率・商談率つき）
// POST  /api/sales/templates { name, service?, subject?, body, destinationUrl? } … 追加
// PATCH /api/sales/templates { id, ... } / { id, archived: true|false }       … 更新・しまう
//
// 成果の数字は、そのテンプレートで送ったアタック（送信済み）から数える。
//   クリック率 … クリックされたアタック ÷ 送ったアタック
//   返信率・商談率 … 送った会社のうち、いま「返信あり」「商談」以上にいる会社の割合
// 保存はせず、開くたびに数える（別の集計表を作らない）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { safeUrl, isUuid, statusRank, SERVICES } from "../../../lib/sales.js";

const SQL = "db/088_sales.sql";
const FIELDS = "id, tenant_id, name, service, subject, body, destination_url, archived_at, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return save(req, res, sb, ctx, user, null);
  if (req.method === "PATCH") return save(req, res, sb, ctx, user, "update");
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

const shape = (t) => ({
  id: t.id, name: t.name, service: t.service || null, subject: t.subject || null, body: t.body || "",
  destinationUrl: t.destination_url || null, archived: Boolean(t.archived_at),
  createdAt: t.created_at, updatedAt: t.updated_at,
});

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

async function list(req, res, sb, ctx) {
  const { data, error } = await sb.from("gw_sales_templates").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).order("created_at", { ascending: true }).limit(500);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { templates: [], services: SERVICES, notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const [{ data: approaches }, { data: companies }] = await Promise.all([
    sb.from("gw_sales_approaches").select("template_id, company_id, sent_at, click_count")
      .eq("tenant_id", ctx.tenantId).not("sent_at", "is", null).limit(20000),
    sb.from("gw_sales_companies").select("id, status").eq("tenant_id", ctx.tenantId).limit(20000),
  ]);
  const status = new Map((companies || []).map((c) => [c.id, c.status]));
  const stats = new Map();
  for (const a of approaches || []) {
    if (!a.template_id) continue;
    let s = stats.get(a.template_id);
    if (!s) { s = { uses: 0, clicked: 0, companies: new Set() }; stats.set(a.template_id, s); }
    s.uses++;
    if (a.click_count > 0) s.clicked++;
    s.companies.add(a.company_id);
  }

  return json(res, 200, {
    services: SERVICES,
    templates: (data || []).map((t) => {
      const s = stats.get(t.id);
      const cos = s ? [...s.companies] : [];
      const replied = cos.filter((id) => statusRank(status.get(id)) >= statusRank("replied")).length;
      const meeting = cos.filter((id) => statusRank(status.get(id)) >= statusRank("meeting")).length;
      return {
        ...shape(t),
        uses: s?.uses || 0,
        clickRate: pct(s?.clicked || 0, s?.uses || 0),
        replyRate: pct(replied, cos.length),
        meetingRate: pct(meeting, cos.length),
      };
    }),
  });
}

async function save(req, res, sb, ctx, user, mode) {
  const body = await readJson(req);
  const v = {};
  for (const [k, col, max] of [["name", "name", 100], ["service", "service", 100], ["subject", "subject", 300], ["body", "body", 20000]]) {
    if (body[k] === undefined) continue;
    v[col] = String(body[k] ?? "").trim().slice(0, max) || null;
  }
  const dest = safeUrl(body.destinationUrl);
  if (dest === false) return json(res, 400, { error: "bad_url", hint: "リンク先のURLが正しくありません" });
  if (dest !== undefined) v.destination_url = dest;
  if (body.archived !== undefined) v.archived_at = body.archived ? new Date().toISOString() : null;

  if (mode !== "update") {
    if (!v.name) return json(res, 400, { error: "name_required", hint: "テンプレート名を入力してください" });
    if (!v.body) return json(res, 400, { error: "body_required", hint: "本文を入力してください" });
    const { data, error } = await sb.from("gw_sales_templates")
      .insert({ ...v, tenant_id: ctx.tenantId, created_by: user.id }).select(FIELDS).single();
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    }
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.template_create",
      target: `sales_template:${data.id}`, detail: { name: data.name } });
    return json(res, 200, { template: shape(data) });
  }

  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id"] });
  if ("name" in v && !v.name) return json(res, 400, { error: "name_required", hint: "テンプレート名は空にできません" });
  if ("body" in v && !v.body) return json(res, 400, { error: "body_required", hint: "本文は空にできません" });
  if (!Object.keys(v).length) return json(res, 400, { error: "nothing_to_update" });
  v.updated_at = new Date().toISOString();

  const { data, error } = await sb.from("gw_sales_templates").update(v)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select(FIELDS).maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.template_update",
    target: `sales_template:${data.id}`, detail: { fields: Object.keys(v).filter((k) => k !== "updated_at") } });
  return json(res, 200, { template: shape(data) });
}
