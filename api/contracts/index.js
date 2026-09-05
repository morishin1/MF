// GET  /api/contracts                    … 契約の一覧と、期日が近い予定
// GET  /api/contracts?employeeId=…       … その人の契約と、契約ごとの予定
// POST /api/contracts {action}
//        "upload"    … 契約書を置くための署名URLを発行する
//        "read"      … 置いたファイルをAIに読ませ、draft の契約を作る
//        "update"    … 読み取った内容を人が直す
//        "confirm"   … 確定する（ここで初めて予定が並ぶ）
//        "compute"   … その予定の期間を集計し、基準に当てはめる
//        "summarize" … AIに面談の所見を書かせる
//        "decide"    … 人が決定を押す（更新する / しない / 条件を変える）
//        "dismiss"   … その予定を消す（要らない面談を残さないため）
//
// ★ AIが読んだものをそのまま使わない。人が確認して confirm するまで
//   予定は1つも作らない。契約書の読み違いがそのまま契約満了日になると実害が出る。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate, weekStart } from "../../lib/nippo.js";
import { CRITERIA } from "../../lib/nippo-eval.js";
import {
  settingsOf, computeMetrics, applyChecks,
} from "../../lib/probation.js";
import {
  readContract, normalize, buildMilestones, reviewMilestone, isConfigured,
  CONTRACT_TYPES, WAGE_TYPES, KIND_LABEL, DECISION_LABEL, PROMPT_VERSION,
} from "../../lib/contracts.js";

const BUCKET = "hr";
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"]);
const MAX_BYTES = 15 * 1024 * 1024;

const canManage = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManage(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return act(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = admin();
  const today = jstDate();

  if (q.get("employeeId")) {
    const { data: employee } = await sb.from("gw_employees")
      .select("id, user_id, display_name, department, employment_type, joined_on")
      .eq("id", q.get("employeeId")).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!employee) return json(res, 404, { error: "employee_not_found" });

    const [{ data: contracts }, { data: milestones }] = await Promise.all([
      sb.from("gw_contracts").select("*")
        .eq("employee_id", employee.id).order("created_at", { ascending: false }),
      sb.from("gw_contract_milestones").select("*")
        .eq("employee_id", employee.id).order("due_on"),
    ]);

    return json(res, 200, {
      today, employee, criteria: CRITERIA,
      aiConfigured: isConfigured(),
      contractTypes: CONTRACT_TYPES, wageTypes: WAGE_TYPES,
      labels: { kind: KIND_LABEL, decision: DECISION_LABEL },
      contracts: (contracts || []).map(shapeContract),
      milestones: (milestones || []).map(shapeMilestone),
    });
  }

  // 一覧。契約と、これから来る予定
  const [{ data: contracts }, { data: milestones }, { data: roster }] = await Promise.all([
    sb.from("gw_contracts").select("*").eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false }).limit(300),
    sb.from("gw_contract_milestones").select("*").eq("tenant_id", ctx.tenantId)
      .is("decision", null).is("dismissed_at", null)
      .order("due_on").limit(200),
    sb.from("gw_employees").select("id, display_name, department, employment_type, joined_on, status")
      .eq("tenant_id", ctx.tenantId).in("status", ["invited", "active", "leaving"])
      .order("display_name").limit(300),
  ]);

  const names = new Map((roster || []).map((e) => [e.id, e.display_name]));

  return json(res, 200, {
    today,
    aiConfigured: isConfigured(),
    contractTypes: CONTRACT_TYPES, wageTypes: WAGE_TYPES,
    labels: { kind: KIND_LABEL, decision: DECISION_LABEL },
    employees: roster || [],
    contracts: (contracts || []).map((c) => ({ ...shapeContract(c), employeeName: names.get(c.employee_id) })),
    upcoming: (milestones || []).map((m) => ({
      ...shapeMilestone(m),
      employeeName: names.get(m.employee_id),
      overdue: m.due_on < today,
      daysLeft: Math.ceil((new Date(`${m.due_on}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000),
    })),
  });
}

// ---- 操作 -------------------------------------------------------------------
async function act(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();

  switch (body?.action) {
    case "upload":    return issueUploadUrl(res, ctx, body);
    case "read":      return readFile(res, sb, ctx, user, body);
    case "update":    return updateContract(res, sb, ctx, body);
    case "confirm":   return confirmContract(res, sb, ctx, user, body);
    case "compute":   return computeOne(res, sb, ctx, body);
    case "summarize": return summarizeOne(res, sb, ctx, user, body);
    case "decide":    return decideOne(res, sb, ctx, user, body);
    case "dismiss":   return dismissOne(res, sb, ctx, body);
    default: return json(res, 400, { error: "unknown_action" });
  }
}

async function issueUploadUrl(res, ctx, body) {
  const { employeeId, filename, mimeType, sizeBytes } = body;
  if (!employeeId || !filename || !mimeType || !sizeBytes) {
    return json(res, 400, { error: "invalid_body", required: ["employeeId", "filename", "mimeType", "sizeBytes"] });
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    return json(res, 400, { error: "unsupported_mime", hint: "PDF・JPEG・PNG・HEIC・WebP に対応しています" });
  }
  if (sizeBytes > MAX_BYTES) {
    return json(res, 400, { error: "file_too_large", hint: "15MBまでにしてください" });
  }

  const ext = String(filename).includes(".")
    ? String(filename).split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
    : "bin";
  const path = `${ctx.tenantId}/${employeeId}/contract/${crypto.randomUUID()}.${ext}`;

  const { data, error } = await admin().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });
  return json(res, 200, { path, uploadUrl: data.signedUrl, token: data.token });
}

/** 置いたファイルをAIに読ませ、draft の契約を作る */
async function readFile(res, sb, ctx, user, body) {
  const { employeeId, path, filename, mimeType } = body;
  if (!employeeId || !path) {
    return json(res, 400, { error: "invalid_body", required: ["employeeId", "path"] });
  }
  // 他人のフォルダを読ませない
  const [tenantId, empInPath] = String(path).split("/");
  if (tenantId !== ctx.tenantId || empInPath !== employeeId) {
    return json(res, 403, { error: "forbidden" });
  }

  const { data: row, error } = await sb.from("gw_contracts").insert({
    tenant_id: ctx.tenantId,
    employee_id: employeeId,
    file_path: path,
    filename: String(filename || "").slice(0, 200) || null,
    status: "draft",
    ai_status: isConfigured() ? "processing" : "pending",
    ai_prompt_version: PROMPT_VERSION,
    uploaded_by: user.id,
  }).select("*").single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  if (!isConfigured()) {
    return json(res, 200, {
      contract: shapeContract(row),
      hint: "AIの鍵が未設定のため、項目は手で入れてください（ANTHROPIC_API_KEY）",
    });
  }

  // Storage から取って base64 にする。保存はしない（メモリで扱う）
  let base64;
  try {
    const { data: file, error: de } = await sb.storage.from(BUCKET).download(path);
    if (de) throw new Error(de.message);
    base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  } catch (e) {
    const saved = await patchContract(sb, row.id, {
      ai_status: "failed", ai_error: `ファイルを読めません: ${String(e?.message || e)}`.slice(0, 300),
    });
    return json(res, 502, { contract: shapeContract(saved), error: "download_failed" });
  }

  const r = await readContract({ base64, mimeType: mimeType || "application/pdf" });
  const patch = r.ok
    ? {
        ...toColumns(r.result),
        extracted: r.result,
        ai_status: "completed",
        ai_model: r.model,
        ai_confidence: r.result.confidence,
        ai_error: null,
      }
    : { ai_status: "failed", ai_error: String(r.detail || "").slice(0, 500) };

  const saved = await patchContract(sb, row.id, patch);
  if (!r.ok) {
    return json(res, 502, {
      contract: shapeContract(saved), error: "ai_failed",
      hint: "読み取れませんでした。項目を手で入れてください",
    });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "contract.read",
    target: `employee:${employeeId}`, detail: { confidence: r.result.confidence },
  });
  return json(res, 200, { contract: shapeContract(saved) });
}

/** 読み取った内容を人が直す */
async function updateContract(res, sb, ctx, body) {
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const v = normalize(body.contract || {});

  const patch = {
    ...toColumns(v),
    renewal_notice_days: clampInt(body.contract?.renewal_notice_days, 0, 365) ?? 30,
    note: String(body.contract?.note ?? "").trim().slice(0, 2000) || null,
  };

  const { data, error } = await sb.from("gw_contracts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select("*").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "contract_not_found" });
  return json(res, 200, { contract: shapeContract(data) });
}

/**
 * 確定して、予定を並べる。
 * 契約を直して確定し直すと作り直すが、人が消した予定は復活させない。
 */
async function confirmContract(res, sb, ctx, user, body) {
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const { data: c } = await sb.from("gw_contracts").select("*")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!c) return json(res, 404, { error: "contract_not_found" });
  if (!c.period_from) {
    return json(res, 400, { error: "no_period", hint: "契約開始日を入れてから確定してください" });
  }
  if (c.fixed_term && !c.period_to) {
    return json(res, 400, { error: "no_period_to", hint: "期間の定めがある契約は、終了日を入れてください" });
  }

  const probationEnd = c.probation_months
    ? addMonths(c.period_from, c.probation_months) : null;

  // 同じ人の、前の契約を「置き換わった」にする
  await sb.from("gw_contracts")
    .update({ status: "superseded", updated_at: new Date().toISOString() })
    .eq("employee_id", c.employee_id).eq("status", "active").neq("id", c.id);

  const { data: contract } = await sb.from("gw_contracts").update({
    status: "active",
    probation_end: probationEnd,
    confirmed_by: user.id,
    confirmed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", c.id).select("*").single();

  // 予定を並べる。期中の面談をどこに置くかは試用期間の設定を使う
  const { data: settingsRow } = await sb.from("gw_workflow_settings")
    .select("probation").eq("tenant_id", ctx.tenantId).maybeSingle();
  const months = settingsOf(settingsRow).checkpoints
    .map((c2) => ({ "1m": 1, "3m": 3, "6m": 6 })[c2]).filter(Boolean);

  const planned = buildMilestones(contract, months);

  // 人が消したもの、もう決めたものは触らない
  const { data: existing } = await sb.from("gw_contract_milestones")
    .select("id, kind, due_on, decision, dismissed_at").eq("contract_id", contract.id);
  const keep = new Set((existing || [])
    .filter((m) => m.decision || m.dismissed_at)
    .map((m) => `${m.kind}|${m.due_on}`));

  const rows = planned
    .filter((m) => !keep.has(`${m.kind}|${m.due_on}`))
    .map((m) => ({
      tenant_id: ctx.tenantId,
      contract_id: contract.id,
      employee_id: contract.employee_id,
      ...m,
    }));

  if (rows.length) {
    const { error } = await sb.from("gw_contract_milestones")
      .upsert(rows, { onConflict: "contract_id,kind,due_on" });
    if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "contract.confirm",
    target: `employee:${contract.employee_id}`,
    detail: { from: contract.period_from, to: contract.period_to, milestones: rows.length },
  });

  const { data: milestones } = await sb.from("gw_contract_milestones")
    .select("*").eq("contract_id", contract.id).order("due_on");

  return json(res, 200, {
    contract: shapeContract(contract),
    milestones: (milestones || []).map(shapeMilestone),
  });
}

// ---- 面談の材料 -------------------------------------------------------------
async function loadMilestone(sb, ctx, id) {
  const { data: m } = await sb.from("gw_contract_milestones").select("*")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!m) return null;
  const [{ data: employee }, { data: contract }] = await Promise.all([
    sb.from("gw_employees").select("id, user_id, display_name, employment_type").eq("id", m.employee_id).maybeSingle(),
    sb.from("gw_contracts").select("*").eq("id", m.contract_id).maybeSingle(),
  ]);
  return { m, employee, contract };
}

async function gather(sb, employee, from, to) {
  if (!employee?.user_id) return { nippos: [], weeks: [], evals: [] };
  const [{ data: nippos }, { data: weeks }] = await Promise.all([
    sb.from("tc_nippo").select("*").eq("user_id", employee.user_id)
      .gte("work_date", from).lte("work_date", to),
    sb.from("tc_weekly_review").select("*").eq("user_id", employee.user_id)
      .gte("week_start", weekStart(from)).lte("week_start", to).order("week_start"),
  ]);
  const list = nippos || [];
  let evals = [];
  if (list.length) {
    const { data } = await sb.from("gw_nippo_ai_evals").select("nippo_id")
      .in("nippo_id", list.map((n) => n.id)).eq("status", "completed");
    evals = data || [];
  }
  return { nippos: list, weeks: weeks || [], evals };
}

async function computeOne(res, sb, ctx, body) {
  const loaded = await loadMilestone(sb, ctx, body?.milestoneId);
  if (!loaded) return json(res, 404, { error: "milestone_not_found" });
  const { m, employee } = loaded;

  const { data: settingsRow } = await sb.from("gw_workflow_settings")
    .select("probation").eq("tenant_id", ctx.tenantId).maybeSingle();
  const thresholds = settingsOf(settingsRow).thresholds;

  const from = m.period_from || m.due_on;
  const to = m.period_to || m.due_on;
  const { nippos, weeks, evals } = await gather(sb, employee, from, to);
  const metrics = computeMetrics({ from, to, nippos, weeks, evals });
  const { checks, verdict } = applyChecks(metrics, thresholds);

  const saved = await patchMilestone(sb, m.id, {
    metrics, checks, verdict, computed_at: new Date().toISOString(),
  });
  return json(res, 200, { milestone: shapeMilestone(saved) });
}

async function summarizeOne(res, sb, ctx, user, body) {
  if (!isConfigured()) return json(res, 503, { error: "not_configured", hint: "AIの鍵が未設定です" });

  const loaded = await loadMilestone(sb, ctx, body?.milestoneId);
  if (!loaded) return json(res, 404, { error: "milestone_not_found" });
  const { m, employee, contract } = loaded;

  const { data: settingsRow } = await sb.from("gw_workflow_settings")
    .select("probation").eq("tenant_id", ctx.tenantId).maybeSingle();
  const thresholds = settingsOf(settingsRow).thresholds;

  const from = m.period_from || m.due_on;
  const to = m.period_to || m.due_on;
  const { nippos, weeks, evals } = await gather(sb, employee, from, to);
  if (!nippos.length) {
    return json(res, 400, { error: "no_nippo", hint: "この期間の日報がまだありません" });
  }

  const metrics = computeMetrics({ from, to, nippos, weeks, evals });
  const { checks, verdict } = applyChecks(metrics, thresholds);
  await patchMilestone(sb, m.id, {
    metrics, checks, verdict, computed_at: new Date().toISOString(), ai_status: "processing",
  });

  const r = await reviewMilestone({ employee, contract, milestone: m, metrics, checks, weeks });
  const patch = r.ok
    ? {
        ai_status: "completed", ai_model: r.model,
        ai_summary: r.result.summary,
        ai_strengths: r.result.strengths,
        ai_concerns: r.result.concerns,
        ai_questions: r.result.questions,
        ai_error: null,
      }
    : { ai_status: "failed", ai_error: String(r.detail || "").slice(0, 500) };

  const saved = await patchMilestone(sb, m.id, patch);
  if (!r.ok) return json(res, 502, { milestone: shapeMilestone(saved), error: "ai_failed" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "contract.summarize",
    target: `employee:${employee.display_name}`, detail: { kind: m.kind, verdict },
  });
  return json(res, 200, { milestone: shapeMilestone(saved) });
}

/** ★ 決定は人が押す。AIも verdict もここには何も書かない */
async function decideOne(res, sb, ctx, user, body) {
  const loaded = await loadMilestone(sb, ctx, body?.milestoneId);
  if (!loaded) return json(res, 404, { error: "milestone_not_found" });
  const { m, employee } = loaded;

  if (!Object.keys(DECISION_LABEL).includes(body?.decision)) {
    return json(res, 400, { error: "invalid_decision", hint: Object.keys(DECISION_LABEL).join(" / ") });
  }
  const note = String(body.note ?? "").trim();
  // 更新しない・条件を変える は理由を必ず残す
  if (["end", "change"].includes(body.decision) && !note) {
    return json(res, 400, {
      error: "note_required",
      hint: "更新しない・条件を変えるときは理由を残してください（あとから経緯を説明できなくなります）",
    });
  }

  const saved = await patchMilestone(sb, m.id, {
    decision: body.decision,
    decision_note: note.slice(0, 4000) || null,
    decided_by: user.id,
    decided_at: new Date().toISOString(),
  });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: `contract.${body.decision}`,
    target: `employee:${employee.display_name}`,
    detail: { kind: m.kind, due_on: m.due_on, verdict: m.verdict, note: note.slice(0, 200) },
  });
  return json(res, 200, { milestone: shapeMilestone(saved) });
}

async function dismissOne(res, sb, ctx, body) {
  const loaded = await loadMilestone(sb, ctx, body?.milestoneId);
  if (!loaded) return json(res, 404, { error: "milestone_not_found" });
  const saved = await patchMilestone(sb, loaded.m.id, { dismissed_at: new Date().toISOString() });
  return json(res, 200, { milestone: shapeMilestone(saved) });
}

// ---- 補助 -------------------------------------------------------------------
const addMonths = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

const clampInt = (v, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** normalize() の結果を、そのまま列に入れられる形に */
function toColumns(v) {
  return {
    contract_type: v.contract_type,
    fixed_term: v.fixed_term,
    period_from: v.period_from,
    period_to: v.period_to,
    probation_months: v.probation_months,
    renewable: v.renewable,
    renewal_criteria: v.renewal_criteria,
    work_hours: v.work_hours,
    work_days: v.work_days,
    work_place: v.work_place,
    job_content: v.job_content,
    wage_type: v.wage_type,
    wage_amount: v.wage_amount,
    wage_note: v.wage_note,
  };
}

async function patchContract(sb, id, patch) {
  const { data } = await sb.from("gw_contracts")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
  return data;
}

async function patchMilestone(sb, id, patch) {
  const { data } = await sb.from("gw_contract_milestones")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
  return data;
}

function shapeContract(c) {
  if (!c) return null;
  return {
    id: c.id, employeeId: c.employee_id, status: c.status,
    filePath: c.file_path, filename: c.filename,
    contractType: c.contract_type, fixedTerm: c.fixed_term,
    periodFrom: c.period_from, periodTo: c.period_to,
    probationMonths: c.probation_months, probationEnd: c.probation_end,
    renewable: c.renewable, renewalCriteria: c.renewal_criteria,
    renewalNoticeDays: c.renewal_notice_days,
    workHours: c.work_hours, workDays: c.work_days, workPlace: c.work_place,
    jobContent: c.job_content,
    wageType: c.wage_type, wageAmount: c.wage_amount, wageNote: c.wage_note,
    aiStatus: c.ai_status, aiConfidence: c.ai_confidence, aiError: c.ai_error, aiModel: c.ai_model,
    unreadable: c.extracted?.unreadable || [],
    note: c.note,
    confirmedAt: c.confirmed_at,
    createdAt: c.created_at,
  };
}

function shapeMilestone(m) {
  if (!m) return null;
  return {
    id: m.id, contractId: m.contract_id, employeeId: m.employee_id,
    kind: m.kind, title: m.title, dueOn: m.due_on,
    periodFrom: m.period_from, periodTo: m.period_to,
    metrics: m.metrics, checks: m.checks, verdict: m.verdict, computedAt: m.computed_at,
    aiStatus: m.ai_status, aiSummary: m.ai_summary,
    aiStrengths: m.ai_strengths || [], aiConcerns: m.ai_concerns || [],
    aiQuestions: m.ai_questions || [], aiModel: m.ai_model, aiError: m.ai_error,
    decision: m.decision, decisionNote: m.decision_note, decidedAt: m.decided_at,
    dismissedAt: m.dismissed_at,
  };
}
