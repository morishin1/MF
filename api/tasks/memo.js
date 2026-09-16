// GET  /api/tasks/memo[?employeeId=…]
//        … 未決定のメモ一覧（自分のぶん。管理者・人事は他人のぶんも見られる）
// POST /api/tasks/memo {action}
//        "add"    … 1行だけ書いて置く。期日・担当は要らない
//        "review" … 退勤時、AIにまとめて見てもらう（案を ai_decision/ai_reason に置くだけ）
//        "decide" … 人が決める。task/hand ならタスクの行を1件作る
//        "remove" … 書いた本人が、決める前に取り消す（誤入力）
//
// ■ gw_tasks には混ぜない
//   「明日の3つ」「今日やる3つ」の集計・一覧・KPIは gw_tasks を素直に数える。
//   書きかけのメモをそこに混ぜると、どの数字も信用できなくなる。
//   だから別表（gw_quick_memos）に置き、決めたときだけ gw_tasks の行を作る。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import {
  BODY_MAX, DECISION_KEYS, cleanBody, isDecision, rowOf, taskDraftFor,
} from "../../lib/quick-memo.js";
import { reviewMemos, aiConfigured } from "../../lib/task-ai.js";

const SQL = "db/074_quick_memo.sql";
const FIELDS = "id, tenant_id, employee_id, body, status, decision, decision_note, "
  + "decided_by, decided_at, promoted_task_id, ai_decision, ai_reason, created_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, { error: "no_employee", hint: "社員名簿にあなたの行がありません" });
  }

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return act(req, res, ctx, user, await readJson(req));
  return methodNotAllowed(res, ["GET", "POST"]);
}

/** 誰のぶんを見るか。他人のぶんは管理者・人事だけ */
function targetOf(ctx, employeeId) {
  if (!employeeId || employeeId === ctx.employee.id) return { id: ctx.employee.id, mine: true };
  if (!canManageHr(ctx)) return null;
  return { id: employeeId, mine: false };
}

async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const who = targetOf(ctx, q.get("employeeId"));
  if (!who) return json(res, 403, { error: "forbidden" });

  const sb = admin();
  const { data, error } = await sb.from("gw_quick_memos").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", who.id).eq("status", "open")
    .order("created_at", { ascending: true }).limit(50);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { memos: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  return json(res, 200, {
    memos: (data || []).map(rowOf),
    bodyMax: BODY_MAX,
    aiReady: aiConfigured(),
    employeeId: who.id,
  });
}

async function act(req, res, ctx, user, body) {
  const action = String(body.action || "");
  const sb = admin();

  if (action === "add") return add(res, sb, ctx, user, body);
  if (action === "review") return review(res, sb, ctx, user, body);
  if (action === "decide") return decide(res, sb, ctx, user, body);
  if (action === "remove") return remove(res, sb, ctx, user, body);
  return json(res, 400, { error: "bad_action" });
}

// ---- 書く（誰でも、自分のぶんだけ） -----------------------------------------
async function add(res, sb, ctx, user, body) {
  const text = cleanBody(body.body);
  if (!text) return json(res, 400, { error: "bad_request", hint: "内容を入れてください" });

  const row = {
    tenant_id: ctx.tenantId,
    employee_id: ctx.employee.id,
    body: text,
  };
  const { data, error } = await sb.from("gw_quick_memos").insert(row).select(FIELDS).single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }
  return json(res, 200, { memo: rowOf(data) });
}

// ---- 取り消す（決める前だけ、本人のみ） -------------------------------------
async function remove(res, sb, ctx, user, body) {
  const { data: m } = await sb.from("gw_quick_memos").select("id, employee_id, status")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!m || m.employee_id !== ctx.employee.id) return json(res, 404, { error: "not_found" });
  if (m.status !== "open") return json(res, 409, { error: "already_decided" });

  const { error } = await sb.from("gw_quick_memos").delete().eq("id", m.id);
  if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });
  return json(res, 200, { ok: true });
}

// ---- AIに見てもらう（案を置くだけ。何も確定しない） --------------------------
async function review(res, sb, ctx, user, body) {
  const who = targetOf(ctx, body.employeeId);
  if (!who) return json(res, 403, { error: "forbidden" });
  if (!aiConfigured()) return json(res, 503, { error: "ai_not_configured" });

  const { data: memos, error } = await sb.from("gw_quick_memos").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", who.id).eq("status", "open")
    .order("created_at", { ascending: true }).limit(30);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!memos?.length) return json(res, 200, { memos: [] });

  const { data: emp } = await sb.from("gw_employees").select("display_name")
    .eq("id", who.id).maybeSingle();

  let r;
  try {
    r = await reviewMemos({
      employee: { name: emp?.display_name }, date: new Date().toISOString().slice(0, 10),
      memos: memos.map((m) => ({ body: m.body })),
    });
  } catch (e) {
    console.error("[memo] AI提案に失敗:", e?.message || e);
    return json(res, 502, { error: "ai_failed", hint: "AIの提案に失敗しました" });
  }

  const byIndex = new Map((r.items || []).map((it) => [it.index, it]));
  const updates = [];
  for (let i = 0; i < memos.length; i++) {
    const it = byIndex.get(i);
    if (!it || !isDecision(it.decision)) continue;
    updates.push(
      sb.from("gw_quick_memos")
        .update({ ai_decision: it.decision, ai_reason: it.reason?.slice(0, 300) || null,
                   updated_at: new Date().toISOString() })
        .eq("id", memos[i].id),
    );
  }
  await Promise.all(updates);

  const { data: after } = await sb.from("gw_quick_memos").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", who.id).eq("status", "open")
    .order("created_at", { ascending: true }).limit(30);
  return json(res, 200, { memos: (after || []).map(rowOf) });
}

// ---- 人が決める --------------------------------------------------------------
async function decide(res, sb, ctx, user, body) {
  const { data: m } = await sb.from("gw_quick_memos").select(FIELDS)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!m) return json(res, 404, { error: "not_found" });
  const who = targetOf(ctx, m.employee_id);
  if (!who) return json(res, 403, { error: "forbidden" });
  if (m.status !== "open") return json(res, 409, { error: "already_decided" });
  if (!isDecision(body.decision)) {
    return json(res, 400, { error: "bad_request", hint: "どうするかを選んでください" });
  }
  if (body.decision === "hand" && !body.assigneeId) {
    return json(res, 400, { error: "unknown_assignee", hint: "渡す相手を選んでください" });
  }

  const now = new Date().toISOString();
  let promotedTaskId = null;

  const draft = taskDraftFor(m, body.decision, {
    assigneeId: body.assigneeId, dueOn: body.dueOn, priority: body.priority,
    createdBy: user.id,
  });
  if (draft) {
    const { data: t, error: te } = await sb.from("gw_tasks")
      .insert({ ...draft, tenant_id: ctx.tenantId }).select("id, assignee_id, title").single();
    if (te) {
      const hint = dbSetupHint(te, "db/068_task_flow.sql");
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_insert_failed", detail: te.message });
    }
    promotedTaskId = t.id;
    if (body.decision === "hand") {
      await notify([{
        tenantId: ctx.tenantId, employeeId: t.assignee_id, kind: "task_assigned",
        title: "タスクが回ってきました", body: t.title,
        link: "tasks.html", dedupeKey: `task:${t.id}`,
      }]);
    }
  }

  const { data, error } = await sb.from("gw_quick_memos").update({
    status: "decided",
    decision: body.decision,
    decision_note: body.note ? String(body.note).slice(0, 300) : null,
    decided_by: user.id,
    decided_at: now,
    promoted_task_id: promotedTaskId,
    updated_at: now,
  }).eq("id", m.id).select(FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  return json(res, 200, { memo: rowOf(data) });
}
