import { readHotMarks, hotFields } from '../../../lib/sales-proposal-hot.js';
// /sales 提案管理（db/138_sales_proposals.sql・db/140_sales_proposal_matching.sql・docs/sales-proposals.md）
//
// GET  /api/sales/proposals?filter=open|today|overdue|proposal_wait|no_call|mail_wait|reply_wait|meeting|reproposal|unassigned|unlinked|closed|all
//                          &proposalOwner=me|none|all|<ID>&closingOwner=me|none|all|<社員ID>
//                          &owner=me|none|all|<社員ID>（旧・現在担当）&service=…&q=…&sort=due|elapsed|sent&days=30
//        … 一覧（提案単位）。絞り込みの件数・今日の件数・KPI（担当別）・管理側には担当未割当・連携エラーの件数
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
  countFilters, computeKpis, firstTasks, settingsOf, isUuid, readWhen, todayEndIso,
} from "../../../lib/sales-proposals.js";
import { SQL_FILE, loadPeople, salesMembers, loadSettingsRow, insertTasks, inChunks } from "../../../lib/sales-proposals-db.js";
import { periodStartJst } from "../../../lib/sales.js";
import { validOwnerFilter, matchesOwnerFilter, proposalOwnerFilters } from "../../../lib/sales-proposal-owner-filters.js";
import { normalizeEmail } from "../../../lib/hr-leads.js";
import { companyQualifications } from "../../../lib/sales-company-qualification.js";

import { readSourceStates, sourceStateFor, shapeSourceState } from "../../../lib/sales-proposal-source-state.js";

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
  if (error.sourceState) return json(res, 503, { error: "source_state_unavailable", message: "ENGER連携状態を確認できません。db/149の適用状態・読取権限を管理者が確認してください。未削除とは扱いません。" });
  const hint = dbSetupHint(error, SQL_FILE);
  if (hint) return json(res, 503, { error: "not_ready", message: hint });
  if (error.code === "23514" || error.code === "23503") return json(res, 409, { error: "conflict", detail: error.message });
  return json(res, error.code === "42501" ? 403 : 500, { error: "db_failed", detail: error.message });
}

async function list(req, res, sb, ctx) {
  const sp = new URL(req.url, "http://localhost").searchParams;
  const manager = canManageProposals(ctx);
  const me = ctx.employee?.id || null;
  const filter = FILTER_KEYS.includes(sp.get("filter")) ? sp.get("filter") : "all";
  const sort = SORTS[sp.get("sort")] ? sp.get("sort") : "due";
  const ownerQ = sp.get("owner") || "all";
  const proposalOwner = sp.get("proposalOwner") || "";
  const closingOwner = sp.get("closingOwner") || "";
  for (const [field, value] of [["owner", ownerQ], ["proposalOwner", proposalOwner], ["closingOwner", closingOwner]]) {
    if (!validOwnerFilter(value, { source: field === "proposalOwner" })) {
      return json(res, 400, { error: "invalid_filter", field, hint: "担当の絞り込みが不正です。担当条件を解除してください。" });
    }
  }
  const service = sp.get("service") || null;
  const q = String(sp.get("q") || "").trim().toLowerCase().slice(0, 100);
  const days = Math.min(365, Math.max(7, Number(sp.get("days")) || 30));
  const now = new Date().toISOString();

  let query = sb.from("gw_sales_proposals").select(PROPOSAL_FIELDS).eq("tenant_id", ctx.tenantId);
  // 同じテナントのSales利用者は全提案を閲覧可。編集権は提案の現在担当本人だけ。
  const { data: rows, error } = await query.order("sent_at", { ascending: false }).limit(LIMIT + 1);
  if (error) return fail(res, error);
  const truncated = (rows || []).length > LIMIT;
  const loaded = truncated ? rows.slice(0, LIMIT) : rows || [];
  const source = await readSourceStates(sb, ctx.tenantId, loaded);
  if (source.error) return fail(res, source.error);
  const proposals = loaded.filter(p => sourceStateFor(p, source.states)?.deleted !== true);
  const ids = proposals.map((p) => p.id);
  const hot = await readHotMarks(sb, ctx.tenantId, ids);

  const [acts, tks, people, settingsRow, collaborators] = await Promise.all([
    inChunks(ids, (chunk) => sb.from("gw_sales_proposal_activities")
      .select("id, proposal_id, kind, result, outcome, evidence, occurred_at, employee_id").in("proposal_id", chunk).limit(1000)),
    inChunks(ids, (chunk) => sb.from("gw_sales_proposal_tasks").select(TASK_FIELDS).in("proposal_id", chunk).limit(1000)),
    loadPeople(ctx.tenantId),
    loadSettingsRow(sb, ctx.tenantId),
    inChunks(ids, (chunk) => sb.from("gw_sales_proposal_supporters")
      .select("proposal_id, stage, employee_id").in("proposal_id", chunk).limit(1000)),
  ]);
  if (acts.error) return fail(res, acts.error);
  if (tks.error) return fail(res, tks.error);
  if (collaborators.error) return fail(res, collaborators.error);
  const extra = new Map();
  for (const c of collaborators.data || []) {
    if (!extra.has(c.proposal_id)) extra.set(c.proposal_id, { proposal: [], cs: [], closing: [] });
    const item = extra.get(c.proposal_id);
    if (item[c.stage]) item[c.stage].push({ id: c.employee_id });
  }

  const qualification = companyQualifications(proposals, acts.data || []);
  const shaped = proposals.map((p) => ({ companyQualification: qualification.byProposal.get(p.id) || null, ...hotFields(hot, p.id), ...shapeSourceState(sourceStateFor(p, source.states), { expected: p.source_system === "enger" }), ...shapeProposal(p, { activities: acts.data, tasks: tks.data, nameOf: people.nameOf, now }),
    supporters: Object.fromEntries(Object.entries(extra.get(p.id) || { proposal: [], cs: [], closing: [] })
      .map(([stage, a]) => [stage, a.map((m) => ({ id: m.id, name: people.nameOf(m.id) || "退職・不明" }))])),
    canEdit: Boolean(!p.archived_at && (manager || (me && p.sales_owner_id === me))),
    canRestore: Boolean(p.archived_at && (manager || (me && p.sales_owner_id === me))),
  }));
  const members = await salesMembers(ctx.tenantId, people.employees);
  const owners = proposalOwnerFilters(proposals, people.employees, members);
  // 全件閲覧。フィルタ「自分／担当者／未割当」は表示だけに影響する。
  const scoped = shaped.filter((r) => matchesOwnerFilter(ownerQ, r.salesOwnerId, me)
    && matchesOwnerFilter(proposalOwner, owners.byProposal.get(r.id)?.proposal, me)
    && matchesOwnerFilter(closingOwner, owners.byProposal.get(r.id)?.closing, me)
    && (!q || `${r.companyName} ${r.title} ${r.matchingOwnerName || ""} ${r.csOwnerName || ""} ${r.closingOwnerName || ""} ${Object.values(r.supporters || {}).flat().map((s) => s.name).join(" ")} ${r.sourceCode || ""}`.toLowerCase().includes(q)));
  const counts = countFilters(scoped.filter((r) => !service || r.service === service), { now, manager });
  const visible = filterRows(scoped, { filter, service, now }).sort(SORTS[sort]);

  // 今日やること（自分の分。管理側は全体）
  const todayEnd = todayEndIso(now);
  const openTasks = (tks.data || []).filter((t) => t.status === "open" && !proposals.find((p) => p.id === t.proposal_id)?.archived_at && t.assignee_id === me);
  const today = { prepare: 0, call: 0, mail: 0, reply_check: 0, meeting: 0, other: 0, overdue: 0 };
  for (const t of openTasks) {
    if (t.due_at < now) today.overdue++;
    if (t.due_at > todayEnd) continue;
    if (t.kind === "prepare") today.prepare++;
    else if (t.kind === "call" || t.kind === "refollow") today.call++;
    else if (t.kind === "mail") today.mail++;
    else if (t.kind === "reply_check") today.reply_check++;
    else if (t.kind === "meeting_fix" || t.kind === "meeting_result") today.meeting++;
    else today.other++;
  }

  // 期限超過カードと絞り込みは同じ「提案件数」を使う（複数タスクでも1件）。
  today.overdue = counts.overdue;

  // KPI（期間内に企業へ送った提案。提案待ち（まだ送っていない）は入れない。担当で絞ったときはその担当だけ）
  const { iso: since } = periodStartJst(days, new Date(now));
  const scopedIds = new Set(scoped.map((r) => r.id));
  const inPeriod = proposals.filter((p) => !p.archived_at && scopedIds.has(p.id) && p.sent_at >= since);
  const kpi = computeKpis(inPeriod, acts.data || [], tks.data || [], { now });
  kpi.byOwner = kpi.byOwner.map((r) => ({ ...r, ownerName: people.nameOf(r.ownerId) || (r.ownerId ? "（退職・不明）" : "担当未割当") }));
  kpi.days = days;

  let syncIssues = null;
  if (manager) {
    const { count } = await sb.from("gw_sales_proposal_sync_log").select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId).neq("status", "ok").is("resolved_at", null);
    syncIssues = count ?? null;
  }
  const services = [...new Set(shaped.map((r) => r.service).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));

  return json(res, 200, {
    proposals: visible, counts, today, kpi: manager ? kpi : { ...kpi, byOwner: [] }, manager, me,
    members, ownerFilters: owners.options, services, syncIssues, truncated,
    companyQualifications: qualification.companies,
    notice: [truncated ? "提案数が表示上限の2,000件を超えています。現在表示しているのは最新2,000件です。" : null,
      !source.available ? "ENGERの削除・企業回答の同期は未設定です。連携状態は未確認です。" : source.missingIds?.length ? `ENGER ${source.missingIds.length}件は同期状態が未確認です。削除・回答の有無は未確定です。` : null].filter(Boolean).join(" ") || null,
    settings: settingsOf(settingsRow), labels: LABELS,
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
  // 自分以外を直接担当にした新規登録を禁止（役割の偽装防止）。
  if (!me || owner !== me) return json(res, 403, { error: "forbidden", hint: "新しい提案はログイン中の本人担当で登録してください" });
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
    contact_phone: str(body.contactPhone, 40), sales_owner_id: owner,
    matching_owner_name: ctx.employee?.display_name || null, matching_owner_email: ctx.employee?.email || null,
    sent_at: sentAt || new Date().toISOString(),
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
