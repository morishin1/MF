// /sales 提案管理：1件（db/138_sales_proposals.sql・docs/sales-proposals.md）
//
// GET  /api/sales/proposals/detail?id=…   … 提案・行動の記録（時系列）・タスク（完了・取り消しも）・紐付いた企業
// POST /api/sales/proposals/detail { id, action, … }
//   記録（どれも「誰が・いつ」を残す。タスクは記録で片付く）
//     sent     { occurredAt?, channel?, note? }                … 企業へ提案した（提案待ちのときだけ。dx.enger 以外で送ったとき）
//                                                                 → 電話待ちへ進み、送った時刻から30分以内の電話のタスク（提案準備は完了）
//     call     { result, outcome?, occurredAt?, nextAt?, note? } … 電話。結果は必須（チェックだけで完了にしない）
//     mail     { occurredAt?, note? }                          … 確認メールを送った（いまは自己申告）
//     reply    { outcome, channel?, occurredAt?, note? }       … 企業から返信・回答
//     check    { note? }                                       … 回答確認：返信なし（3営業日→再フォロー、5営業日→管理者確認）
//     meeting  { result: scheduled|done|canceled, nextAt?, note? }
//     result   { status, reason?, note? }                      … 成約・見送り・連絡停止・クローズ・継続検討・再提案依頼
//     memo     { note }
//   管理側だけ
//     decision { result: continue|hold|close, nextAt?, note? } … 管理者確認（継続・保留・クローズ）
//     assign   { ownerId }                                     … 営業担当の割り当て・変更（開いているタスクも付け替える）
//   タスク
//     task_add    { title, dueAt, assigneeId? }
//     task_due    { taskId, dueAt, reason }                    … 期限の変更（理由が必須・記録に残す）
//     task_done   { taskId, note }                             … 手動タスクの完了（何をしたかが必須）
//     task_cancel { taskId, reason }                           … 取り消し（自動のタスクは管理側だけ）
//   そのほか
//     contact  { contactName?, contactEmail?, contactPhone? }   … 先方の窓口
//     link     { companyId | null } / { create: true }         … /sales の企業に紐付ける・外す・企業として登録（監査ログ）
//
// ■ 終わった提案（成約・見送り・連絡停止・クローズ）には、メモと管理側の判断（継続＝再開）しか足せない
// ■ 提案待ち（マッチング確定・まだ企業へ提案していない）には、電話・メール・返信・回答確認・面談・管理者の判断を記録しない
//   （30分の電話の期限は、企業へ提案を送ってから始める）。先に「企業へ提案した」を記録する

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import {
  PROPOSAL_FIELDS, ACTIVITY_FIELDS, TASK_FIELDS, LABELS, STATUS_LABEL, isClosed, canManageProposals, normalizeActivity,
  normalizeTaskInput, shapeProposal, shapeTask, shapeActivity, settingsOf, isUuid, readWhen, activityLabel,
} from "../../../lib/sales-proposals.js";
import {
  SQL_FILE, loadPeople, salesMembers, loadSettingsRow, loadProposal, loadTasks, recordAndPlan, insertTasks,
} from "../../../lib/sales-proposals-db.js";
import { normalizeEmail } from "../../../lib/hr-leads.js";
import { notifySentShared } from "../../../lib/sales-proposal-handoff-slack.js";
import { STATUS_LABEL as COMPANY_STATUS_LABEL } from "../../../lib/sales.js";

const RECORDS = ["sent", "call", "mail", "reply", "check", "meeting", "result", "memo", "decision"];
// 企業へ提案を送るまでは記録しないもの（提案待ちのとき）
const AFTER_SENT = ["call", "mail", "reply", "check", "meeting", "decision"];

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  if (req.method === "GET") return one(req, res, sb, ctx);
  if (req.method === "POST") return act(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

function fail(res, error) {
  const hint = dbSetupHint(error, SQL_FILE);
  if (hint) return json(res, 503, { error: "not_ready", message: hint });
  if (error.code === "23514" || error.code === "23503") return json(res, 409, { error: "conflict", detail: error.message });
  return json(res, error.code === "42501" ? 403 : 500, { error: "db_failed", detail: error.message });
}

/** 見てよい提案か（DB の RLS と同じ。営業担当は自分の担当だけ）。見えないものは「無い」と答える */
async function visibleProposal(sb, ctx, id) {
  const { proposal, error } = await loadProposal(sb, ctx.tenantId, id);
  if (error) return { error };
  if (!proposal) return { proposal: null };
  return { proposal };
}

async function detailOf(sb, ctx, proposal) {
  const now = new Date().toISOString();
  const [{ data: activities, error: e1 }, { tasks, error: e2 }, people, settingsRow, { data: handoffs, error: e3 }, { data: supporters, error: e4 }] = await Promise.all([
    sb.from("gw_sales_proposal_activities").select(ACTIVITY_FIELDS).eq("proposal_id", proposal.id).order("occurred_at", { ascending: true }).limit(1000),
    loadTasks(sb, proposal.id),
    loadPeople(ctx.tenantId),
    loadSettingsRow(sb, ctx.tenantId),
    sb.from("gw_sales_proposal_handoffs").select("*").eq("tenant_id", ctx.tenantId)
      .eq("proposal_id", proposal.id).order("created_at", { ascending: false }).limit(100),
    sb.from("gw_sales_proposal_supporters").select("id,stage,employee_id,created_at")
      .eq("proposal_id", proposal.id).eq("tenant_id", ctx.tenantId).limit(100),
  ]);
  if (e1 || e2 || e3 || e4) return { error: e1 || e2 || e3 || e4 };
  let company = null;
  if (proposal.company_id) {
    const { data: c } = await sb.from("gw_sales_companies").select("id, name, status, phone, site_url, owner_id, ng_reason")
      .eq("id", proposal.company_id).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (c) company = { id: c.id, name: c.name, status: c.status, statusLabel: COMPANY_STATUS_LABEL[c.status] || c.status,
      phone: c.phone || null, siteUrl: c.site_url || null, ownerName: people.nameOf(c.owner_id), ng: Boolean(c.ng_reason) };
  }
  const manager = canManageProposals(ctx);
  const settings = settingsOf(settingsRow);
  const allSales = await salesMembers(ctx.tenantId, people.employees);
  const targets = (ids) => allSales.filter((m) => ids.includes(m.id));
  const connected = (activities || []).some((a) => (a.kind === "call" && a.result === "connected") || a.kind === "reply");
  const latestDecision = (activities || []).filter((a) => a.kind === "cs_decision").at(-1)?.result || null;
  const supportersByStage = Object.fromEntries(["proposal", "cs", "closing"].map((stage) => [stage,
    (supporters || []).filter((p) => p.stage === stage)
      .map((p) => ({ id: p.employee_id, name: people.nameOf(p.employee_id) || "退職・不明", addedAt: p.created_at }))]));
  return {
    supporters: supportersByStage,
    handoffs: (handoffs || []).map((h) => ({
      id: h.id, fromStage: h.from_stage, toStage: h.to_stage,
      fromName: people.nameOf(h.from_owner_id) || "未割当",
      toName: people.nameOf(h.to_owner_id) || "未割当",
      actorName: people.nameOf(h.actor_employee_id) || "管理者",
      reason: h.reason, decision: h.decision, nextAction: h.next_action, nextAt: h.next_at,
      at: h.created_at, slackSent: Boolean(h.slack_sent_at),
    })),
    handoffTargets: { cs: targets(settings.csMembers), closing: targets(settings.closingMembers) },
    canEdit: Boolean(ctx.employee?.id && proposal.sales_owner_id === ctx.employee.id && !proposal.archived_at),
    canAssign: Boolean(manager && !proposal.sales_owner_id && !proposal.archived_at),
    canHandoff: Boolean(ctx.employee?.id && proposal.sales_owner_id === ctx.employee.id && !proposal.archived_at),
    csContacted: connected, csDecision: latestDecision,
    proposal: shapeProposal(proposal, { activities: activities || [], tasks, nameOf: people.nameOf, now }),
    activities: (activities || []).map((a) => shapeActivity(a, { nameOf: people.nameOf })).reverse(),
    tasks: tasks.map((t) => shapeTask(t, { nameOf: people.nameOf, now })),
    company, manager, me: ctx.employee?.id || null,
    members: ctx.employee?.id && proposal.sales_owner_id === ctx.employee.id ? allSales : [],
    settings, labels: LABELS,
  };
}

async function one(req, res, sb, ctx) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!isUuid(id)) return json(res, 400, { error: "invalid_query", required: ["id"] });
  const { proposal, error } = await visibleProposal(sb, ctx, id);
  if (error) return fail(res, error);
  if (!proposal) return json(res, 404, { error: "not_found" });
  const out = await detailOf(sb, ctx, proposal);
  if (out.error) return fail(res, out.error);
  return json(res, 200, out);
}

const audit = (ctx, user, action, proposal, detail) => gwLog({
  tenantId: ctx.tenantId, actorId: user.id, action: `sales.proposal_${action}`, target: `sales_proposal:${proposal.id}`, detail,
});

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id", "action"] });
  const { proposal, error } = await visibleProposal(sb, ctx, body.id);
  if (error) return fail(res, error);
  if (!proposal) return json(res, 404, { error: "not_found" });
  const manager = canManageProposals(ctx);
  const action = String(body.action || "");
  const me = ctx.employee?.id || null;
  const canEdit = Boolean(me && proposal.sales_owner_id === me && !proposal.archived_at);
  const canAssign = Boolean(manager && !proposal.sales_owner_id && !proposal.archived_at && action === "assign");
  if (!canEdit && !canAssign) return json(res, 403, { error: "readonly",
    hint: "他の担当者の提案は閲覧専用です。操作するには現在の担当者から正式に引き継いでもらってください" });
  const now = new Date().toISOString();

  try {
    if (RECORDS.includes(action)) {
      if (action === "decision" && !manager) return json(res, 403, { error: "forbidden", hint: "継続・保留・クローズの判断は管理者が行います" });
      if (isClosed(proposal.status) && !["memo", "decision"].includes(action)) {
        return json(res, 409, { error: "closed", hint: `この提案は「${STATUS_LABEL[proposal.status]}」で終わっています。再開は管理者の判断（継続）で行います` });
      }
      if (action === "sent" && proposal.status !== "proposal_wait") {
        return json(res, 409, { error: "already_sent", hint: "この提案は、もう企業へ提案した記録があります" });
      }
      if (proposal.status === "proposal_wait" && AFTER_SENT.includes(action)) {
        return json(res, 409, { error: "not_sent", hint: "まだ企業へ提案していません。先に「企業へ提案した」を記録してください（dx.enger から提案メールを送ると自動で記録されます）" });
      }
      if (["call", "mail", "sent"].includes(action) && !ctx.employee?.id) {
        return json(res, 400, { error: "no_employee", hint: "社員名簿に登録が無いと、実施者を記録できません" });
      }
      const n = normalizeActivity(action, body, { now });
      if (n.error) return json(res, 400, n);
      const settingsRow = await loadSettingsRow(sb, ctx.tenantId);
      const people = await loadPeople(ctx.tenantId);
      const out = await recordAndPlan(sb, { ctx, user, proposal, input: n.value, settingsRow, managerOf: people.managerOf, now });
      if (["result", "decision"].includes(action) || out.plan.patch.status) {
        await audit(ctx, user, action, proposal, {
          kind: n.value.kind, result: n.value.result || null, reason: n.value.outcome || null,
          from: proposal.status, to: out.proposal.status, createdTasks: out.created.length,
        });
      }
      if (action === "sent") {
        // dx.engerを使わず提案した場合もCS/クロージングに共有。Slack失敗は提案記録を巻き戻さない。
        const shared = await notifySentShared(admin(), { proposalId: proposal.id, settingsRow: settingsRow || null,
          employees: people.employees || [] });
        if (shared.error) console.error("[sales/proposals/detail] sent share:", shared.error);
      }
      const detail = await detailOf(sb, ctx, out.proposal);
      if (detail.error) return fail(res, detail.error);
      return json(res, 200, { ...detail, recorded: { label: activityLabel(out.activity), createdTasks: out.created.map((t) => t.title) } });
    }

    if (action === "assign") {
      if (!manager) return json(res, 403, { error: "forbidden", hint: "営業担当の割り当ては管理者が行います" });
      if (proposal.sales_owner_id) return json(res, 409, { error: "owner_change_requires_handoff",
        hint: "担当者がいる提案は「CSに引継ぐ」「クロージングに引継ぐ」を使ってください。直接変更できません" });
      const to = body.ownerId || null;
      if (to !== null && !isUuid(to)) return json(res, 400, { error: "invalid_body", field: "ownerId" });
      if (to === proposal.sales_owner_id) return json(res, 400, { error: "nothing_to_update" });
      const people = await loadPeople(ctx.tenantId);
      if (to) {
        const members = await salesMembers(ctx.tenantId, people.employees);
        if (!members.some((m) => m.id === to)) return json(res, 400, { error: "bad_owner", hint: "Sales を使える在籍中の社員から選んでください" });
      }
      // 担当未割当の場合だけ管理者が初回割当する。RLSを迂回するためAPIで厳格にtenant/roleを検証。
      const { data: after, error: e1 } = await admin().from("gw_sales_proposals").update({ sales_owner_id: to, updated_by: user.id })
        .eq("id", proposal.id).eq("tenant_id", ctx.tenantId).select(PROPOSAL_FIELDS).single();
      if (e1) return fail(res, e1);
      // 前の担当（または未定）のままの開いているタスクを、新しい担当へ寄せる。記録（誰がやったか）は書き換えない
      const { tasks } = await loadTasks(admin(), proposal.id);
      const move = tasks.filter((t) => t.status === "open" && t.kind !== "manager_review"
        && (t.assignee_id === proposal.sales_owner_id || !t.assignee_id)).map((t) => t.id);
      if (move.length) {
        const { error: e2 } = await admin().from("gw_sales_proposal_tasks").update({ assignee_id: to }).in("id", move).eq("status", "open");
        if (e2) return fail(res, e2);
      }
      await admin().from("gw_sales_proposal_activities").insert({
        tenant_id: ctx.tenantId, proposal_id: proposal.id, company_id: proposal.company_id, kind: "assign", occurred_at: now,
        employee_id: ctx.employee?.id || null, created_by: user.id,
        note: `営業担当：${people.nameOf(proposal.sales_owner_id) || "未定"} → ${people.nameOf(to) || "未定"}`,
        detail: { from: proposal.sales_owner_id || null, to, movedTasks: move.length },
      });
      if (to && to !== ctx.employee?.id) {
        await notify([{ tenantId: ctx.tenantId, employeeId: to, kind: "sales",
          title: `提案の担当になりました：${proposal.company_name}`, body: `「${proposal.title}」\n提案管理で次の行動を確認してください。`,
          link: `/sales/proposals.html?id=${proposal.id}`, dedupeKey: `sales_proposal_assign:${proposal.id}` }]);
      }
      await audit(ctx, user, "assign", proposal, { from: proposal.sales_owner_id || null, to, movedTasks: move.length });
      return done(res, sb, ctx, after);
    }

    if (action === "task_add") {
      if (isClosed(proposal.status)) return json(res, 409, { error: "closed", hint: "終わった提案にはタスクを足せません" });
      const n = normalizeTaskInput(body);
      if (n.error) return json(res, 400, n);
      if (!manager && n.value.assignee_id && n.value.assignee_id !== ctx.employee?.id) {
        return json(res, 403, { error: "forbidden", hint: "ほかの人のタスクは管理者が足します" });
      }
      const value = { ...n.value, assignee_id: n.value.assignee_id || proposal.sales_owner_id || null };
      await insertTasks(sb, ctx.tenantId, proposal.id, [value], user.id);
      await sb.from("gw_sales_proposal_activities").insert({
        tenant_id: ctx.tenantId, proposal_id: proposal.id, kind: "task", occurred_at: now, employee_id: ctx.employee?.id || null,
        created_by: user.id, note: `タスクを追加：${value.title}`, detail: { op: "add", dueAt: value.due_at },
      });
      return done(res, sb, ctx, proposal);
    }

    if (["task_due", "task_done", "task_cancel"].includes(action)) {
      if (!isUuid(body.taskId)) return json(res, 400, { error: "invalid_body", field: "taskId" });
      const { tasks } = await loadTasks(sb, proposal.id);
      const t = tasks.find((x) => x.id === body.taskId);
      if (!t) return json(res, 404, { error: "task_not_found" });
      if (t.status !== "open") return json(res, 409, { error: "task_closed", hint: "完了・取り消し済みのタスクは変えられません（履歴として残します）" });
      const reason = String(body.reason ?? body.note ?? "").trim().slice(0, 300);

      if (action === "task_due") {
        const due = readWhen(body.dueAt);
        if (!due) return json(res, 400, { error: "invalid_body", field: "dueAt", hint: "新しい期限を入れてください" });
        if (!reason) return json(res, 400, { error: "invalid_body", field: "reason", hint: "期限を変える理由を入れてください" });
        const { error: e1 } = await sb.from("gw_sales_proposal_tasks").update({ due_at: due }).eq("id", t.id).eq("status", "open");
        if (e1) return fail(res, e1);
        await sb.from("gw_sales_proposal_activities").insert({
          tenant_id: ctx.tenantId, proposal_id: proposal.id, kind: "due_change", occurred_at: now, employee_id: ctx.employee?.id || null,
          created_by: user.id, note: reason, detail: { taskId: t.id, title: t.title, from: t.due_at, to: due },
        });
        await audit(ctx, user, "task_due", proposal, { taskId: t.id, kind: t.kind, from: t.due_at, to: due });
        return done(res, sb, ctx, proposal);
      }

      if (action === "task_done") {
        // 自動タスク（電話・メール・回答確認…）は、記録（電話の結果など）で片付ける。チェックだけで完了にしない
        if (t.kind !== "manual") {
          return json(res, 409, { error: "needs_record", hint: "このタスクは、電話・メール・回答確認などの記録をすると完了になります" });
        }
        if (!reason) return json(res, 400, { error: "invalid_body", field: "note", hint: "何をしたかを入れてください" });
        if (isClosed(proposal.status)) return json(res, 409, { error: "closed" });
        const { data: a, error: e1 } = await sb.from("gw_sales_proposal_activities").insert({
          tenant_id: ctx.tenantId, proposal_id: proposal.id, kind: "task", occurred_at: now, employee_id: ctx.employee?.id || null,
          created_by: user.id, note: reason, detail: { op: "done", taskId: t.id, title: t.title },
        }).select("id").single();
        if (e1) return fail(res, e1);
        const { error: e2 } = await sb.from("gw_sales_proposal_tasks")
          .update({ status: "done", done_at: now, done_by: user.id, done_activity_id: a.id }).eq("id", t.id).eq("status", "open");
        if (e2) return fail(res, e2);
        return done(res, sb, ctx, proposal);
      }

      // task_cancel
      if (t.auto && !manager) return json(res, 403, { error: "forbidden", hint: "自動で作られたタスクの取り消しは管理者が行います" });
      if (!reason) return json(res, 400, { error: "invalid_body", field: "reason", hint: "取り消す理由を入れてください" });
      const { error: e1 } = await sb.from("gw_sales_proposal_tasks").update({ status: "canceled", cancel_reason: reason }).eq("id", t.id).eq("status", "open");
      if (e1) return fail(res, e1);
      await sb.from("gw_sales_proposal_activities").insert({
        tenant_id: ctx.tenantId, proposal_id: proposal.id, kind: "task", occurred_at: now, employee_id: ctx.employee?.id || null,
        created_by: user.id, note: `取り消し：${t.title}（${reason}）`, detail: { op: "cancel", taskId: t.id },
      });
      await audit(ctx, user, "task_cancel", proposal, { taskId: t.id, kind: t.kind, auto: Boolean(t.auto) });
      return done(res, sb, ctx, proposal);
    }

    if (action === "contact") {
      const patch = {};
      const s = (v, max) => { const x = String(v ?? "").trim(); return x ? x.slice(0, max) : null; };
      if (body.contactName !== undefined) patch.contact_name = s(body.contactName, 100);
      if (body.contactPhone !== undefined) patch.contact_phone = s(body.contactPhone, 40);
      if (body.contactEmail !== undefined) {
        const e = body.contactEmail ? normalizeEmail(body.contactEmail) : null;
        if (body.contactEmail && !e) return json(res, 400, { error: "invalid_body", field: "contactEmail", hint: "メールアドレスの形を確かめてください" });
        patch.contact_email = e;
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing_to_update" });
      const { data: after, error: e1 } = await sb.from("gw_sales_proposals").update({ ...patch, updated_by: user.id })
        .eq("id", proposal.id).eq("tenant_id", ctx.tenantId).select(PROPOSAL_FIELDS).single();
      if (e1) return fail(res, e1);
      await sb.from("gw_sales_proposal_activities").insert({
        tenant_id: ctx.tenantId, proposal_id: proposal.id, kind: "contact", occurred_at: now, employee_id: ctx.employee?.id || null,
        created_by: user.id, note: "先方の窓口を更新", detail: { fields: Object.keys(patch) },
      });
      return done(res, sb, ctx, after);
    }

    if (action === "link") return link(res, sb, ctx, user, proposal, body, now);
  } catch (e) {
    return fail(res, e);
  }
  return json(res, 400, { error: "unknown_action" });
}

async function done(res, sb, ctx, proposal) {
  const { proposal: fresh } = await loadProposal(sb, ctx.tenantId, proposal.id);
  const out = await detailOf(sb, ctx, fresh || proposal);
  if (out.error) return fail(res, out.error);
  return json(res, 200, out);
}

/**
 * 企業の紐付け。社名の一致で自動にはしない（人が選ぶ）。付け替え・解除は監査ログに残す。
 * dx.enger の企業IDがある提案は、gw_sales_company_links にも覚える（次から同じ会社の提案は自動でこの企業に入る）
 */
async function link(res, sb, ctx, user, proposal, body, now) {
  let companyId = body.companyId === undefined ? undefined : body.companyId || null;
  let method = "manual";
  if (body.create === true) {
    if (proposal.company_id) return json(res, 409, { error: "already_linked", hint: "すでに企業に紐付いています" });
    const { data: made, error } = await sb.from("gw_sales_companies").insert({
      tenant_id: ctx.tenantId, name: proposal.company_name, phone: proposal.contact_phone || null, service: proposal.service || null,
      status: "proposal", owner_id: proposal.sales_owner_id || null,
      note: proposal.source_system === "enger" ? "dx.enger の提案から登録" : "提案管理から登録", created_by: user.id,
    }).select("id").single();
    if (error) return fail(res, error);
    companyId = made.id;
    method = "created";
  }
  if (companyId === undefined) return json(res, 400, { error: "invalid_body", required: ["companyId"] });
  if (companyId !== null) {
    if (!isUuid(companyId)) return json(res, 400, { error: "invalid_body", field: "companyId" });
    const { data: c } = await sb.from("gw_sales_companies").select("id, name").eq("id", companyId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!c) return json(res, 404, { error: "company_not_found" });
  }
  if (companyId === proposal.company_id) return json(res, 400, { error: "nothing_to_update" });

  const { data: after, error: e1 } = await sb.from("gw_sales_proposals").update({ company_id: companyId, updated_by: user.id })
    .eq("id", proposal.id).eq("tenant_id", ctx.tenantId).select(PROPOSAL_FIELDS).single();
  if (e1) return fail(res, e1);
  if (proposal.source_company_id && companyId) {
    const { data: cur } = await sb.from("gw_sales_company_links").select("id, company_id").eq("tenant_id", ctx.tenantId)
      .eq("source_system", "enger").eq("source_company_id", proposal.source_company_id).maybeSingle();
    if (cur) {
      await sb.from("gw_sales_company_links").update({ company_id: companyId, method, updated_at: now }).eq("id", cur.id);
    } else {
      await sb.from("gw_sales_company_links").insert({
        tenant_id: ctx.tenantId, source_system: "enger", source_company_id: proposal.source_company_id, company_id: companyId,
        method, created_by: user.id,
      });
    }
  }
  await sb.from("gw_sales_proposal_activities").insert({
    tenant_id: ctx.tenantId, proposal_id: proposal.id, company_id: companyId, kind: "link", occurred_at: now,
    employee_id: ctx.employee?.id || null, created_by: user.id,
    note: companyId ? (method === "created" ? "提案から企業を登録して紐付け" : "企業に紐付け") : "企業の紐付けを外した",
    detail: { from: proposal.company_id || null, to: companyId, method },
  });
  await audit(ctx, user, "link", proposal, { from: proposal.company_id || null, to: companyId, method,
    sourceCompanyId: proposal.source_company_id || null });
  return done(res, sb, ctx, after);
}
