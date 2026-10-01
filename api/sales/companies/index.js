// GET  /api/sales/companies?page=1&limit=100&sort=name&order=asc&q=&status=&owner=&service=&industry=&region=&channel=&visibility=
//        … 企業一覧（サーバー側ページング。db/097）。DB で絞って並べて100件だけ返す。
//          { companies, page, limit, total, totalPages, members, facets? }（facets=1 のとき絞り込みの候補も）
// GET  /api/sales/companies[?visibility=shown|hidden|all]（page なし）
//        … 全件（ダッシュボード・リード・アタック画面用。これらはまだ全件で集計している）
//        … 企業一覧（ダッシュボード・企業・アタック・反応・分析で共通利用）
//          既定は「表示中」だけ。非表示にした企業（リンク切れ・閉業など。db/096）は、
//          visibility=hidden / all を明示したときだけ返す（ダッシュボード・アタック対象に出さない）
// POST /api/sales/companies { name, siteUrl, formUrl, ... }       … 企業を1社追加
// POST /api/sales/companies { companies: [{...}, ...] }            … まとめて追加（リストの取り込み）
//
// ダッシュボードの「今日やること」・反応一覧・分析は、すべてこの一覧から
// 画面側で組み立てる（別に集計テーブルは作らない。/hr と同じ方針）。
//
// ■ 同じ会社を2行にしない
//   企業サイトのドメインが同じなら同じ会社として扱う。1社追加では 409 で
//   既存の会社を返し、まとめて追加では飛ばして件数だけ返す。
//   非表示の企業も数に入れる（リンク切れの会社を取り込み直して、また一覧に出さないため）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import {
  COMPANY_FIELDS, normalizeCompany, shapeCompany, aggregateApproaches, nextFor, hasUnhandledClick, todayJst,
  channelLabel, parseListQuery, NEXT_FILTERS,
} from "../../../lib/sales.js";
import { listPage, listFacets } from "../../../lib/sales-list.js";
import { loadMasters } from "../../../lib/sales-master.js";
import { CSV_IMPORT_COLUMNS } from "../../../lib/sales-csv-import.js";

const SQL = "db/088_sales.sql・db/096_sales_channels.sql・db/097_sales_company_list.sql・db/098_sales_company_list_sort.sql";
const VISIBILITY = ["shown", "hidden", "all"];
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
  const sp = new URL(req.url || "/", "http://localhost").searchParams;
  if (sp.has("page")) return paged(res, sb, ctx, sp);
  const v = sp.get("visibility") || "shown";
  if (!VISIBILITY.includes(v)) return json(res, 400, { error: "bad_visibility", allowed: VISIBILITY });
  let q = sb.from("gw_sales_companies").select(FIELDS).eq("tenant_id", ctx.tenantId);
  if (v === "shown") q = q.is("hidden_at", null);
  if (v === "hidden") q = q.not("hidden_at", "is", null);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(5000);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { companies: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const [{ data: approaches }, { data: members }, { data: campaigns }, { data: meetings }] = await Promise.all([
    sb.from("gw_sales_approaches")
      .select("id, company_id, employee_id, service, prepared_at, sent_at, first_click_at, last_click_at, click_count, channel")
      .eq("tenant_id", ctx.tenantId).limit(20000),
    sb.from("gw_employees").select("id, display_name")
      .eq("tenant_id", ctx.tenantId).in("status", ["active", "invited"]).order("display_name").limit(300),
    sb.from("gw_sales_campaigns").select("id, name").eq("tenant_id", ctx.tenantId).limit(500),
    // 進行中の面談（db/090）。表がまだ無ければ空として扱う
    sb.from("gw_sales_meetings").select("id, company_id, status, scheduled_at, created_at")
      .eq("tenant_id", ctx.tenantId).in("status", ["scheduling", "scheduled"]).limit(5000),
  ]);
  const name = new Map((members || []).map((e) => [e.id, e.display_name]));
  const campaignName = new Map((campaigns || []).map((c) => [c.id, c.name]));
  const agg = aggregateApproaches(approaches);
  const meetingOf = new Map();
  for (const m of meetings || []) {
    const cur = meetingOf.get(m.company_id);
    if (!cur || String(m.created_at) > String(cur.created_at)) meetingOf.set(m.company_id, m);
  }
  const today = todayJst();

  return json(res, 200, {
    today,
    visibility: v,
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
        lastChannel: g?.lastChannel || null,
        lastChannelLabel: channelLabel(g?.lastChannel),
        clickCount: g?.clickCount || 0,
        firstClickAt: g?.first_click_at || null,
        lastClickAt: g?.last_click_at || null,
        unhandledClick: hasUnhandledClick(c, g),
        meetingStatus: meetingOf.get(c.id)?.status || null,
        meetingAt: meetingOf.get(c.id)?.scheduled_at || null,
        next: next.label, nextKey: next.key, nextDue: next.due, overdue: next.overdue,
      };
    }),
  });
}

async function paged(res, sb, ctx, sp) {
  const f = parseListQuery(sp);
  if (f.error) return json(res, 400, f);
  // 件数（facets）は企業一覧の条件だけで数える。アタック画面の条件（queue・NEXT・キャンペーン）では数えない
  const withFacets = sp.get("facets") === "1" && !f.queue && !f.next && !f.campaign;
  const [r, facets, masters] = await Promise.all([
    listPage(sb, ctx, f),
    withFacets ? listFacets(sb, ctx, f) : Promise.resolve(undefined),
    loadMasters(sb, ctx.tenantId),
  ]);
  if (r.error) {
    const hint = dbSetupHint(r.error, SQL);
    if (hint) return json(res, 200, { companies: [], notReady: true, message: hint, page: 1, total: 0, totalPages: 1 });
    return json(res, 500, { error: "db_query_failed", detail: r.error.message });
  }
  // masters … 業種・提案サービス・都道府県の共通マスター（画面はこれで選択肢を作る。lib/sales-master.js）
  // （db/108 のテナントの選択肢。表示中のものだけ。非表示にしたものは旧データとして件数の側から出る）
  return json(res, 200, {
    ...r, me: ctx.employee?.id || null, facets,
    masters: { industries: masters.industries, services: masters.services, prefectures: masters.prefectures },
    nextFilters: NEXT_FILTERS.map(([key, label]) => ({ key, label })), csvColumns: CSV_IMPORT_COLUMNS,
  });
}

async function create(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (Array.isArray(body.companies)) return bulk(res, sb, ctx, user, body.companies);

  const row = normalizeCompany(body, { masters: await loadMasters(sb, ctx.tenantId) });
  if (row.error) return json(res, 400, row);
  if (!("owner_id" in row.value) && ctx.employee?.id) row.value.owner_id = ctx.employee.id;

  if (row.value.domain) {
    const { data: dup } = await sb.from("gw_sales_companies").select("id, name, hidden_at")
      .eq("tenant_id", ctx.tenantId).eq("domain", row.value.domain).limit(1);
    if (dup?.length) {
      return json(res, 409, {
        error: "duplicate", company: { id: dup[0].id, name: dup[0].name, hidden: Boolean(dup[0].hidden_at) },
        hint: `同じサイトの企業が登録済みです（${dup[0].name}${dup[0].hidden_at ? "・非表示中" : ""}）`,
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
  const masters = await loadMasters(sb, ctx.tenantId);
  for (let i = 0; i < items.length; i++) {
    const r = normalizeCompany(items[i] || {}, { masters });
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
