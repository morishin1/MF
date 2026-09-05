// GET    /api/analytics?days=7            … 全サイトのサマリー（前期間比つき）
// GET    /api/analytics?projectId=…&days=30 … 1サイトの詳細（日別・流入元・人気ページ）
// POST   /api/analytics {name, domain}     … サイトを手で足す
// PATCH  /api/analytics {id, ...}          … 名前・ドメイン・表示可否の変更
// DELETE /api/analytics?id=…               … 削除
//
// 数字は経営情報なので、管理者と経営者だけが見られる（RLSが決める）。
//
// 前期間比は「直近N日」と「その前のN日」で出す。月初でリセットしない。
// 週の途中でも先週と比べられるほうが、伸びているかどうかを掴みやすい。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { isConfigured as vercelConfigured } from "../../lib/vercel.js";
import { gwLog } from "../../lib/gw-audit.js";
import crypto from "node:crypto";

const canSee = (ctx) => ctx.isAdmin || ctx.roles.includes("owner");

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSee(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return create(req, res, ctx);
  if (req.method === "PATCH") return update(req, res, ctx);
  if (req.method === "DELETE") return remove(req, res, ctx);
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const days = clampDays(q.get("days"));
  const projectId = q.get("projectId");
  const sb = userClient(req);

  const { data: projects, error } = await sb
    .from("gw_web_projects")
    .select("id, name, project_name, domain, provider, beacon_key, enabled, sort_order, " +
            "ga4_property_id, ga4_measurement_id, last_synced_at, sync_source, sync_error")
    .eq("tenant_id", ctx.tenantId)
    .order("sort_order").order("name")
    .limit(200);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  // 前期間と比べるので、2期間ぶんまとめて取る
  const since = dayString(-(days * 2 - 1));
  const ids = (projects || []).map((p) => p.id);
  if (!ids.length) {
    return json(res, 200, { days, projects: [], sites: [], vercel: vercelConfigured(), block: await blockStats() });
  }

  let dq = sb.from("gw_web_daily")
    .select("project_id, date, source, pageviews, visitors").gte("date", since).limit(20000);
  if (projectId) dq = dq.eq("project_id", projectId);
  const { data: daily } = await dq;

  // 1つのサイトで GA4 と計測タグが両方動いていることがある。
  // そのまま足すと倍になるので、サイトごとに出どころを1つだけ選んで数える
  const primary = new Map();
  for (const p of projects || []) {
    primary.set(p.id, pickSource((daily || []).filter((d) => d.project_id === p.id)));
  }
  const rowsFor = (id) =>
    (daily || []).filter((d) => d.project_id === id && d.source === primary.get(id));

  const sites = (projects || [])
    .filter((p) => !projectId || p.id === projectId)
    .map((p) => ({ ...summarize(p, rowsFor(p.id), days), source: primary.get(p.id) }));

  const out = {
    days,
    projects: projects || [],
    sites,
    vercel: vercelConfigured(),
    block: await blockStats(),
  };

  // 1サイトの詳細では、流入元と人気ページも添える
  if (projectId) {
    const from = dayString(-(days - 1));
    const src = primary.get(projectId) || "beacon";
    const [{ data: refs }, { data: pages }] = await Promise.all([
      sb.from("gw_web_referrers").select("referrer, pageviews")
        .eq("project_id", projectId).eq("source", src).gte("date", from).limit(5000),
      sb.from("gw_web_pages").select("path, pageviews")
        .eq("project_id", projectId).eq("source", src).gte("date", from).limit(5000),
    ]);
    out.referrers = topBy(refs || [], "referrer");
    out.pages = topBy(pages || [], "path");
    out.series = seriesFor(rowsFor(projectId), days);
    out.source = src;
  }

  return json(res, 200, out);
}

// どの出どころを信じるか。GA4 が入っていればそれ、次に自前の計測タグ。
// Vercel は取れたら儲けものの位置づけなので最後
const SOURCE_PRIORITY = ["ga4", "beacon", "vercel"];
function pickSource(rows) {
  for (const s of SOURCE_PRIORITY) if (rows.some((r) => r.source === s)) return s;
  return "beacon";
}

// 直近N日と、その前のN日を足し合わせて比べる
function summarize(project, rows, days) {
  const cur = { from: dayString(-(days - 1)), to: dayString(0) };
  const prev = { from: dayString(-(days * 2 - 1)), to: dayString(-days) };
  const sum = (a, b) => rows
    .filter((r) => r.date >= a && r.date <= b)
    .reduce((s, r) => ({ pv: s.pv + (r.pageviews || 0), uv: s.uv + (r.visitors || 0) }), { pv: 0, uv: 0 });

  const now = sum(cur.from, cur.to);
  const before = sum(prev.from, prev.to);
  const today = rows.filter((r) => r.date === dayString(0))
    .reduce((s, r) => ({ pv: s.pv + (r.pageviews || 0), uv: s.uv + (r.visitors || 0) }), { pv: 0, uv: 0 });

  return {
    id: project.id,
    name: project.name,
    domain: project.domain,
    enabled: project.enabled,
    hasData: rows.length > 0,
    lastSyncedAt: project.last_synced_at,
    syncError: project.sync_error,
    today,
    pv: now.pv, uv: now.uv,
    prevPv: before.pv, prevUv: before.uv,
    // 前期間が0のときの伸び率は出さない。「+∞%」は判断の役に立たない
    growth: before.pv > 0 ? Math.round(((now.pv - before.pv) / before.pv) * 1000) / 10 : null,
  };
}

function seriesFor(rows, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dayString(-i);
    const day = rows.filter((r) => r.date === date);
    out.push({
      date,
      pageviews: day.reduce((s, r) => s + (r.pageviews || 0), 0),
      visitors: day.reduce((s, r) => s + (r.visitors || 0), 0),
    });
  }
  return out;
}

function topBy(rows, field, limit = 12) {
  const m = new Map();
  for (const r of rows) m.set(r[field], (m.get(r[field]) || 0) + (r.pageviews || 0));
  return [...m.entries()]
    .map(([k, v]) => ({ key: k, pageviews: v }))
    .sort((a, b) => b.pageviews - a.pageviews)
    .slice(0, limit);
}

// 8grp の口コミサイトブロックの件数。同じ画面で見られるように添える
async function blockStats() {
  try {
    const sb = admin();
    const at = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const count = async (since) => {
      const { count } = await sb.from("blocked_access_logs")
        .select("id", { count: "exact", head: true }).gte("created_at", since);
      return count || 0;
    };
    const [today, week, month] = await Promise.all([
      count(new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
      count(at(7)), count(at(30)),
    ]);
    return { today, week, month };
  } catch {
    return null;   // 8grp 側の表がまだ無い環境では出さない
  }
}

// ---- サイトの追加・更新・削除 -----------------------------------------------
async function create(req, res, ctx) {
  const body = await readJson(req);
  const name = String(body?.name ?? "").trim();
  if (!name) return json(res, 400, { error: "invalid_body", hint: "サイト名を入れてください" });

  const domain = normalizeDomain(body?.domain);
  if (body?.domain && !domain) return json(res, 400, { error: "invalid_domain", hint: "ドメインの形が正しくありません" });

  const { data, error } = await admin().from("gw_web_projects").insert({
    tenant_id: ctx.tenantId,
    provider: "manual",
    name: name.slice(0, 100),
    domain,
    beacon_key: newKey(),
    sort_order: 999,
  }).select("*").single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });
  return json(res, 200, { project: data });
}

async function update(req, res, ctx) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const patch = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 100) || null;
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.sortOrder !== undefined) patch.sort_order = Number(body.sortOrder) || 0;
  if (body.domain !== undefined) {
    const d = normalizeDomain(body.domain);
    if (body.domain && !d) return json(res, 400, { error: "invalid_domain" });
    patch.domain = d;
  }
  // GA4。プロパティID（数字）と測定ID（G-…）は別物なので、形で取り違えを止める
  if (body.ga4PropertyId !== undefined) {
    const v = String(body.ga4PropertyId || "").trim().replace(/^properties\//, "");
    if (v && !/^\d{6,15}$/.test(v)) {
      return json(res, 400, {
        error: "invalid_property_id",
        hint: "プロパティIDは数字だけです（G- で始まるものは「測定ID」の欄に入れてください）",
      });
    }
    patch.ga4_property_id = v || null;
  }
  if (body.ga4MeasurementId !== undefined) {
    const v = String(body.ga4MeasurementId || "").trim().toUpperCase();
    if (v && !/^G-[A-Z0-9]{4,20}$/.test(v)) {
      return json(res, 400, { error: "invalid_measurement_id", hint: "測定IDは G- で始まります" });
    }
    patch.ga4_measurement_id = v || null;
  }

  // 合鍵の作り直し。貼り替えるまで、そのサイトの計測は止まる
  if (body.rotateKey) patch.beacon_key = newKey();

  const { data, error } = await admin()
    .from("gw_web_projects").update(patch)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId)
    .select("*").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "project_not_found" });

  if (body.rotateKey) {
    await gwLog({
      tenantId: ctx.tenantId, actorId: ctx.employee?.id || null,
      action: "analytics.key_rotated", target: data.id, detail: { name: data.name },
    });
  }
  return json(res, 200, { project: data });
}

async function remove(req, res, ctx) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });
  const { error } = await admin()
    .from("gw_web_projects").delete().eq("id", id).eq("tenant_id", ctx.tenantId);
  if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });
  return json(res, 200, { ok: true, id });
}

// ---- 補助 -------------------------------------------------------------------
const clampDays = (v) => {
  const n = Number(v) || 7;
  return [1, 7, 30, 90].includes(n) ? n : 7;
};

// 日本時間での「n日前」。サーバはUTCで動くので9時間足してから切る
function dayString(offset) {
  const d = new Date(Date.now() + 9 * 3600000 + offset * 86400000);
  return d.toISOString().slice(0, 10);
}

function normalizeDomain(raw) {
  const s = String(raw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(":")[0];
  if (!s) return null;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

// 合鍵はページのソースに載る。推測されないことだけが要件なので乱数でよい
const newKey = () => crypto.randomBytes(16).toString("base64url");
