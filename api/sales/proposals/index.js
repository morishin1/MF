// /sales 提案管理（db/138_sales_proposals.sql・db/140_sales_proposal_matching.sql・docs/sales-proposals.md）
//
// GET  /api/sales/proposals?filter=open|today|overdue|proposal_wait|no_call|mail_wait|reply_wait|meeting|reproposal|unassigned|unlinked|closed|all
//                          &owner=me|all|<社員ID>&service=…&q=…&sort=due|elapsed|sent&days=30
//        … 一覧（提案単位）。絞り込みの件数・今日の件数（filter=task_* で同じ提案に絞れる）・KPI（担当別）・管理側には担当未割当・連携エラーの件数
// POST /api/sales/proposals { companyName, title, service?, salesOwnerId?, sentAt?, contactName?, contactEmail?, contactPhone?, companyId? }
//        … /sales で提案を手で足す（システム開発・PC・レンタルなど dx.enger 以外。dx.enger の提案は自動で入る）
//
// ■ 見える範囲（DB の RLS と同じ。ここでも絞る＝二重に守る）
//   管理側（管理者・経営者・マネージャー）… テナントの提案すべて
//   営業担当 … 自分が担当の提案だけ（owner=all を付けても広がらない）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import {
  PROPOSAL_FIELDS, TASK_FIELDS, FILTER_KEYS, SORTS, STATUS_LABEL, LABELS, canManageProposals, shapeProposal, filterRows,
  countFilters, computeKpis, firstTasks, settingsOf, isUuid, readWhen,
} from "../../../lib/sales-proposals.js";
import { SQL_FILE, loadPeople, salesMembers, loadSettingsRow, insertTasks, inChunks } from "../../../lib/sales-proposals-db.js";
import { periodStartJst } from "../../../lib/sales.js";
import { normalizeEmail } from "../../../lib/hr-leads.js";

const LIMIT = 2000;

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

function fail(res, error) {
  const hint = dbSetupHint(error, SQL_FILE);
  if (hint) return json(res, 503, { error: "not_ready", message: hint });
  if (error.code === "23514" || error.code === "23503") return json(res, 409, { error: "conflict", detail: error.message });
  return json(res, error.code === "42501" ? 403 : 500, { error: "db_failed", detail: error.message });
}

async function list(req, res, sb, ctx) {
  const sp = new URL(req.url, "http://localhost").searchParams;
  const manager = canManageProposals(ctx);
  const me = ctx.employee?.id || null;
  const filter = FILTER_KEYS.includes(sp.get("filter")) ? sp.get("filter") : "open";
  const sort = SORTS[sp.get("sort")] ? sp.get("sort") : "due";
  const ownerQ = sp.get("owner") || (manager ? "all" : "me");
  const service = sp.get("service") || null;
  const q = String(sp.get("q") || "").trim().toLowerCase().slice(0, 100);
  const days = Math.min(365, Math.max(7, Number(sp.get("days")) || 30));
  const now = new Date().toISOString();

  let query = sb.from("gw_sales_proposals").select(PROPOSAL_FIELDS).eq("tenant_id", ctx.tenantId);
  // 営業担当は自分の担当だけ（URL の値で範囲を広げない）
  if (!manager) {
    if (!me) return json(res, 200, { proposals: [], counts: {}, kpi: null, manager, labels: LABELS, notice: "社員名簿に登録が無いため、担当の提案を表示できません" });
    query = query.eq("sales_owner_id", me);
  }
  const { data: rows, error } = await query.order("sent_at", { ascending: false }).limit(LIMIT + 1);
  if (error) return fail(res, error);
  const truncated = (rows || []).length > LIMIT;
  const proposals = truncated ? rows.slice(0, LIMIT) : rows || [];
  const ids = proposals.map((p) => p.id);

  const [acts, tks, people, settingsRow] = await Promise.all([
    inChunks(ids, (chunk) => sb.from("gw_sales_proposal_activities")
      .select("id, proposal_id, kind, result, outcome, evidence, occurred_at, employee_id").in("proposal_id", chunk).limit(1000)),
    inChunks(ids, (chunk) => sb.from("gw_sales_proposal_tasks").select(TASK_FIELDS).in("proposal_id", chunk).limit(1000)),
    loadPeople(ctx.tenantId),
    loadSettingsRow(sb, ctx.tenantId),
  ]);
  if (acts.error) return fail(res, acts.error);
  if (tks.error) return fail(res, tks.error);

  const shaped = proposals.map((p) => shapeProposal(p, { activities: acts.data, tasks: tks.data, nameOf: people.nameOf, now }));
  // 担当で絞る（管理側だけ。営業担当はもう自分の分しか無い）
  const ownerId = manager ? (ownerQ === "me" ? me : ownerQ === "all" ? null : isUuid(ownerQ) ? ownerQ : null) : null;
  const scoped = shaped.filter((r) => (ownerQ === "none" && manager ? !r.salesOwnerId : !ownerId || r.salesOwnerId === ownerId)
    && (!q || `${r.companyName} ${r.title} ${r.sourceCode || ""}`.toLowerCase().includes(q)));
  // 件数は、一覧と同じ範囲（担当・検索語・サービス）で数える（チップ・集計カードの数と、押したあとの一覧が一致する）
  const counts = countFilters(scoped.filter((r) => !service || r.service === service), { now, manager });
  const visible = filterRows(scoped, { filter, service, now }).sort(SORTS[sort]);

  // 今日やること（上の集計カード）。一覧と同じ範囲（担当・検索語）の提案を、提案単位で数える。
  // カードを押したときの絞り込み（FILTERS の task_*）と同じ判定なので、件数と一覧が一致する
  const today = {
    prepare: counts.task_prepare, call: counts.task_call, mail: counts.task_mail,
    reply_check: counts.task_reply_check, meeting: counts.task_meeting, overdue: counts.overdue,
  };

  // KPI（期間内に企業へ送った提案。提案待ち（まだ送っていない）は入れない。担当で絞ったときはその担当だけ）
  const { iso: since } = periodStartJst(days, new Date(now));
  const scopedIds = new Set(scoped.map((r) => r.id));
  const inPeriod = proposals.filter((p) => scopedIds.has(p.id) && p.sent_at >= since);
  const kpi = computeKpis(inPeriod, acts.data || [], tks.data || [], { now });
  kpi.byOwner = kpi.byOwner.map((r) => ({ ...r, ownerName: people.nameOf(r.ownerId) || (r.ownerId ? "（退職・不明）" : "担当未割当") }));
  kpi.days = days;

  let syncIssues = null;
  let members = [];
  if (manager) {
    const { count } = await sb.from("gw_sales_proposal_sync_log").select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId).neq("status", "ok").is("resolved_at", null);
    syncIssues = count ?? null;
    members = await salesMembers(ctx.tenantId, people.employees);
  }
  const services = [...new Set(shaped.map((r) => r.service).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));

  return json(res, 200, {
    proposals: visible, counts, today, kpi: manager ? kpi : { ...kpi, byOwner: [] }, manager, me,
    members, services, syncIssues, truncated, settings: settingsOf(settingsRow), labels: LABELS,
  });
}

async function create(req, res, sb, ctx, user) {
  const body = await readJson(req);
  const manager = canManageProposals(ctx);
  const me = ctx.employee?.id || null;
  const str = (v, max) => { const t = String(v ?? "").trim(); return t ? t.slice(0, max) : null; };
  const companyName = str(body.companyName, 200);
  const title = str(body.title, 200);
  if (!companyName || !title) return json(res, 400, { error: "invalid_body", required: ["companyName", "title"], hint: "企業名と提案の内容を入れてください" });
  const owner = body.salesOwnerId === undefined || body.salesOwnerId === "" ? me : body.salesOwnerId;
  if (owner !== null && !isUuid(owner)) return json(res, 400, { error: "invalid_body", field: "salesOwnerId" });
  // 営業担当は自分が担当の提案だけ足せる（他人に割り当てるのは管理側）
  if (!manager && owner !== me) return json(res, 403, { error: "forbidden", hint: "ほかの人を担当にした提案は、管理者が登録します" });
  const sentAt = readWhen(body.sentAt);
  if (sentAt === undefined) return json(res, 400, { error: "invalid_body", field: "sentAt" });
  if (body.companyId && !isUuid(body.companyId)) return json(res, 400, { error: "invalid_body", field: "companyId" });
  if (body.companyId) {
    const { data: c } = await sb.from("gw_sales_companies").select("id").eq("id", body.companyId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!c) return json(res, 404, { error: "company_not_found" });
  }
  const email = body.contactEmail ? normalizeEmail(body.contactEmail) : null;
  if (body.contactEmail && !email) return json(res, 400, { error: "invalid_body", field: "contactEmail", hint: "メールアドレスの形を確かめてください" });

  const row = {
    tenant_id: ctx.tenantId, source_system: "manual", company_id: body.companyId || null, company_name: companyName,
    service: str(body.service, 100), title, contact_name: str(body.contactName, 100), contact_email: email,
    contact_phone: str(body.contactPhone, 40), sales_owner_id: owner, sent_at: sentAt || new Date().toISOString(),
    status: "call_wait", created_by: user.id, updated_by: user.id,
  };
  const { data: made, error } = await sb.from("gw_sales_proposals").insert(row).select(PROPOSAL_FIELDS).single();
  if (error) return fail(res, error);
  const { error: e2 } = await sb.from("gw_sales_proposal_activities").insert({
    tenant_id: ctx.tenantId, proposal_id: made.id, company_id: made.company_id, kind: "sent", result: "sent",
    occurred_at: made.sent_at, employee_id: me, created_by: user.id, note: "/sales で提案を登録",
  });
  if (e2) return fail(res, e2);
  try {
    await insertTasks(sb, ctx.tenantId, made.id, firstTasks(made, settingsOf(await loadSettingsRow(sb, ctx.tenantId))), user.id);
  } catch (e) {
    return fail(res, e);
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.proposal_create", target: `sales_proposal:${made.id}`,
    detail: { source: "manual", service: made.service, ownerId: made.sales_owner_id } });
  return json(res, 200, { proposal: { id: made.id, status: made.status, statusLabel: STATUS_LABEL[made.status] } });
}
