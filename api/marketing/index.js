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
//   この画面に入れるのは、経営者か、メンバー管理の「使える業務」でマーケティングを付けた人（access.marketing）。
//   Office の権限だけでは入れない。原本ごとに、原本の権限をサーバで確かめる（本人のトークンで各事業の既存の関数・RLS を呼ぶ）。
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
import {
  readSpace, spaceItem, spaceDetail, spaceDetailView, spaceCall, spaceMail,
  readCourse, courseItem, courseOne, courseDetailView,
  readContact, contactItem, contactOne, contactDetailView, contactUpdate, contactBiz, probe,
} from "../../lib/marketing-sources.js";

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
    return json(res, 403, { error: "forbidden", hint: "マーケティングは、経営者か、メンバー管理の「使える業務」でマーケティングを付けた人だけが開けます" });
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
  scope: s.scope || null, need: s.need || [], missing: s.missing || [], requires: s.requires || null, via: s.via || null, ...extra,
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

// 採用HRの無限道場リードの詳細を、ほかの原本と同じ形（送信者・本文・項目・履歴・担当・次の対応・操作）にする
function leadDetailView(a, item, tl, names) {
  const p = a.lead_profile || {};
  return {
    contact: [["お名前", a.name], ["メール", a.email], ["電話", a.phone],
      ["流入", [a.utm_source, a.utm_medium, a.utm_campaign].filter(Boolean).join(" / ")]].filter(([, v]) => v),
    body: { label: "本人が書いた内容（原文）", text: p.challenge_text || "" },
    fields: [["職業", p.occupation], ["地域", p.prefecture], ["AIの経験", p.ai_experience], ["ITの経験", p.it_experience],
      ["興味", Array.isArray(p.interests) ? p.interests.join("・") : null], ["診断", p.diagnosis_label || p.diagnosis_type],
      ["選考の段階", item.stage], ["状態", item.status.label]].filter(([, v]) => v),
    bookings: [],
    history: (tl || []).map((t) => ({ at: t.occurred_at, label: t.label, detail: t.detail || null, who: null, kind: "event" })),
    owner: a.recruiter_id ? { name: names.get(a.recruiter_id) || "（名前未登録）", from: "採用HRの担当" } : null,
    ownerNote: a.recruiter_id ? null : "担当は未設定（採用HR）",
    next: item.next, due: a.decision_due_on || null, dueNote: a.decision_due_on ? null : "期限は未設定（採用HR）",
    actions: { reply: item.canReply, nextAction: LEAD_NEXT_ACTIONS.map(({ key: k, label }) => ({ key: k, label })) },
  };
}

const SOURCE_IDS = new Set(["hr_lead", "space_inquiry", "mugen_course", "ec_contact", "site_contact"]);
const sourceOf = (key) => WORK_SOURCES.find((s) => s.key === key);

async function work(req, ctx, user) {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const sb = userClient(req);
  const S = Object.fromEntries(WORK_SOURCES.map((s) => [s.key, s]));
  const info = {};
  let items = [];
  const readyFlags = [];
  const add = async (key, rows, toItem, extra = {}) => {
    const reads = await myReads(ctx, user, key, rows.map((r) => r.id));
    readyFlags.push(reads.ready);
    const mine = rows.map((r) => toItem(r, reads));
    items = items.concat(mine);
    info[key] = sourceInfo(S[key], { state: "ok", fetchedAt: at, count: mine.filter((x) => x.status.open).length,
      total: mine.length, ...extra });
  };
  const fail = (key, got) => { info[key] = sourceInfo(S[key], { state: got.state, count: null, hint: got.hint || null }); };

  // 原本ごとに並べて読む（1つが失敗・権限なしでも、ほかは出す）
  const [leads, space, course, contact] = await Promise.all([
    canRecruit(ctx) ? readLeads(req, ctx) : Promise.resolve({ state: "forbidden", hint: "採用HRの権限がある人だけが見られます" }),
    readSpace(sb, { now }).catch(() => ({ state: "failed", hint: "8sp を読めませんでした" })),
    readCourse(sb).catch(() => ({ state: "failed", hint: "無限道場を読めませんでした" })),
    readContact(sb).catch(() => ({ state: "failed", hint: "問い合わせの表を読めませんでした" })),
  ]);
  if (leads.state === "ok") {
    const names = await namesOf(ctx, leads.rows.map((a) => a.recruiter_id));
    await add("hr_lead", leads.rows, (a, reads) => leadItem(a, names, reads, now), { capped: leads.capped, limit: LEAD_LIMIT });
  } else fail("hr_lead", leads);
  if (space.state === "ok") {
    await add("space_inquiry", space.rows, (r, reads) => spaceItem(r, space.extra, reads, now),
      { capped: space.capped, limit: space.limit, ownerReadable: Boolean(space.extra) });
  } else fail("space_inquiry", space);
  if (course.state === "ok") await add("mugen_course", course.rows, (a, reads) => courseItem(a, reads, now), { capped: course.capped, limit: course.limit });
  else fail("mugen_course", course);
  if (contact.state === "ok") {
    const unknownNote = contact.unknown.count
      ? `送信元ページから事業を判定できない問い合わせが ${contact.unknown.count}件あります（${contact.unknown.sources.join("・")}）。ここには出していません` : null;
    await add("ec_contact", contact.rows.filter((r) => contactBiz(r.source) === "ec"), (c, reads) => contactItem(c, reads, now), { unknownNote });
    await add("site_contact", contact.rows.filter((r) => contactBiz(r.source) === "site"), (c, reads) => contactItem(c, reads, now), { unknownNote });
  } else { fail("ec_contact", contact); fail("site_contact", contact); }
  for (const s of WORK_SOURCES) if (!s.connected) info[s.key] = sourceInfo(s, { state: "not_connected", count: null });

  items.sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const open = items.filter((x) => x.status.open);
  const readsReady = readyFlags.length ? readyFlags.every(Boolean) : null;
  return {
    fetchedAt: at,
    sources: WORK_SOURCES.map((s) => info[s.key]),
    items,
    readsReady,
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
  if (!SOURCE_IDS.has(source) || !ID_RE.test(id || "")) return json(res, 400, { error: "invalid_id" });
  const sb = userClient(req);
  const now = Date.now();
  const reads = await myReads(ctx, user, source, [id]);
  const out = (item, view) => json(res, 200, { item, view, readsReady: reads.ready, source: sourceInfo(sourceOf(source), {}) });
  const stop = (r) => json(res, r.status, { error: r.error, hint: r.status === 403 ? "その事業の権限がありません" : r.status === 503 ? "その事業の仕組みがこの DB にありません" : undefined });

  if (source === "hr_lead") {
    if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden", hint: "採用HRの権限がある人だけが見られます" });
    const { data: a, error } = await sb.from("gw_hr_applicants").select(LEAD_DETAIL_FIELDS)
      .eq("tenant_id", ctx.tenantId).eq("id", id).eq("lead_category", "mugendojo").maybeSingle();
    if (error) {
      if (isMissing(error)) return json(res, 503, { error: "not_ready", hint: "採用HRの無限道場リード（db/118_hr_leads.sql）が未適用です" });
      return json(res, 500, { error: "db_query_failed" });
    }
    if (!a) return json(res, 404, { error: "not_found" });
    const names = await namesOf(ctx, [a.recruiter_id]);
    const { data: tl } = await sb.from("gw_hr_timeline").select("label, detail, occurred_at")
      .eq("tenant_id", ctx.tenantId).eq("applicant_id", a.id).order("occurred_at", { ascending: false }).limit(10);
    const item = leadItem(a, names, reads, now);
    return out(item, leadDetailView(a, item, tl, names));
  }
  if (source === "space_inquiry") {
    const d = await spaceDetail(sb, id);
    if (d.status !== 200) return stop(d);
    const r = d.row;
    const item = spaceItem({ ...r, person: r.contact_person || r.name, org: r.contact_person ? r.name : null, wish: null,
      booking_state: null }, null, reads, now);
    const view = spaceDetailView(d, item);
    view.actions.replyVia = process.env.SPACE_MAIL_API_URL ? "space_mail" : null;
    view.actions.replyNote = process.env.SPACE_MAIL_API_URL ? null
      : "8sp のメールAPIの場所（SPACE_MAIL_API_URL）が未設定のため、ここからは送れません（8sp の事務画面から送れます）";
    return out(item, view);
  }
  if (source === "mugen_course") {
    const d = await courseOne(sb, id);
    if (d.status !== 200) return stop(d);
    return out(courseItem(d.row, reads, now), courseDetailView(d.row));
  }
  // ec_contact / site_contact
  const d = await contactOne(sb, id);
  if (d.status !== 200) return stop(d);
  const want = source === "site_contact" ? "site" : "ec";
  if (contactBiz(d.row.source) !== want) return json(res, 404, { error: "not_found" });
  return out(contactItem(d.row, reads, now), contactDetailView(d.row));
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
    case "read": return markRead(req, res, ctx, user, body);
    case "space.note": case "space.done": case "space.reopen": case "space.booking":
      return spaceAction(req, res, ctx, user, body);
    case "space.mail.compose": case "space.mail.send": return spaceMailAction(req, res, ctx, user, body);
    case "contact.update": return contactAction(req, res, ctx, user, body);
    case "plan.create": return createPlan(res, ctx, user, body);
    case "plan.update": return updatePlan(res, ctx, user, body);
    case "video.check": return json(res, 200, await checkVideo(body.url));
    case "video.preview": return previewVideo(res, ctx, body);
    case "video.place": return placeVideo(res, ctx, user, body);
    default: return json(res, 400, { error: "unknown_action" });
  }
}

// 既読は「押したとき」だけ。原本がその人に見えるとき（同じ権限・同じテナント）だけ記録する。中身は写さない
async function markRead(req, res, ctx, user, body) {
  const [source, id] = String(body.key || "").split(":");
  if (!SOURCE_IDS.has(source) || !ID_RE.test(id || "")) return json(res, 400, { error: "invalid_key" });
  const visible = await visibleToMe(req, ctx, source, id);
  if (visible.status !== 200) return json(res, visible.status, { error: visible.error });
  const { error: werr } = await admin().from("gw_marketing_reads").upsert(
    { tenant_id: ctx.tenantId, source, source_id: id, user_id: user.id, read_at: new Date().toISOString() },
    { onConflict: "tenant_id,source,source_id,user_id", ignoreDuplicates: true },
  );
  if (werr) {
    if (isMissing(werr)) return json(res, 503, { error: "not_ready", hint: `既読の保存先が未準備です（${SQL} が未適用）` });
    return json(res, 500, { error: "db_write_failed" });
  }
  return json(res, 200, { ok: true, key: `${source}:${id}`, read: true });
}

/** その原本が、本人の権限で見えるか（見えないものに既読や操作をさせない） */
async function visibleToMe(req, ctx, source, id) {
  const sb = userClient(req);
  if (source === "hr_lead") {
    if (!canRecruit(ctx)) return { status: 403, error: "forbidden" };
    const { data, error } = await admin().from("gw_hr_applicants").select("id")
      .eq("tenant_id", ctx.tenantId).eq("id", id).eq("lead_category", "mugendojo").maybeSingle();
    if (error) return { status: 500, error: "db_query_failed" };
    return data ? { status: 200 } : { status: 404, error: "not_found" };
  }
  if (source === "space_inquiry") {
    const p = await probe(sb, "space_is_staff");
    if (p.state !== "ok") return { status: p.state === "forbidden" ? 403 : 503, error: p.state };
    const { data, error } = await sb.from("rental_records").select("id").eq("id", id).maybeSingle();
    if (error) return { status: 500, error: "db_query_failed" };
    return data ? { status: 200 } : { status: 404, error: "not_found" };
  }
  if (source === "mugen_course") {
    const d = await courseOne(sb, id);
    return d.status === 200 ? { status: 200 } : { status: d.status, error: d.error };
  }
  const d = await contactOne(sb, id);
  if (d.status !== 200) return { status: d.status, error: d.error };
  return contactBiz(d.row.source) === (source === "site_contact" ? "site" : "ec") ? { status: 200 } : { status: 404, error: "not_found" };
}

// ---- スペース（8sp）の操作：8sp の既存の関数を本人の権限で呼ぶ ---------------------------------
async function spaceAction(req, res, ctx, user, body) {
  const [source, id] = String(body.key || "").split(":");
  if (source !== "space_inquiry" || !ID_RE.test(id || "")) return json(res, 400, { error: "invalid_key" });
  const sb = userClient(req);
  let r;
  if (body.action === "space.note") {
    const text = String(body.body ?? "").trim();
    if (!text || text.length > 2000) return json(res, 400, { error: "invalid_body", message: "メモは1〜2000文字で書いてください" });
    r = await spaceCall(sb, "space_add_inquiry_note", { p_record_id: id, p_body: text, p_important: body.important === true });
  } else if (body.action === "space.done") {
    r = await spaceCall(sb, "space_set_inquiry_done", { p_record_id: id });
  } else if (body.action === "space.reopen") {
    r = await spaceCall(sb, "space_reopen_inquiry", { p_record_id: id });
  } else {
    // 予約の承認・却下（8sp の space_admin_decide_booking。重なり・状態の順番は 8sp の見張りが止める）
    if (!ID_RE.test(String(body.bookingId || ""))) return json(res, 400, { error: "invalid_booking" });
    if (!["approve", "reject"].includes(body.decision)) return json(res, 400, { error: "invalid_decision" });
    const comment = String(body.comment ?? "").trim().slice(0, 500) || null;
    if (body.decision === "reject" && !comment) return json(res, 400, { error: "comment_required", message: "却下するときは、理由（コメント）を書いてください" });
    // その予約が、このお問い合わせから作られたものか（別のお問い合わせの予約を、ここから動かさない）
    const { data: rec } = await sb.from("rental_records").select("booking_group_id").eq("id", id).maybeSingle();
    const { data: bk } = await sb.from("space_bookings").select("id, group_id, status").eq("id", body.bookingId).maybeSingle();
    if (!rec || !bk || !rec.booking_group_id || bk.group_id !== rec.booking_group_id) return json(res, 404, { error: "booking_not_found" });
    if (bk.status !== "tentative") return json(res, 409, { error: "already_decided", message: "この予約は、すでに仮予約ではありません（開き直してください）" });
    r = await spaceCall(sb, "space_admin_decide_booking", { p_id: body.bookingId, p_action: body.decision, p_comment: comment });
  }
  if (!r.ok) return json(res, r.status, { error: r.error, message: r.message });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `marketing.${body.action.replace(".", "_")}`,
    target: `space_inquiry:${id}`, detail: body.action === "space.booking" ? { bookingId: body.bookingId, decision: body.decision } : {} });
  return json(res, 200, { ok: true, result: Array.isArray(r.data) ? r.data[0] || null : r.data || null });
}

// 8sp のメール：compose（下書きを1通作って見せる）→ 画面で宛先・送信元・本文を確認 → send-draft（その1通だけ送る）
export const SPACE_MAIL_FROM_NOTE = "8sp の送信設定（既定：Eight Space運営事務局 <notice@notify.8sp.jp>、返信先 rental@8sp.jp）";
async function spaceMailAction(req, res, ctx, user, body) {
  const [source, id] = String(body.key || "").split(":");
  if (source !== "space_inquiry" || !ID_RE.test(id || "")) return json(res, 400, { error: "invalid_key" });
  const token = String(req.headers?.authorization || req.headers?.Authorization || "").replace(/^Bearer\s+/i, "");
  const url = process.env.SPACE_MAIL_API_URL || "";
  let r;
  if (body.action === "space.mail.compose") {
    r = await spaceMail({ url, token, payload: { action: "compose", record_id: id, subject: body.subject ? String(body.subject).slice(0, 200) : null } });
    if (!r.ok) return json(res, r.status === 202 ? 502 : r.status, { error: r.error, message: r.message });
    const b = r.body || {};
    return json(res, 200, { ok: true, preview: { mailId: b.mail_id, to: b.to, subject: b.subject, body: b.body, kind: b.kind, status: b.status,
      from: process.env.SPACE_MAIL_FROM_LABEL || SPACE_MAIL_FROM_NOTE } });
  }
  if (!ID_RE.test(String(body.mailId || ""))) return json(res, 400, { error: "invalid_mail" });
  if (body.confirmed !== true) return json(res, 400, { error: "needs_confirmation", message: "宛先・送信元・本文を確認してから送ってください" });
  const subject = String(body.subject ?? "").trim();
  const text = String(body.body ?? "").trim();
  if (!subject || !text) return json(res, 400, { error: "invalid_body", message: "件名と本文を入れてください" });
  r = await spaceMail({ url, token, payload: { action: "send-draft", mail_id: body.mailId, subject, body: text } });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "marketing.space_mail_send", target: `space_inquiry:${id}`,
    detail: { mailId: body.mailId, result: r.ok ? (r.body?.sent ? "sent" : "not_sent") : r.error } });
  if (r.status === 202) return json(res, 202, { ok: false, outcome: "unknown", message: r.message });
  if (!r.ok) return json(res, r.status, { error: r.error, message: r.message });
  return json(res, 200, { ok: true, outcome: r.body?.sent ? "sent" : "not_sent", message: r.body?.message || null, to: r.body?.to || null });
}

// ---- 問い合わせの表（EC・会社HP）：状態とメモだけ。8ec の管理画面と同じ更新を、同じ権限で ------------
async function contactAction(req, res, ctx, user, body) {
  const [source, id] = String(body.key || "").split(":");
  if (!["ec_contact", "site_contact"].includes(source) || !ID_RE.test(id || "")) return json(res, 400, { error: "invalid_key" });
  const sb = userClient(req);
  const cur = await contactOne(sb, id);
  if (cur.status !== 200) return json(res, cur.status, { error: cur.error });
  if (contactBiz(cur.row.source) !== (source === "site_contact" ? "site" : "ec")) return json(res, 404, { error: "not_found" });
  const r = await contactUpdate(sb, id, { status: body.status ?? null, staffMemo: body.staffMemo ?? null, expectUpdatedAt: body.expectUpdatedAt || null });
  if (r.status !== 200) return json(res, r.status, { error: r.error, message: r.message });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "marketing.contact_update", target: `${source}:${id}`,
    detail: { from: cur.row.status || "未対応", to: r.row.status, memo: body.staffMemo != null } });
  return json(res, 200, { ok: true, row: r.row });
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

