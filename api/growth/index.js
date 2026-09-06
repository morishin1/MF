// GET  /api/growth?employeeId=…   … その人の3か月育成計画と、月ごとのKGI/KPI・進捗
// GET  /api/growth?scope=mine     … 自分のぶん（本人が見る）
// GET  /api/growth                … 計画の一覧（管理者）
// POST /api/growth {action:…}
//        create   … 計画の枠を作る（労働条件通知書から期間を引く）
//        draft    … AIに3か月ぶんのドラフトを作らせる
//        saveKgi  … 3か月KGIを直す
//        saveMonth… 月間KGIとKPIを確定する
//        nextMonth… 翌月のドラフトをAIに作らせる
//        approve  … 計画を確定する（ここから日々の画面にKPIが出る）
//        review   … 月末の振り返りを書く
//
// ■ AIが作るのはドラフトまで（要件 §6 §32 §41）
//   計画は「これから3か月、この人に何を任せるか」を決めるもので、
//   AIが決めてよい類のものではない。
//   status が 'draft' のあいだは、KPIは本人の日々の画面に出さない。
//
// ■ 労働条件と評価目標を分ける（§2-1）
//   KPIの達成状況を理由に、賃金・労働時間・雇用形態・契約条件が
//   動くことがあってはならない。この API から gw_contracts へ
//   書き戻す経路は作っていない。読むだけ。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate, isDate } from "../../lib/nippo.js";
import {
  STAGES, KPI_KINDS, monthsOf, monthStart, addMonths,
  kpiProgress, monthProgress, dailyShare, shapePlan, shapeMonth, planDays,
} from "../../lib/growth.js";
import {
  draftPlan, draftNextMonth, isConfigured, PROMPT_VERSION,
} from "../../lib/growth-ai.js";

const KIND_KEYS = KPI_KINDS.map((k) => k.key);
const canManage = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "no_employee" });

  if (req.method === "GET") return read(req, res, user, ctx);
  if (req.method === "POST") {
    if (!canManage(ctx)) return json(res, 403, { error: "forbidden" });
    return act(req, res, user, ctx);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res, user, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = admin();
  const today = jstDate();

  // 本人が自分のぶんを見る場合と、管理者が誰かを見る場合
  let employeeId = q.get("employeeId");
  if (q.get("scope") === "mine" || (!employeeId && !canManage(ctx))) {
    employeeId = ctx.employee.id;
  }
  if (employeeId && employeeId !== ctx.employee.id && !canManage(ctx)) {
    return json(res, 403, { error: "forbidden" });
  }

  // 一覧（管理者）
  if (!employeeId) {
    const { data } = await sb.from("gw_growth_plans")
      .select("*, gw_employees(display_name, department)")
      .eq("tenant_id", ctx.tenantId).order("start_date", { ascending: false }).limit(100);

    return json(res, 200, {
      plans: (data || []).map((p) => ({
        ...shapePlan(p),
        name: p.gw_employees?.display_name,
        department: p.gw_employees?.department,
        days: planDays(p, today),
      })),
      // 計画がまだ無い人。ここから作り始める
      candidates: await withoutPlan(sb, ctx.tenantId, data || []),
      kinds: KPI_KINDS,
      stages: STAGES,
      aiConfigured: isConfigured(),
      canManage: canManage(ctx),
    });
  }

  // 1人ぶん
  const { data: plans } = await sb.from("gw_growth_plans").select("*")
    .eq("employee_id", employeeId).eq("tenant_id", ctx.tenantId)
    .order("start_date", { ascending: false }).limit(10);

  // いま動いているものを先に。無ければ一番新しいもの
  const plan = (plans || []).find((p) => p.status === "active") || (plans || [])[0] || null;
  if (!plan) {
    return json(res, 200, {
      plan: null, months: [], kinds: KPI_KINDS, stages: STAGES,
      aiConfigured: isConfigured(), canManage: canManage(ctx),
    });
  }

  const months = await loadMonths(sb, plan, today);

  return json(res, 200, {
    plan: { ...shapePlan(plan), days: planDays(plan, today) },
    history: (plans || []).filter((p) => p.id !== plan.id).map(shapePlan),
    months,
    // いまの月。画面の「THIS MONTH」に使う
    currentMonth: months.find((m) => m.month === monthStart(today)) || null,
    kinds: KPI_KINDS,
    stages: STAGES,
    aiConfigured: isConfigured(),
    canManage: canManage(ctx),
  });
}

/** 月ごとのKGI・KPI・進捗をまとめる */
async function loadMonths(sb, plan, today) {
  const { data: months } = await sb.from("gw_growth_months").select("*")
    .eq("plan_id", plan.id).order("month_no");
  if (!months?.length) return [];

  const ids = months.map((m) => m.id);
  const { data: kpis } = await sb.from("gw_growth_kpis").select("*")
    .in("month_id", ids).order("sort_order");

  // 日々の実績。月間KPIに紐づいたものだけ
  const kpiIds = (kpis || []).map((k) => k.id);
  let daily = [];
  if (kpiIds.length) {
    const { data } = await sb.from("gw_daily_kpis")
      .select("kpi_id, work_date, actual").in("kpi_id", kpiIds).limit(4000);
    daily = data || [];
  }

  return months.map((m) => {
    const rows = (kpis || []).filter((k) => k.month_id === m.id);
    const list = rows.map((k) => {
      const p = kpiProgress(k, daily.filter((d) => d.kpi_id === k.id));
      // 今日のぶんの割り当て。いまの月だけ出す
      return m.month === monthStart(today)
        ? { ...p, todayShare: dailyShare(k, p, today), note: k.note }
        : { ...p, note: k.note };
    });
    return { ...shapeMonth(m), kpis: list, progress: monthProgress(list) };
  });
}

/** まだ計画が無い人。入社日が新しい順に出す */
async function withoutPlan(sb, tenantId, plans) {
  const has = new Set(plans.filter((p) => p.status !== "cancelled").map((p) => p.employee_id));
  const { data } = await sb.from("gw_employees")
    .select("id, user_id, display_name, department, joined_on")
    .eq("tenant_id", tenantId).in("status", ["invited", "active"])
    .order("joined_on", { ascending: false, nullsFirst: false }).limit(100);
  return (data || []).filter((e) => !has.has(e.id))
    .map((e) => ({ id: e.id, userId: e.user_id, name: e.display_name, joinedOn: e.joined_on }));
}

// ---- 操作 -------------------------------------------------------------------
async function act(req, res, user, ctx) {
  const body = await readJson(req);
  const sb = admin();

  switch (body.action) {
    case "create":    return create(res, sb, ctx, user, body);
    case "draft":     return runDraft(res, sb, ctx, user, body);
    case "saveKgi":   return saveKgi(res, sb, ctx, body);
    case "saveMonth": return saveMonth(res, sb, ctx, body);
    case "nextMonth": return nextMonth(res, sb, ctx, body);
    case "approve":   return approve(res, sb, ctx, user, body);
    case "review":    return review(res, sb, ctx, user, body);
    default:
      return json(res, 400, {
        error: "invalid_action",
        allowed: ["create", "draft", "saveKgi", "saveMonth", "nextMonth", "approve", "review"],
      });
  }
}

// 計画の枠を作る。期間は労働条件通知書の育成期間から引く
async function create(res, sb, ctx, user, body) {
  const { data: emp } = await sb.from("gw_employees")
    .select("id, user_id, display_name, joined_on")
    .eq("id", body.employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  // 確定済みの労働条件通知書があれば、そこから期間を引く
  const { data: contract } = await sb.from("gw_contracts").select("*")
    .eq("employee_id", emp.id).eq("status", "active")
    .order("period_from", { ascending: false }).limit(1).maybeSingle();

  const start = isDate(body.startDate) ? body.startDate
    : (contract?.period_from || emp.joined_on || jstDate());
  const monthCount = Number(body.months) || contract?.training_months || 3;
  const end = addMonths(start, Math.min(12, Math.max(1, monthCount)));

  // 期間が重なる計画を2つ作らない。どちらのKPIを出すか決められなくなる
  const { data: overlap } = await sb.from("gw_growth_plans").select("id, start_date, end_date")
    .eq("employee_id", emp.id).in("status", ["draft", "active"])
    .lte("start_date", end).gte("end_date", start).limit(1);
  if (overlap?.length) {
    return json(res, 409, {
      error: "overlapping_plan",
      hint: "同じ期間の計画がすでにあります。そちらを直すか、取り消してください。",
    });
  }

  const { data: plan, error } = await sb.from("gw_growth_plans").insert({
    tenant_id: ctx.tenantId,
    employee_id: emp.id,
    user_id: emp.user_id,
    contract_id: contract?.id || null,
    start_date: start,
    end_date: end,
    status: "draft",
    created_by: user.id,
  }).select("*").single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  // 月の枠だけ先に作る。中身（KGI・KPI）はAIか人が入れる
  const rows = monthsOf(start, Math.min(12, Math.max(1, monthCount))).map((m) => {
    const stage = STAGES.find((s) => s.monthNo === m.monthNo);
    return {
      plan_id: plan.id, user_id: emp.user_id,
      month_no: m.monthNo, month: m.month,
      target_level: stage?.level || null,
      status: "planned",
    };
  });
  await sb.from("gw_growth_months").insert(rows);

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "growth.create",
    target: `employee:${emp.display_name}`, detail: { start, end },
  });
  return json(res, 200, { plan: shapePlan(plan) });
}

// AIに3か月ぶんのドラフトを作らせる
async function runDraft(res, sb, ctx, user, body) {
  if (!isConfigured()) {
    return json(res, 503, { error: "not_configured", hint: "AIの鍵が未設定です" });
  }
  const { data: plan } = await sb.from("gw_growth_plans").select("*")
    .eq("id", body.planId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!plan) return json(res, 404, { error: "plan_not_found" });
  if (plan.status !== "draft") {
    return json(res, 409, {
      error: "already_approved",
      hint: "確定済みの計画は作り直せません。月ごとのKGI/KPIは「翌月のドラフト」から直せます。",
    });
  }

  const [{ data: emp }, { data: contract }] = await Promise.all([
    sb.from("gw_employees").select("*").eq("id", plan.employee_id).maybeSingle(),
    plan.contract_id
      ? sb.from("gw_contracts").select("*").eq("id", plan.contract_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  await sb.from("gw_growth_plans").update({
    ai_status: "processing", ai_prompt_version: PROMPT_VERSION,
  }).eq("id", plan.id);

  const r = await draftPlan({
    employee: emp,
    contract: contract || {},
    level: emp?.autonomy_level || 1,
    startDate: plan.start_date,
    endDate: plan.end_date,
  });

  if (!r.ok) {
    await sb.from("gw_growth_plans").update({
      ai_status: "failed", ai_error: String(r.detail || "").slice(0, 500),
    }).eq("id", plan.id);
    return json(res, 502, { error: "ai_failed", hint: "AIが応答しませんでした。少し待ってからもう一度お試しください" });
  }

  // ドラフトをそのまま行に入れる。人はここから直す
  await sb.from("gw_growth_plans").update({
    ai_status: "completed",
    ai_model: r.model,
    ai_draft: r.result,
    ai_error: null,
    three_month_kgi: plan.three_month_kgi || r.result.three_month_kgi,
    note: plan.note || r.result.note,
  }).eq("id", plan.id);

  const { data: months } = await sb.from("gw_growth_months").select("*").eq("plan_id", plan.id);
  for (const m of months || []) {
    const d = r.result.months.find((x) => x.month_no === m.month_no);
    if (!d) continue;
    // 人がすでに書いたKGIは上書きしない
    if (!m.kgi) {
      await sb.from("gw_growth_months")
        .update({ kgi: d.kgi, target_level: d.target_level }).eq("id", m.id);
    }
    // KPIも、既に入っている月には足さない
    const { data: has } = await sb.from("gw_growth_kpis").select("id").eq("month_id", m.id).limit(1);
    if (has?.length) continue;
    if (d.kpis.length) {
      await sb.from("gw_growth_kpis").insert(
        d.kpis.map((k) => ({ ...k, month_id: m.id, user_id: plan.user_id })));
    }
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "growth.draft",
    target: `plan:${plan.id}`, detail: { model: r.model },
  });
  return json(res, 200, { ok: true, draft: r.result });
}

async function saveKgi(res, sb, ctx, body) {
  const { data: plan } = await sb.from("gw_growth_plans").select("id")
    .eq("id", body.planId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!plan) return json(res, 404, { error: "plan_not_found" });

  const { data, error } = await sb.from("gw_growth_plans").update({
    three_month_kgi: String(body.kgi ?? "").trim().slice(0, 1000) || null,
    note: String(body.note ?? "").trim().slice(0, 2000) || null,
    updated_at: new Date().toISOString(),
  }).eq("id", plan.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  return json(res, 200, { plan: shapePlan(data) });
}

// 月間KGIとKPIを確定する。KPIは丸ごと置き換える
async function saveMonth(res, sb, ctx, body) {
  const { data: month } = await sb.from("gw_growth_months")
    .select("*, gw_growth_plans!inner(id, tenant_id, user_id)")
    .eq("id", body.monthId).maybeSingle();
  if (!month || month.gw_growth_plans.tenant_id !== ctx.tenantId) {
    return json(res, 404, { error: "month_not_found" });
  }

  const list = (body.kpis || []).slice(0, 8);
  const rows = [];
  const names = new Set();
  for (const [i, k] of list.entries()) {
    const name = String(k.name ?? "").trim().slice(0, 60);
    if (!name) continue;
    // 同じ名前を2つ置かせない。日々のKPIは名前で1日1行にしているので、
    // 同名があると今日のぶんを作るところで落ちる
    if (names.has(name)) {
      return json(res, 400, {
        error: "duplicate_kpi",
        hint: `「${name}」が2つあります。KPIの名前は重ならないようにしてください。`,
      });
    }
    names.add(name);
    const target = k.target === "" || k.target == null ? null : Number(k.target);
    if (target != null && (!Number.isFinite(target) || target < 0)) {
      return json(res, 400, { error: "invalid_target", hint: "目標は0以上の数字です" });
    }
    const weight = Number(k.weight);
    rows.push({
      month_id: month.id,
      user_id: month.gw_growth_plans.user_id,
      sort_order: i,
      name,
      kind: KIND_KEYS.includes(k.kind) ? k.kind : "number",
      target_value: target,
      unit: String(k.unit ?? "").trim().slice(0, 10) || null,
      weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      from_daily: k.fromDaily !== false,
      manual_value: k.manualValue === "" || k.manualValue == null ? null : Number(k.manualValue),
      note: String(k.note ?? "").trim().slice(0, 300) || null,
    });
  }

  await sb.from("gw_growth_months").update({
    kgi: String(body.kgi ?? "").trim().slice(0, 500) || null,
    target_level: [1, 2, 3, 4].includes(Number(body.targetLevel)) ? Number(body.targetLevel) : null,
    updated_at: new Date().toISOString(),
  }).eq("id", month.id);

  // 消えたKPIを残さない。日々の実績（gw_daily_kpis.kpi_id）は
  // on delete set null なので、記録そのものは消えない
  const { error: de } = await sb.from("gw_growth_kpis").delete().eq("month_id", month.id);
  if (de) return json(res, 500, { error: "db_delete_failed", detail: de.message });
  if (rows.length) {
    const { error } = await sb.from("gw_growth_kpis").insert(rows);
    if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }

  return json(res, 200, { ok: true, kpis: rows.length });
}

// 翌月のドラフト。前の月の実績を見て作る
async function nextMonth(res, sb, ctx, body) {
  if (!isConfigured()) return json(res, 503, { error: "not_configured" });

  const { data: month } = await sb.from("gw_growth_months")
    .select("*, gw_growth_plans!inner(*)").eq("id", body.monthId).maybeSingle();
  if (!month || month.gw_growth_plans.tenant_id !== ctx.tenantId) {
    return json(res, 404, { error: "month_not_found" });
  }
  const plan = month.gw_growth_plans;

  const { data: prev } = await sb.from("gw_growth_months").select("*")
    .eq("plan_id", plan.id).eq("month_no", month.month_no - 1).maybeSingle();

  let prevKpis = [];
  if (prev) {
    const { data: rows } = await sb.from("gw_growth_kpis").select("*")
      .eq("month_id", prev.id).order("sort_order");
    const ids = (rows || []).map((r) => r.id);
    let daily = [];
    if (ids.length) {
      const { data } = await sb.from("gw_daily_kpis")
        .select("kpi_id, work_date, actual").in("kpi_id", ids).limit(2000);
      daily = data || [];
    }
    prevKpis = (rows || []).map((k) => kpiProgress(k, daily.filter((d) => d.kpi_id === k.id)));
  }

  const { data: emp } = await sb.from("gw_employees")
    .select("autonomy_level").eq("id", plan.employee_id).maybeSingle();

  const r = await draftNextMonth({
    plan, month, prevMonth: prev, prevKpis, level: emp?.autonomy_level || 1,
  });
  if (!r.ok) return json(res, 502, { error: "ai_failed", detail: r.detail });

  // ドラフトは返すだけ。保存は人が「確定」を押したとき
  return json(res, 200, { draft: r.result, model: r.model });
}

// 計画を確定する。ここから日々の画面にKPIが出る
async function approve(res, sb, ctx, user, body) {
  const { data: plan } = await sb.from("gw_growth_plans").select("*")
    .eq("id", body.planId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!plan) return json(res, 404, { error: "plan_not_found" });

  if (!plan.three_month_kgi) {
    return json(res, 400, { error: "kgi_required", hint: "3か月KGIを書いてから確定してください" });
  }
  const { data: kpis } = await sb.from("gw_growth_kpis")
    .select("id, gw_growth_months!inner(plan_id)")
    .eq("gw_growth_months.plan_id", plan.id).limit(1);
  if (!kpis?.length) {
    return json(res, 400, { error: "kpi_required", hint: "KPIを1つ以上入れてから確定してください" });
  }

  const { data, error } = await sb.from("gw_growth_plans").update({
    status: "active",
    approved_by: user.id,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", plan.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "growth.approve",
    target: `plan:${plan.id}`, detail: { start: plan.start_date, end: plan.end_date },
  });
  return json(res, 200, { plan: shapePlan(data) });
}

// 月末の振り返り
async function review(res, sb, ctx, user, body) {
  const { data: month } = await sb.from("gw_growth_months")
    .select("*, gw_growth_plans!inner(tenant_id)").eq("id", body.monthId).maybeSingle();
  if (!month || month.gw_growth_plans.tenant_id !== ctx.tenantId) {
    return json(res, 404, { error: "month_not_found" });
  }

  const { data, error } = await sb.from("gw_growth_months").update({
    review_note: String(body.note ?? "").trim().slice(0, 4000) || null,
    status: "reviewed",
    reviewed_by: user.id,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", month.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  return json(res, 200, { month: shapeMonth(data) });
}
