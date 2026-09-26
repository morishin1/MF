// GET   /api/sales/campaigns          … キャンペーン（対象企業数・アタック数・クリック数・返信数・商談数・成約数つき）
// POST  /api/sales/campaigns { name, service?, startsOn?, endsOn?, note? } … 追加
// PATCH /api/sales/campaigns { id, ... } / { id, archived: true|false }    … 更新・しまう
//
// 数字は保存しない。開くたびに企業・アタックから数える（/hr と同じ方針）。
//   対象企業数 … このキャンペーンに入れた企業
//   アタック数 … このキャンペーンで送ったアタック（送信済み）
//   クリック・返信・商談・成約 … 対象企業のうち、いまその段階以上にいる会社

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { isUuid, statusRank } from "../../../lib/sales.js";

const SQL = "db/088_sales.sql";
const FIELDS = "id, tenant_id, name, service, starts_on, ends_on, archived_at, note, created_at";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST" || req.method === "PATCH") return save(req, res, sb, ctx, user, req.method === "PATCH");
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

const shape = (c) => ({
  id: c.id, name: c.name, service: c.service || null, startsOn: c.starts_on || null, endsOn: c.ends_on || null,
  archived: Boolean(c.archived_at), note: c.note || null, createdAt: c.created_at,
});

async function list(req, res, sb, ctx) {
  const { data, error } = await sb.from("gw_sales_campaigns").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { campaigns: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const [{ data: companies }, { data: approaches }] = await Promise.all([
    sb.from("gw_sales_companies").select("id, campaign_id, status").eq("tenant_id", ctx.tenantId).limit(20000),
    sb.from("gw_sales_approaches").select("campaign_id, click_count, company_id")
      .eq("tenant_id", ctx.tenantId).not("sent_at", "is", null).limit(20000),
  ]);
  const at = (s, k) => statusRank(s) >= statusRank(k);

  return json(res, 200, {
    campaigns: (data || []).map((c) => {
      const cos = (companies || []).filter((x) => x.campaign_id === c.id);
      const aps = (approaches || []).filter((x) => x.campaign_id === c.id);
      return {
        ...shape(c),
        companies: cos.length,
        attacks: aps.length,
        clicks: new Set(aps.filter((a) => a.click_count > 0).map((a) => a.company_id)).size,
        replies: cos.filter((x) => at(x.status, "replied")).length,
        meetings: cos.filter((x) => at(x.status, "meeting")).length,
        won: cos.filter((x) => x.status === "won").length,
      };
    }),
  });
}

async function save(req, res, sb, ctx, user, isUpdate) {
  const body = await readJson(req);
  const v = {};
  for (const [k, col, max] of [["name", "name", 200], ["service", "service", 100], ["note", "note", 2000]]) {
    if (body[k] === undefined) continue;
    v[col] = String(body[k] ?? "").trim().slice(0, max) || null;
  }
  for (const [k, col] of [["startsOn", "starts_on"], ["endsOn", "ends_on"]]) {
    if (body[k] === undefined) continue;
    if (body[k] && !DATE_RE.test(String(body[k]))) return json(res, 400, { error: "bad_date" });
    v[col] = body[k] || null;
  }
  if (body.archived !== undefined) v.archived_at = body.archived ? new Date().toISOString() : null;

  if (!isUpdate) {
    if (!v.name) return json(res, 400, { error: "name_required", hint: "キャンペーン名を入力してください" });
    const { data, error } = await sb.from("gw_sales_campaigns")
      .insert({ ...v, tenant_id: ctx.tenantId, created_by: user.id }).select(FIELDS).single();
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    }
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.campaign_create",
      target: `sales_campaign:${data.id}`, detail: { name: data.name } });
    return json(res, 200, { campaign: shape(data) });
  }

  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id"] });
  if ("name" in v && !v.name) return json(res, 400, { error: "name_required", hint: "キャンペーン名は空にできません" });
  if (!Object.keys(v).length) return json(res, 400, { error: "nothing_to_update" });
  const { data, error } = await sb.from("gw_sales_campaigns").update(v)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select(FIELDS).maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });
  return json(res, 200, { campaign: shape(data) });
}
