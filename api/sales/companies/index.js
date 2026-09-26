// GET  /api/sales/companies            … 企業一覧（ダッシュボード・企業・アタック・反応・分析で共通利用）
// POST /api/sales/companies { name, siteUrl, formUrl, ... }       … 企業を1社追加
// POST /api/sales/companies { companies: [{...}, ...] }            … まとめて追加（リストの取り込み）
//
// ダッシュボードの「今日やること」・反応一覧・分析は、すべてこの一覧から
// 画面側で組み立てる（別に集計テーブルは作らない。/hr と同じ方針）。
//
// ■ 同じ会社を2行にしない
//   企業サイトのドメインが同じなら同じ会社として扱う。1社追加では 409 で
//   既存の会社を返し、まとめて追加では飛ばして件数だけ返す。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import {
  COMPANY_FIELDS, normalizeCompany, shapeCompany, aggregateApproaches, nextFor, hasUnhandledClick, todayJst,
} from "../../../lib/sales.js";

const SQL = "db/088_sales.sql";
const FIELDS = COMPANY_FIELDS;
const BULK_MAX = 500;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return create(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function list(req, res, sb, ctx) {
  const { data, error } = await sb.from("gw_sales_companies").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(5000);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { companies: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const [{ data: approaches }, { data: members }, { data: campaigns }] = await Promise.all([
    sb.from("gw_sales_approaches")
      .select("id, company_id, employee_id, service, prepared_at, sent_at, first_click_at, last_click_at, click_count")
      .eq("tenant_id", ctx.tenantId).limit(20000),
    sb.from("gw_employees").select("id, display_name")
      .eq("tenant_id", ctx.tenantId).in("status", ["active", "invited"]).order("display_name").limit(300),
    sb.from("gw_sales_campaigns").select("id, name").eq("tenant_id", ctx.tenantId).limit(500),
  ]);
  const name = new Map((members || []).map((e) => [e.id, e.display_name]));
  const campaignName = new Map((campaigns || []).map((c) => [c.id, c.name]));
  const agg = aggregateApproaches(approaches);
  const today = todayJst();

  return json(res, 200, {
    today,
    me: ctx.employee?.id || null,
    members: members || [],
    companies: (data || []).map((c) => {
      const g = agg.get(c.id) || null;
      const next = nextFor(c, g, today);
      return {
        ...shapeCompany(c),
        ownerName: name.get(c.owner_id) || null,
        campaignName: campaignName.get(c.campaign_id) || null,
        attackCount: g?.attackCount || 0,
        lastSentAt: g?.lastSentAt || null,
        lastAttackerName: name.get(g?.lastEmployeeId) || null,
        lastService: g?.lastService || null,
        clickCount: g?.clickCount || 0,
        firstClickAt: g?.first_click_at || null,
        lastClickAt: g?.last_click_at || null,
        unhandledClick: hasUnhandledClick(c, g),
        next: next.label, nextKey: next.key, nextDue: next.due, overdue: next.overdue,
      };
    }),
  });
}

async function create(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (Array.isArray(body.companies)) return bulk(res, sb, ctx, user, body.companies);

  const row = normalizeCompany(body);
  if (row.error) return json(res, 400, row);
  if (!("owner_id" in row.value) && ctx.employee?.id) row.value.owner_id = ctx.employee.id;

  if (row.value.domain) {
    const { data: dup } = await sb.from("gw_sales_companies").select("id, name")
      .eq("tenant_id", ctx.tenantId).eq("domain", row.value.domain).limit(1);
    if (dup?.length) {
      return json(res, 409, {
        error: "duplicate", company: { id: dup[0].id, name: dup[0].name },
        hint: `同じサイトの企業が登録済みです（${dup[0].name}）`,
      });
    }
  }

  const { data, error } = await sb.from("gw_sales_companies")
    .insert({ ...row.value, tenant_id: ctx.tenantId, created_by: user.id })
    .select(FIELDS).single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    if (error.code === "23505") return json(res, 409, { error: "duplicate", hint: "同じサイトの企業が登録済みです" });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "sales.company_create",
    target: `sales_company:${data.id}`, detail: { name: data.name, domain: data.domain },
  });
  return json(res, 200, { company: shapeCompany(data) });
}

/**
 * リストの取り込み。ドメインが既存・リスト内で重なるものは飛ばす。
 * 1行でも形が悪ければ、どの行かを返して何も入れない（半分だけ入ると直しにくい）
 */
async function bulk(res, sb, ctx, user, items) {
  if (!items.length) return json(res, 400, { error: "empty", hint: "取り込む企業がありません" });
  if (items.length > BULK_MAX) return json(res, 400, { error: "too_many", hint: `一度に取り込めるのは${BULK_MAX}社までです` });

  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const r = normalizeCompany(items[i] || {});
    if (r.error) return json(res, 400, { ...r, row: i + 1, hint: `${i + 1}行目：${r.hint || r.error}` });
    rows.push(r.value);
  }

  const { data: existing, error: e1 } = await sb.from("gw_sales_companies").select("domain")
    .eq("tenant_id", ctx.tenantId).limit(20000);
  if (e1) {
    const hint = dbSetupHint(e1, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: e1.message });
  }
  const seen = new Set((existing || []).map((c) => c.domain).filter(Boolean));
  const fresh = [];
  let skipped = 0;
  for (const r of rows) {
    if (r.domain && seen.has(r.domain)) { skipped++; continue; }
    if (r.domain) seen.add(r.domain);
    fresh.push({
      ...r, owner_id: r.owner_id ?? ctx.employee?.id ?? null,
      tenant_id: ctx.tenantId, created_by: user.id,
    });
  }

  if (fresh.length) {
    const { error } = await sb.from("gw_sales_companies").insert(fresh);
    if (error) {
      if (error.code === "23505") return json(res, 409, { error: "duplicate", hint: "同じサイトの企業が含まれています。もう一度お試しください" });
      return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    }
  }
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "sales.company_import",
    target: "sales_company:bulk", detail: { created: fresh.length, skipped },
  });
  return json(res, 200, { created: fresh.length, skipped });
}
