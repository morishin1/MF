// マーケティング（Office）：4事業の「対応が必要な業務」と「制作予定」。方針は docs/office-marketing.md。
//
// GET  /api/marketing?view=work                 … 対応が必要な業務（原本ごとの取得状態＋一覧。一覧に連絡先・本文は載せない）
// GET  /api/marketing?view=work&id=hr_lead:<id> … 1件の詳細（開いたときに、権限を確かめてから取る）
// GET  /api/marketing?count=1                   … Office ホーム「今日やること」用の件数（個人情報なし）
// GET  /api/marketing?view=production           … 制作予定（自社サイトのお知らせ＋この画面で登録した企画）
// POST /api/marketing { action: "read", key }   … 既読にする。押したときだけ（GET では既読にしない）
// POST /api/marketing { action: "plan.create", … } / { action: "plan.update", id, version, … }
// POST /api/marketing { action: "video.check", url }                     … YouTube の URL を確かめる（保存しない）
// POST /api/marketing { action: "video.preview", itemId, url, sites }    … 掲載先ごとの見え方と、確認用の印
// POST /api/marketing { action: "video.place", itemId, url, sites }      … 確認した掲載先に載せる（未対応のサイトは載せない）
//
// ■ 見るだけでは何も変えない
//   GET は読むだけ。既読化・状態更新・送信・予定作成はしない（test/marketingapi.mjs が見張る）。
//
// ■ 別台帳を作らない
//   無限道場の問い合わせは採用HRの無限道場リード（gw_hr_applicants）を読む。状態・担当・期限も原本の値。
//   返信は採用HRの既存のメール送信（/api/hr/applicants/mail：送信前の確認・二重送信防止つき）を画面から使う。
//   次のアクションは採用HRの既存の変更（/api/hr/applicants/detail action=leadNextAction）を画面から使う。
//
// ■ 権限
//   この画面に入れるのは Office に入れる人（Office ホームと同じ）。原本ごとに、原本の権限をサーバで確かめる。
//   無限道場リード＝採用HRを使える人（canRecruit）。自社サイトのお知らせ＝管理者・経営者（api/site-news と同じ）。
//   動画の掲載の確定＝管理者・経営者（サイトに出るもの）。権限が無い原本は「権限なし」と返し、0件にしない。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, accessOf, canRecruit } from "../../lib/gw.js";
import { admin, userClient } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { STATUS_LABEL, CLOSED_STATUSES, NEXT_ACTION_LABEL } from "../../lib/hr.js";
import { MUGENDOJO_STATUS_LABEL, MUGENDOJO_STAGES, LEAD_NEXT_ACTIONS, leadNextActionOf } from "../../lib/hr-lead-flow.js";
import { viewState, urlOf, jstToday, KINDS } from "../../lib/site-news.js";
import {
  WORK_SOURCES, PRODUCTION_SOURCES, normalizePlan, publishProblem, displayState,
  planStateLabel, mediumLabel, parseYouTubeUrl, interpretOEmbed, OEMBED_LABEL, VIDEO_SITES, videoSite,
  placementFingerprint,
} from "../../lib/marketing.js";
import { adapterFor } from "../../lib/marketing-sites.js";

const SQL = "db/proposal_marketing.sql";
const LEAD_LIMIT = 300;
const NEW_HOURS = 24;
const PUBLISHED_DAYS = 30;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEAD_FIELDS = "id, name, email, source, job_title, stage, status, recruiter_id, decision_due_on, "
  + "lead_category, lead_profile, lead_next_action, hold_next_step, last_contacted_at, created_at, updated_at";
const LEAD_DETAIL_FIELDS = `${LEAD_FIELDS}, phone, utm_source, utm_medium, utm_campaign`;
const NEWS_FIELDS = "id, slug, title, kind, summary, status, published_on, source, created_by, updated_by, updated_at";
const PLAN_FIELDS = "id, tenant_id, biz, medium, sns_channel, title, summary, owner_employee_id, due_on, state, "
  + "scheduled_on, public_url, source_type, source_id, youtube_video_id, inquiry_refs, version, created_at, updated_at";

// 入口はヘッダー・画面と同じ判定（lib/gw.js canAccessMarketing ＝ /api/me の access.marketing）
export const canOpenMarketing = (ctx) => Boolean(accessOf(ctx).marketing);
export const canManageSite = (ctx) => Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));
const hashOf = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const isMissing = (e) => Boolean(dbSetupHint(e, SQL)) || String(e?.code || "") === "42703";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canOpenMarketing(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "マーケティングは、Office に入れる人だけが開けます" });
  }
  res.setHeader?.("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const q = new URL(req.url || "/", "http://localhost").searchParams;
      if (q.get("count") === "1") return json(res, 200, await countOnly(req, ctx, user));
      if (q.get("view") === "production") return json(res, 200, await production(ctx));
      if (q.get("id")) return await detail(req, res, ctx, user, q.get("id"));
      return json(res, 200, await work(req, ctx, user));
    }
    if (req.method === "POST") return await post(req, res, ctx, user);
    return methodNotAllowed(res, ["GET", "POST"]);
  } catch (e) {
    console.error("[marketing]", e?.message || e);
    return json(res, 500, { error: "server_error" });
  }
}

// ---- 対応が必要な業務 ---------------------------------------------------------------------
const sourceInfo = (s, extra) => ({
  key: s.key, biz: s.biz, kind: s.kind, label: s.label, original: s.original,
  scope: s.scope || null, need: s.need || [], missing: s.missing || [], ...extra,
});

async function readLeads(req, ctx) {
  const sb = userClient(req);
  const { data, error } = await sb.from("gw_hr_applicants").select(LEAD_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("lead_category", "mugendojo")
    .order("created_at", { ascending: false }).limit(LEAD_LIMIT + 1);
  if (error) {
    if (isMissing(error)) return { state: "not_ready", hint: "採用HRの無限道場リード（db/118_hr_leads.sql）が未適用です" };
    return { state: "failed", hint: "採用HRの無限道場リードを読めませんでした" };
  }
  const rows = data || [];
  return { state: "ok", rows: rows.slice(0, LEAD_LIMIT), capped: rows.length > LEAD_LIMIT };
}

async function namesOf(ctx, ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return new Map();
  const { data } = await admin().from("gw_employees").select("id, display_name")
    .eq("tenant_id", ctx.tenantId).in("id", want);
  return new Map((data || []).map((e) => [e.id, e.display_name || "（名前未登録）"]));
}

/** 自分の既読。表が無ければ null（「確認できない」）。読むだけ */
async function myReads(ctx, user, source, ids) {
  if (!ids.length) return { ready: true, set: new Set() };
  const { data, error } = await admin().from("gw_marketing_reads").select("source_id")
    .eq("tenant_id", ctx.tenantId).eq("user_id", user.id).eq("source", source).in("source_id", ids);
  if (error) return { ready: false, set: null };
  return { ready: true, set: new Set((data || []).map((r) => r.source_id)) };
}

const leadStatus = (a) => ({
  key: a.status,
  label: MUGENDOJO_STATUS_LABEL[a.status] || STATUS_LABEL[a.status] || a.status,
  open: !CLOSED_STATUSES.includes(a.status),
});
const stageLabel = (k) => MUGENDOJO_STAGES.find((s) => s.key === k)?.label || null;
// 要点は原本の構造化項目だけ（推測で用件・期限を補わない）
function leadPoints(p) {
  const x = p || {};
  const out = [];
  if (x.kind === "instructor") return out;
  if (x.occupation) out.push(`職業：${x.occupation}`);
  if (Array.isArray(x.interests) && x.interests.length) out.push(`興味：${x.interests.slice(0, 4).join("・")}`);
  if (x.diagnosis_label || x.diagnosis_type) out.push(`診断：${x.diagnosis_label || x.diagnosis_type}`);
  if (x.prefecture) out.push(`地域：${x.prefecture}`);
  return out;
}
const excerpt = (s, n = 80) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function leadItem(a, names, reads, now) {
  const next = leadNextActionOf(a) || { label: NEXT_ACTION_LABEL[a.status] || "" };
  const received = a.created_at;
  return {
    key: `hr_lead:${a.id}`, source: "hr_lead", sourceId: a.id, biz: "mugen", kind: "inquiry",
    typeLabel: "無料カウンセリング",
    from: a.name,
    subject: a.job_title || "無料カウンセリングの申込",
    points: leadPoints(a.lead_profile),
    // 原文の抜粋（本人が書いた「困っていること」）。全文は詳細で
    quote: excerpt(a.lead_profile?.challenge_text),
    receivedAt: received,
    isNew: Boolean(received) && now - Date.parse(received) < NEW_HOURS * 3600000,
    owner: a.recruiter_id ? { id: a.recruiter_id, name: names.get(a.recruiter_id) || "（名前未登録）" } : null,
    status: leadStatus(a),
    stage: stageLabel(a.stage),
    next: next.label || "",
    due: a.decision_due_on || null,
    read: reads.ready ? reads.set.has(a.id) : null,
    href: `/hr/applicants.html?category=mugendojo&id=${encodeURIComponent(a.id)}`,
    canReply: Boolean(String(a.email || "").trim()),
    updatedAt: a.updated_at,
  };
}

async function work(req, ctx, user) {
  const now = Date.now();
  const sources = [];
  let items = [];
  let readsReady = null;
  for (const s of WORK_SOURCES) {
    if (!s.connected) { sources.push(sourceInfo(s, { state: "not_connected", count: null })); continue; }
    if (s.key === "hr_lead") {
      if (!canRecruit(ctx)) {
        sources.push(sourceInfo(s, { state: "forbidden", count: null, hint: "採用HRの権限がある人だけが見られます" }));
        continue;
      }
      const got = await readLeads(req, ctx);
      if (got.state !== "ok") { sources.push(sourceInfo(s, { state: got.state, count: null, hint: got.hint })); continue; }
      const names = await namesOf(ctx, got.rows.map((a) => a.recruiter_id));
      const reads = await myReads(ctx, user, "hr_lead", got.rows.map((a) => a.id));
      readsReady = readsReady === false ? false : reads.ready;
      const mine = got.rows.map((a) => leadItem(a, names, reads, now));
      items = items.concat(mine);
      sources.push(sourceInfo(s, {
        state: "ok", fetchedAt: new Date(now).toISOString(),
        count: mine.filter((x) => x.status.open).length, total: mine.length, capped: got.capped,
        limit: LEAD_LIMIT,
      }));
    }
  }
  items.sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const open = items.filter((x) => x.status.open);
  return {
    fetchedAt: new Date(now).toISOString(),
    sources,
    items,
    readsReady: readsReady === null ? null : readsReady,
    unreadCount: readsReady ? open.filter((x) => x.read === false).length : null,
    newCount: open.filter((x) => x.isNew).length,
    openCount: open.length,
  };
}

async function countOnly(req, ctx, user) {
  const w = await work(req, ctx, user);
  return {
    fetchedAt: w.fetchedAt,
    sources: w.sources.map((s) => {
      const open = s.state === "ok" ? w.items.filter((x) => x.source === s.key && x.status.open) : null;
      return { key: s.key, biz: s.biz, label: s.label, state: s.state, count: s.count ?? null,
        newCount: open ? open.filter((x) => x.isNew).length : null };
    }),
    openCount: w.openCount, newCount: w.newCount, unreadCount: w.unreadCount,
  };
}

async function detail(req, res, ctx, user, key) {
  const [source, id] = String(key).split(":");
  if (source !== "hr_lead" || !ID_RE.test(id || "")) return json(res, 400, { error: "invalid_id" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden", hint: "採用HRの権限がある人だけが見られます" });
  const sb = userClient(req);
  const { data: a, error } = await sb.from("gw_hr_applicants").select(LEAD_DETAIL_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("id", id).eq("lead_category", "mugendojo").maybeSingle();
  if (error) {
    if (isMissing(error)) return json(res, 503, { error: "not_ready", hint: "採用HRの無限道場リード（db/118_hr_leads.sql）が未適用です" });
    return json(res, 500, { error: "db_query_failed" });
  }
  if (!a) return json(res, 404, { error: "not_found" });
  const names = await namesOf(ctx, [a.recruiter_id]);
  const reads = await myReads(ctx, user, "hr_lead", [a.id]);
  const { data: tl } = await sb.from("gw_hr_timeline").select("label, detail, occurred_at")
    .eq("tenant_id", ctx.tenantId).eq("applicant_id", a.id)
    .order("occurred_at", { ascending: false }).limit(5);
  const p = a.lead_profile || {};
  return json(res, 200, {
    item: leadItem(a, names, reads, Date.now()),
    detail: {
      email: a.email || null, phone: a.phone || null,
      profile: {
        occupation: p.occupation || null, prefecture: p.prefecture || null,
        aiExperience: p.ai_experience || null, itExperience: p.it_experience || null,
        interests: Array.isArray(p.interests) ? p.interests : [],
        challenge: p.challenge_text || null,
        diagnosis: p.diagnosis_label || p.diagnosis_type || null,
      },
      inflow: [a.utm_source, a.utm_medium, a.utm_campaign].filter(Boolean).join(" / ") || null,
      timeline: (tl || []).map((t) => ({ label: t.label, detail: t.detail || null, at: t.occurred_at })),
      nextActions: LEAD_NEXT_ACTIONS.map(({ key: k, label }) => ({ key: k, label })),
      readsReady: reads.ready,
    },
  });
}

// ---- 制作予定 ------------------------------------------------------------------------------
async function production(ctx) {
  const now = new Date();
  const today = jstToday(now.getTime());
  const sources = [];
  let items = [];
  const kindLabel = (k) => KINDS.find((x) => x.key === k)?.label || k || "お知らせ";
  const newsById = new Map();

  // 自社サイトのお知らせ（原本：news_articles。api/site-news と同じ権限）
  const news = PRODUCTION_SOURCES.find((s) => s.key === "site_news");
  if (!canManageSite(ctx)) {
    sources.push({ ...news, state: "forbidden", count: null, hint: "管理者・経営者だけが見られます（サイトのお知らせと同じ）" });
  } else {
    const { data, error } = await admin().from("news_articles").select(NEWS_FIELDS)
      .order("published_on", { ascending: false, nullsFirst: false }).limit(500);
    if (error) {
      const hint = dbSetupHint(error, "8grp-site の 8/zimu/news/articles.sql");
      sources.push({ ...news, state: hint ? "not_ready" : "failed", count: null, hint: hint || "読めませんでした" });
    } else {
      const since = new Date(now.getTime() + 9 * 3600000 - PUBLISHED_DAYS * 86400000).toISOString().slice(0, 10);
      let older = 0;
      for (const a of data || []) {
        const view = viewState(a, today);
        newsById.set(String(a.id), { a, view });
        if (view.key === "published" && String(a.published_on || "").slice(0, 10) < since) { older += 1; continue; }
        items.push({
          key: `site_news:${a.id}`, origin: "site_news", biz: "site", medium: "column", mediumLabel: kindLabel(a.kind),
          // 原本（お知らせ）に担当・期限の項目は無い。書いた人（名前の文字列）は「作成」として出すだけ
          title: a.title, summary: excerpt(a.summary, 120), owner: null, ownerFrom: "none", author: a.created_by || null,
          due: null, state: displayState(view, null), originalState: view.label,
          scheduledOn: view.key === "planned" ? a.published_on : null,
          publicUrl: view.key === "draft" ? null : urlOf(a.slug),
          publicUrlNote: view.key === "draft" ? null : "サイトへの反映は毎朝8時の同期のあと",
          originalUrl: `/admin-site-news.html#${encodeURIComponent(a.id)}`,
          plan: null,
        });
      }
      sources.push({ ...news, state: "ok", fetchedAt: now.toISOString(), count: items.length, olderPublished: older });
    }
  }

  // この画面で登録した企画（未適用なら「未準備」）
  const planSrc = PRODUCTION_SOURCES.find((s) => s.key === "plan");
  const { data: plans, error: perr } = await admin().from("gw_marketing_items").select(PLAN_FIELDS)
    .eq("tenant_id", ctx.tenantId).order("updated_at", { ascending: false }).limit(300);
  if (perr) {
    const ready = !isMissing(perr);
    sources.push({ ...planSrc, state: ready ? "failed" : "not_ready", count: null,
      hint: ready ? "読めませんでした" : `制作予定の保存先が未準備です（${SQL} が未適用）` });
  } else {
    const owners = await namesOf(ctx, (plans || []).map((p) => p.owner_employee_id));
    const leadsVisible = canRecruit(ctx);
    for (const p of plans || []) {
      const linked = p.source_type === "site_news" ? newsById.get(String(p.source_id)) : null;
      if (linked) items = items.filter((x) => x.key !== `site_news:${p.source_id}`);
      items.push(planItem(p, linked, owners, leadsVisible));
    }
    sources.push({ ...planSrc, state: "ok", fetchedAt: now.toISOString(), count: (plans || []).length });
  }
  for (const s of PRODUCTION_SOURCES.filter((x) => !x.connected)) {
    sources.push({ ...s, state: "not_connected", count: null });
  }
  // 担当の候補（同じテナントの在籍中の社員。名前だけ）
  const { data: emps } = await admin().from("gw_employees").select("id, display_name, status")
    .eq("tenant_id", ctx.tenantId).in("status", ["active", "leaving"]).order("display_name").limit(500);
  const employees = (emps || []).map((e) => ({ id: e.id, name: e.display_name }));
  return { fetchedAt: now.toISOString(), today, sources, items, videoSites: VIDEO_SITES, employees,
    canManageSite: canManageSite(ctx), canLinkInquiries: canRecruit(ctx) };
}

function planItem(p, linked, owners, leadsVisible) {
  const refs = Array.isArray(p.inquiry_refs) ? p.inquiry_refs : [];
  const visibleRefs = refs.filter((r) => r?.source === "hr_lead" && leadsVisible);
  return {
    key: `plan:${p.id}`, origin: "plan", id: p.id, version: p.version, biz: p.biz, medium: p.medium,
    mediumLabel: mediumLabel(p.medium), snsChannel: p.sns_channel || null,
    title: p.title, summary: p.summary || "", ownerId: p.owner_employee_id || null,
    owner: p.owner_employee_id ? owners.get(p.owner_employee_id) || "（名前未登録）" : null, ownerFrom: "plan",
    due: p.due_on || null, scheduledOn: p.scheduled_on || null,
    state: displayState(linked ? linked.view : null, p.state), planState: p.state, planStateLabel: planStateLabel(p.state),
    originalState: linked ? linked.view.label : null,
    publicUrl: linked && linked.view.key !== "draft" ? urlOf(linked.a.slug) : p.public_url || null,
    originalUrl: linked ? `/admin-site-news.html#${encodeURIComponent(p.source_id)}` : null,
    sourceType: p.source_type || null, sourceId: p.source_id || null,
    youtubeVideoId: p.youtube_video_id || null,
    inquiries: visibleRefs.map((r) => ({ key: `hr_lead:${r.id}`, href: `/hr/applicants.html?category=mugendojo&id=${encodeURIComponent(r.id)}` })),
    hiddenInquiries: refs.length - visibleRefs.length,
    updatedAt: p.updated_at,
  };
}

// ---- 書き込み（明示操作だけ） ---------------------------------------------------------------
async function post(req, res, ctx, user) {
  const body = await readJson(req);
  if (!body || typeof body !== "object") return json(res, 400, { error: "invalid_body" });
  switch (body.action) {
    case "read": return markRead(res, ctx, user, body);
    case "plan.create": return createPlan(res, ctx, user, body);
    case "plan.update": return updatePlan(res, ctx, user, body);
    case "video.check": return json(res, 200, await checkVideo(body.url));
    case "video.preview": return previewVideo(res, ctx, body);
    case "video.place": return placeVideo(res, ctx, user, body);
    default: return json(res, 400, { error: "unknown_action" });
  }
}

async function markRead(res, ctx, user, body) {
  const [source, id] = String(body.key || "").split(":");
  if (source !== "hr_lead" || !ID_RE.test(id || "")) return json(res, 400, { error: "invalid_key" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });
  const sb = admin();
  // 原本が同じテナントにあるときだけ（別テナント・存在しないIDに既読を作らない）
  const { data: a, error } = await sb.from("gw_hr_applicants").select("id")
    .eq("tenant_id", ctx.tenantId).eq("id", id).eq("lead_category", "mugendojo").maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed" });
  if (!a) return json(res, 404, { error: "not_found" });
  const { error: werr } = await sb.from("gw_marketing_reads").upsert(
    { tenant_id: ctx.tenantId, source, source_id: id, user_id: user.id, read_at: new Date().toISOString() },
    { onConflict: "tenant_id,source,source_id,user_id", ignoreDuplicates: true },
  );
  if (werr) {
    if (isMissing(werr)) return json(res, 503, { error: "not_ready", hint: `既読の保存先が未準備です（${SQL} が未適用）` });
    return json(res, 500, { error: "db_write_failed" });
  }
  return json(res, 200, { ok: true, key: `${source}:${id}`, read: true });
}

async function validRefs(ctx, refs) {
  if (refs == null) return { ok: true, value: [] };
  if (!Array.isArray(refs) || refs.length > 20) return { ok: false, error: "もとにした問い合わせは20件までです" };
  const ids = [];
  for (const r of refs) {
    if (r?.source !== "hr_lead" || !ID_RE.test(String(r?.id || ""))) return { ok: false, error: "問い合わせの指定が正しくありません" };
    ids.push(String(r.id));
  }
  if (!ids.length) return { ok: true, value: [] };
  if (!canRecruit(ctx)) return { ok: false, error: "問い合わせを紐づけるには採用HRの権限が必要です", status: 403 };
  const { data, error } = await admin().from("gw_hr_applicants").select("id")
    .eq("tenant_id", ctx.tenantId).eq("lead_category", "mugendojo").in("id", [...new Set(ids)]);
  if (error) return { ok: false, error: "問い合わせを確かめられませんでした", status: 500 };
  const found = new Set((data || []).map((x) => x.id));
  if (ids.some((x) => !found.has(x))) return { ok: false, error: "見つからない問い合わせがあります", status: 404 };
  // 中身（氏名・本文）は写さない。原本の種類とIDだけ
  return { ok: true, value: [...new Set(ids)].map((x) => ({ source: "hr_lead", id: x })) };
}

async function validOwner(ctx, id) {
  if (!id) return true;
  if (!ID_RE.test(String(id))) return false;
  const { data } = await admin().from("gw_employees").select("id").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  return Boolean(data);
}

async function validSource(body) {
  if (body.sourceType == null && body.sourceId == null) return { ok: true, value: {} };
  if (body.sourceType !== "site_news" || !body.sourceId) return { ok: false, error: "原本の指定が正しくありません" };
  const { data, error } = await admin().from("news_articles").select("id").eq("id", body.sourceId).maybeSingle();
  if (error || !data) return { ok: false, error: "原本（サイトのお知らせ）が見つかりません", status: 404 };
  return { ok: true, value: { source_type: "site_news", source_id: String(body.sourceId) } };
}

async function createPlan(res, ctx, user, body) {
  const v = normalizePlan(body);
  if (!v.ok) return json(res, 400, { error: "invalid_body", message: v.error, field: v.field });
  if (body.sourceType && !canManageSite(ctx)) return json(res, 403, { error: "forbidden", message: "サイトのお知らせと紐づけられるのは管理者・経営者だけです" });
  const src = await validSource(body);
  if (!src.ok) return json(res, src.status || 400, { error: "invalid_source", message: src.error });
  const refs = await validRefs(ctx, body.inquiryRefs);
  if (!refs.ok) return json(res, refs.status || 400, { error: "invalid_refs", message: refs.error });
  if (!(await validOwner(ctx, v.value.owner_employee_id))) return json(res, 400, { error: "invalid_owner", message: "担当は社員から選んでください" });
  const yt = body.youtubeUrl ? parseYouTubeUrl(body.youtubeUrl) : null;
  if (body.youtubeUrl && !yt) return json(res, 400, { error: "invalid_youtube", message: "YouTube の動画URLではありません" });
  if (yt && v.value.medium !== "youtube") return json(res, 400, { error: "invalid_youtube", message: "動画は媒体「YouTube動画」の制作予定にだけ付けられます" });
  const row = {
    tenant_id: ctx.tenantId, ...v.value, ...src.value, inquiry_refs: refs.value,
    youtube_video_id: yt ? yt.videoId : null, created_by: user.id, updated_by: user.id,
  };
  const problem = publishProblem({ state: row.state || "plan", public_url: row.public_url, source_type: row.source_type });
  if (problem) return json(res, 400, { error: "needs_public_url", message: problem });
  const { data, error } = await admin().from("gw_marketing_items").insert(row).select(PLAN_FIELDS).single();
  if (error) {
    if (isMissing(error)) return json(res, 503, { error: "not_ready", hint: `制作予定の保存先が未準備です（${SQL} が未適用）` });
    if (String(error.code) === "23505") return json(res, 409, { error: "duplicate", message: "この原本の制作予定は既にあります" });
    return json(res, 500, { error: "db_write_failed" });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "marketing.plan_create", target: `marketing_item:${data.id}`,
    detail: { biz: data.biz, medium: data.medium, state: data.state, refs: data.inquiry_refs.length } });
  return json(res, 201, { ok: true, item: data });
}

async function updatePlan(res, ctx, user, body) {
  if (!ID_RE.test(String(body.id || ""))) return json(res, 400, { error: "invalid_id" });
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 1) return json(res, 400, { error: "invalid_version" });
  const v = normalizePlan(body, { partial: true });
  if (!v.ok) return json(res, 400, { error: "invalid_body", message: v.error, field: v.field });
  const sb = admin();
  const { data: cur, error: cerr } = await sb.from("gw_marketing_items").select(PLAN_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
  if (cerr) {
    if (isMissing(cerr)) return json(res, 503, { error: "not_ready", hint: `制作予定の保存先が未準備です（${SQL} が未適用）` });
    return json(res, 500, { error: "db_query_failed" });
  }
  if (!cur) return json(res, 404, { error: "not_found" });
  if (cur.version !== version) return json(res, 409, { error: "version_conflict", message: "ほかの人が先に直しました。開き直してください", item: cur });
  const patch = { ...v.value, updated_by: user.id };
  if ("inquiryRefs" in body) {
    const refs = await validRefs(ctx, body.inquiryRefs);
    if (!refs.ok) return json(res, refs.status || 400, { error: "invalid_refs", message: refs.error });
    // 自分に見えない紐づけ（権限の無い原本）は、黙って消さない
    patch.inquiry_refs = refs.value;
  }
  if ("ownerEmployeeId" in body && !(await validOwner(ctx, patch.owner_employee_id))) {
    return json(res, 400, { error: "invalid_owner", message: "担当は社員から選んでください" });
  }
  const merged = { ...cur, ...patch };
  const problem = publishProblem(merged);
  if (problem) return json(res, 400, { error: "needs_public_url", message: problem });
  // 版の比較つきで書く（同時に直したら、後の人は 409）
  const { data, error } = await sb.from("gw_marketing_items").update(patch)
    .eq("tenant_id", ctx.tenantId).eq("id", body.id).eq("version", version).select(PLAN_FIELDS).maybeSingle();
  if (error) return json(res, 500, { error: "db_write_failed" });
  if (!data) return json(res, 409, { error: "version_conflict", message: "ほかの人が先に直しました。開き直してください" });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "marketing.plan_update", target: `marketing_item:${data.id}`,
    detail: { fields: Object.keys(patch).filter((k) => k !== "updated_by"), from: cur.state, to: data.state } });
  return json(res, 200, { ok: true, item: data });
}

// ---- YouTube --------------------------------------------------------------------------------
async function checkVideo(url) {
  const yt = parseYouTubeUrl(url);
  if (!yt) return { ok: false, error: "invalid_youtube", message: "YouTube の動画URLではありません（watch?v= / youtu.be / shorts / embed / live）" };
  let o = { state: "unknown" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(yt.watchUrl)}`, { signal: ctl.signal });
    let b = null;
    try { b = await r.json(); } catch { b = null; }
    o = interpretOEmbed(r.status, b);
  } catch {
    o = { state: "unknown" };
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, video: yt, oembed: { ...o, label: OEMBED_LABEL[o.state] }, checkedAt: new Date().toISOString() };
}

function siteRequests(body) {
  const list = Array.isArray(body.sites) ? body.sites : [];
  if (!list.length || list.length > VIDEO_SITES.length) return { ok: false, error: "掲載先を選んでください" };
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const site = videoSite(s?.site);
    if (!site) return { ok: false, error: "掲載先が正しくありません" };
    const position = String(s.position || "").trim();
    const title = String(s.title || "").trim();
    const description = String(s.description || "").trim();
    if (!position || position.length > 80) return { ok: false, error: `${site.label}：掲載位置を選んでください` };
    if (!title || title.length > 200) return { ok: false, error: `${site.label}：タイトルを入れてください（200文字まで）` };
    if (description.length > 1000) return { ok: false, error: `${site.label}：説明は1000文字までです` };
    const k = `${site.key}|${position}`;
    if (seen.has(k)) return { ok: false, error: `${site.label}：同じ位置を2回選んでいます` };
    seen.add(k);
    out.push({ site: site.key, position, title, description, confirmHash: s.confirmHash || null });
  }
  return { ok: true, value: out };
}

async function loadVideoItem(ctx, itemId) {
  if (!ID_RE.test(String(itemId || ""))) return { status: 400, error: "invalid_id" };
  const { data, error } = await admin().from("gw_marketing_items").select("id, medium, youtube_video_id")
    .eq("tenant_id", ctx.tenantId).eq("id", itemId).maybeSingle();
  if (error) return isMissing(error) ? { status: 503, error: "not_ready" } : { status: 500, error: "db_query_failed" };
  if (!data) return { status: 404, error: "not_found" };
  if (data.medium !== "youtube") return { status: 400, error: "not_video_item" };
  return { item: data };
}

async function previewVideo(res, ctx, body) {
  const yt = parseYouTubeUrl(body.url);
  if (!yt) return json(res, 400, { error: "invalid_youtube", message: "YouTube の動画URLではありません" });
  const sites = siteRequests(body);
  if (!sites.ok) return json(res, 400, { error: "invalid_sites", message: sites.error });
  const loaded = await loadVideoItem(ctx, body.itemId);
  if (loaded.error) return json(res, loaded.status, { error: loaded.error, hint: loaded.status === 503 ? `制作予定の保存先が未準備です（${SQL} が未適用）` : undefined });
  return json(res, 200, {
    ok: true, video: yt,
    sites: sites.value.map((s) => {
      const site = videoSite(s.site);
      const supported = Boolean(adapterFor(s.site));
      return {
        site: s.site, label: site.label, position: s.position, title: s.title, description: s.description,
        supported, reason: supported ? null : site.reason, need: supported ? [] : site.need, original: site.original,
        confirmHash: hashOf(placementFingerprint({ videoId: yt.videoId, ...s })),
      };
    }),
  });
}

async function placeVideo(res, ctx, user, body) {
  if (!canManageSite(ctx)) return json(res, 403, { error: "forbidden", message: "サイトへの掲載を確定できるのは管理者・経営者だけです" });
  const yt = parseYouTubeUrl(body.url);
  if (!yt) return json(res, 400, { error: "invalid_youtube", message: "YouTube の動画URLではありません" });
  const sites = siteRequests(body);
  if (!sites.ok) return json(res, 400, { error: "invalid_sites", message: sites.error });
  if (body.publicConfirmed !== true) {
    return json(res, 400, { error: "needs_public_confirmation", message: "YouTube 上で公開動画（限定公開・非公開ではない）であることを確認してください" });
  }
  const loaded = await loadVideoItem(ctx, body.itemId);
  if (loaded.error) return json(res, loaded.status, { error: loaded.error });
  // プレビュー後に動画・掲載先・位置・タイトル・説明が変わっていたら、確認し直してもらう（どのサイトも載せない）
  const stale = sites.value.filter((s) => s.confirmHash !== hashOf(placementFingerprint({ videoId: yt.videoId, ...s })));
  if (stale.length) {
    return json(res, 409, { error: "reconfirm", message: "プレビューのあとで内容が変わりました。もう一度プレビューして確認してください",
      sites: stale.map((s) => s.site) });
  }
  const sb = admin();
  const results = [];
  for (const s of sites.value) {
    const adapter = adapterFor(s.site);
    const site = videoSite(s.site);
    if (!adapter) { results.push({ site: s.site, label: site.label, result: "unsupported", message: site.reason }); continue; }
    const row = {
      tenant_id: ctx.tenantId, item_id: loaded.item.id, video_id: yt.videoId, site: s.site, position: s.position,
      title: s.title, description: s.description || null, confirm_hash: s.confirmHash, state: "confirmed", confirmed_by: user.id,
    };
    const { data: placed, error } = await sb.from("gw_marketing_video_placements").insert(row).select("id").single();
    if (error) {
      if (String(error.code) === "23505") { results.push({ site: s.site, label: site.label, result: "duplicate", message: "同じ動画が同じ位置に既に載っています（二重掲載はしません）" }); continue; }
      if (isMissing(error)) { results.push({ site: s.site, label: site.label, result: "not_ready", message: "掲載記録の保存先が未準備です" }); continue; }
      results.push({ site: s.site, label: site.label, result: "failed", message: "記録できませんでした" });
      continue;
    }
    let out;
    try { out = await adapter.publish({ tenantId: ctx.tenantId, videoId: yt.videoId, position: s.position, title: s.title, description: s.description }); }
    catch { out = { ok: false, error: "掲載先との通信に失敗しました" }; }
    const state = out?.ok ? "published" : "failed";
    await sb.from("gw_marketing_video_placements").update({ state, result_note: out?.ok ? (out.url || null) : String(out?.error || "失敗").slice(0, 500) })
      .eq("id", placed.id).eq("tenant_id", ctx.tenantId);
    results.push({ site: s.site, label: site.label, result: state, url: out?.url || null, message: out?.ok ? null : String(out?.error || "失敗") });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "marketing.video_place", target: `marketing_item:${loaded.item.id}`,
    detail: { videoId: yt.videoId, results: results.map((r) => ({ site: r.site, result: r.result })) } });
  const allOk = results.every((r) => r.result === "published");
  return json(res, allOk ? 200 : 207, { ok: allOk, results });
}

