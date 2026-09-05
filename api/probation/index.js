// GET  /api/probation                      … 試用期間中の人の一覧（期限が近い順）
// GET  /api/probation?employeeId=…         … その人の各区切りと、集計・判定
// POST /api/probation {employeeId, checkpoint, action}
//        action="compute"   … 集計して基準に当てはめ、保存する
//        action="summarize" … AIに所見を書かせる（点は付けさせない）
//        action="decide"    … 人が決定を押す（本採用 / 延長 / 不採用）
//        action="settings"  … 判定基準を変える
//
// ★ 自動化しているのは、材料集めと基準の当てはめまで。
//   本採用・延長・不採用の決定は decision に人が押した内容だけが入る。
//   verdict（基準を満たしたか）は機械の計算結果で、決定ではない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate, weekStart } from "../../lib/nippo.js";
import { CRITERIA } from "../../lib/nippo-eval.js";
import {
  settingsOf, checkpointsFor, computeMetrics, applyChecks, summarizeProbation,
  isConfigured, CHECKPOINT_LABEL, PROMPT_VERSION, DEFAULTS,
} from "../../lib/probation.js";

const canSee = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSee(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return act(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function loadSettings(sb, tenantId) {
  const { data } = await sb.from("gw_workflow_settings")
    .select("probation").eq("tenant_id", tenantId).maybeSingle();
  return settingsOf(data);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = admin();
  const today = jstDate();
  const settings = await loadSettings(sb, ctx.tenantId);

  if (q.get("employeeId")) return one(res, sb, ctx, q.get("employeeId"), settings, today);

  // 試用期間中の人。入社日から months を過ぎていない人だけ
  const { data: roster } = await sb
    .from("gw_employees")
    .select("id, user_id, display_name, department, employment_type, joined_on, status")
    .eq("tenant_id", ctx.tenantId)
    .in("status", ["invited", "active"])
    .not("joined_on", "is", null)
    .order("joined_on", { ascending: false })
    .limit(300);

  const { data: reviews } = await sb
    .from("gw_probation_reviews").select("*").eq("tenant_id", ctx.tenantId);
  const byKey = new Map((reviews || []).map((r) => [`${r.employee_id}|${r.checkpoint}`, r]));

  const people = [];
  for (const e of roster || []) {
    const cps = checkpointsFor(e, settings, today);
    const last = cps[cps.length - 1];
    // 試用期間が終わって、最後の区切りも決まっている人は一覧から外す
    const finalReview = byKey.get(`${e.id}|final`);
    if (last?.reached && finalReview?.decision) continue;
    // 試用期間の終わりから60日以上たっていて、まだ何も押していない人は残す
    // （押し忘れを見つけるため。自動では何もしない）

    people.push({
      employeeId: e.id,
      userId: e.user_id,
      name: e.display_name,
      department: e.department,
      employmentType: e.employment_type,
      joinedOn: e.joined_on,
      checkpoints: cps.map((c) => {
        const r = byKey.get(`${e.id}|${c.checkpoint}`);
        return {
          ...c,
          verdict: r?.verdict || null,
          decision: r?.decision || null,
          computedAt: r?.computed_at || null,
        };
      }),
      // いま見るべき区切り（過ぎていて、まだ決まっていない最初のもの）
      next: cps.find((c) => c.reached && !byKey.get(`${e.id}|${c.checkpoint}`)?.decision)
        || cps.find((c) => !c.reached) || null,
    });
  }

  people.sort((a, b) => (a.next?.due || "9999").localeCompare(b.next?.due || "9999"));

  return json(res, 200, {
    today, settings, people, criteria: CRITERIA,
    aiConfigured: isConfigured(),
    labels: CHECKPOINT_LABEL,
  });
}

async function one(res, sb, ctx, employeeId, settings, today) {
  const { data: employee } = await sb.from("gw_employees")
    .select("id, user_id, display_name, department, employment_type, joined_on, status")
    .eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!employee) return json(res, 404, { error: "employee_not_found" });

  const { data: reviews } = await sb.from("gw_probation_reviews")
    .select("*").eq("employee_id", employeeId);
  const byCp = new Map((reviews || []).map((r) => [r.checkpoint, r]));

  return json(res, 200, {
    today, settings, employee, criteria: CRITERIA,
    aiConfigured: isConfigured(),
    checkpoints: checkpointsFor(employee, settings, today).map((c) => ({
      ...c, review: shape(byCp.get(c.checkpoint)),
    })),
  });
}

// ---- 操作 -------------------------------------------------------------------
async function act(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();

  if (body?.action === "settings") return saveSettings(res, sb, ctx, user, body);

  if (!body?.employeeId || !CHECKPOINT_LABEL[body?.checkpoint]) {
    return json(res, 400, { error: "invalid_body", required: ["employeeId", "checkpoint"] });
  }

  const { data: employee } = await sb.from("gw_employees")
    .select("id, user_id, display_name, employment_type, joined_on")
    .eq("id", body.employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!employee) return json(res, 404, { error: "employee_not_found" });
  if (!employee.joined_on) {
    return json(res, 400, { error: "no_joined_on", hint: "入社日が未登録です。メンバー画面で登録してください" });
  }

  const settings = await loadSettings(sb, ctx.tenantId);
  const cp = checkpointsFor(employee, settings, jstDate()).find((c) => c.checkpoint === body.checkpoint);
  if (!cp) return json(res, 400, { error: "invalid_checkpoint" });

  if (body.action === "compute") return compute(res, sb, ctx, employee, cp, settings);
  if (body.action === "summarize") return summarize(res, sb, ctx, user, employee, cp, settings);
  if (body.action === "decide") return decide(res, sb, ctx, user, employee, cp, body);
  return json(res, 400, { error: "unknown_action" });
}

/** 材料を集める。ここは全部プログラム */
async function gather(sb, employee, cp) {
  const [{ data: nippos }, { data: weeks }] = await Promise.all([
    employee.user_id
      ? sb.from("tc_nippo").select("*")
          .eq("user_id", employee.user_id)
          .gte("work_date", cp.periodFrom).lte("work_date", cp.periodTo)
      : Promise.resolve({ data: [] }),
    employee.user_id
      ? sb.from("tc_weekly_review").select("*")
          .eq("user_id", employee.user_id)
          .gte("week_start", weekStart(cp.periodFrom)).lte("week_start", cp.periodTo)
          .order("week_start")
      : Promise.resolve({ data: [] }),
  ]);

  const list = nippos || [];
  let evals = [];
  if (list.length) {
    const { data } = await sb.from("gw_nippo_ai_evals")
      .select("nippo_id").in("nippo_id", list.map((n) => n.id)).eq("status", "completed");
    evals = data || [];
  }
  return { nippos: list, weeks: weeks || [], evals };
}

async function compute(res, sb, ctx, employee, cp, settings) {
  const { nippos, weeks, evals } = await gather(sb, employee, cp);
  const metrics = computeMetrics({ from: cp.periodFrom, to: cp.periodTo, nippos, weeks, evals });
  const { checks, verdict } = applyChecks(metrics, settings.thresholds);

  const saved = await upsert(sb, ctx.tenantId, employee, cp, {
    metrics, checks, verdict, computed_at: new Date().toISOString(),
  });
  return json(res, 200, { review: shape(saved) });
}

async function summarize(res, sb, ctx, user, employee, cp, settings) {
  if (!isConfigured()) {
    return json(res, 503, { error: "not_configured", hint: "AIの鍵が未設定です" });
  }

  const { nippos, weeks, evals } = await gather(sb, employee, cp);
  if (!nippos.length) {
    return json(res, 400, { error: "no_nippo", hint: "この期間の日報がまだありません" });
  }

  const metrics = computeMetrics({ from: cp.periodFrom, to: cp.periodTo, nippos, weeks, evals });
  const { checks, verdict } = applyChecks(metrics, settings.thresholds);

  await upsert(sb, ctx.tenantId, employee, cp, {
    metrics, checks, verdict, computed_at: new Date().toISOString(),
    ai_status: "processing", ai_prompt_version: PROMPT_VERSION,
  });

  const r = await summarizeProbation({
    employee, checkpoint: cp.checkpoint, metrics, checks, weeks,
  });

  const patch = r.ok
    ? {
        ai_status: "completed",
        ai_model: r.model,
        ai_summary: r.result.summary,
        ai_strengths: r.result.strengths,
        ai_concerns: r.result.concerns,
        ai_questions: r.result.questions,
        ai_error: null,
        ai_generated_at: new Date().toISOString(),
      }
    : { ai_status: "failed", ai_error: String(r.detail || "").slice(0, 500) };

  const saved = await upsert(sb, ctx.tenantId, employee, cp, patch);
  if (!r.ok) {
    return json(res, 502, { review: shape(saved), error: "ai_failed", hint: "AIが応答しませんでした" });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "probation.summarize",
    target: `employee:${employee.display_name}`, detail: { checkpoint: cp.checkpoint, verdict },
  });
  return json(res, 200, { review: shape(saved) });
}

/**
 * 人が決定を押す。
 * ここだけは AI も verdict も触らない。誰がいつ押したかを残す。
 */
async function decide(res, sb, ctx, user, employee, cp, body) {
  const decision = body.decision;
  if (!["pass", "extend", "fail"].includes(decision)) {
    return json(res, 400, { error: "invalid_decision", hint: "pass / extend / fail のいずれかです" });
  }
  const note = String(body.note ?? "").trim();
  // 延長と不採用は理由を必ず残す。あとから経緯を説明できなくなるため
  if (decision !== "pass" && !note) {
    return json(res, 400, {
      error: "note_required",
      hint: "延長・不採用のときは理由を残してください（あとから経緯を説明できなくなります）",
    });
  }

  const saved = await upsert(sb, ctx.tenantId, employee, cp, {
    decision,
    decision_note: note.slice(0, 4000) || null,
    decided_by: user.id,
    decided_at: new Date().toISOString(),
  });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: `probation.${decision}`,
    target: `employee:${employee.display_name}`,
    detail: { checkpoint: cp.checkpoint, verdict: saved.verdict, note: note.slice(0, 200) },
  });
  return json(res, 200, { review: shape(saved) });
}

async function saveSettings(res, sb, ctx, user, body) {
  if (!ctx.isAdmin && !ctx.roles.includes("owner")) {
    return json(res, 403, { error: "forbidden", hint: "基準の変更は管理者・経営者のみです" });
  }
  const p = body.probation || {};
  const th = {};
  for (const [k, def] of Object.entries(DEFAULTS.thresholds)) {
    const v = p.thresholds?.[k];
    const n = v === "" || v === null || v === undefined ? def : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return json(res, 400, { error: "invalid_threshold", hint: `${k} は 0〜100 で入れてください` });
    }
    th[k] = n;
  }
  const months = Number(p.months);
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    return json(res, 400, { error: "invalid_months", hint: "試用期間は1〜24か月です" });
  }
  const checkpoints = (Array.isArray(p.checkpoints) ? p.checkpoints : [])
    .filter((c) => ["1m", "3m", "6m"].includes(c));

  const probation = { months, checkpoints: checkpoints.length ? checkpoints : DEFAULTS.checkpoints, thresholds: th };

  const { error } = await sb.from("gw_workflow_settings")
    .upsert({ tenant_id: ctx.tenantId, probation, updated_at: new Date().toISOString() },
            { onConflict: "tenant_id" });
  if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "probation.settings",
    target: `tenant:${ctx.tenantId}`, detail: probation,
  });
  return json(res, 200, { settings: probation });
}

async function upsert(sb, tenantId, employee, cp, patch) {
  const { data, error } = await sb.from("gw_probation_reviews").upsert({
    tenant_id: tenantId,
    employee_id: employee.id,
    user_id: employee.user_id,
    checkpoint: cp.checkpoint,
    period_from: cp.periodFrom,
    period_to: cp.periodTo,
    ...patch,
    updated_at: new Date().toISOString(),
  }, { onConflict: "employee_id,checkpoint" }).select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

function shape(r) {
  if (!r) return null;
  return {
    checkpoint: r.checkpoint,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    metrics: r.metrics,
    checks: r.checks,
    verdict: r.verdict,
    computedAt: r.computed_at,
    aiStatus: r.ai_status,
    aiSummary: r.ai_summary,
    aiStrengths: r.ai_strengths || [],
    aiConcerns: r.ai_concerns || [],
    aiQuestions: r.ai_questions || [],
    aiModel: r.ai_model,
    aiError: r.ai_error,
    decision: r.decision,
    decisionNote: r.decision_note,
    decidedAt: r.decided_at,
  };
}
