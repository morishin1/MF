// GET   /api/week-goals?weekStart=YYYY-MM-DD  … その週のゴール一覧（管理者）
// POST  /api/week-goals { employeeId, weekStart, ai:"draft" }  … KGIの下書きをAIに作らせる
// POST  /api/week-goals { employeeId, weekStart, kgi, kpis, ... } … 保存
// POST  /api/week-goals { employeeId, weekStart, split:true } … 月〜金の行動に分ける
//
// ■ 何をAIに任せて、何を任せないか
//   週のゴール（KGI・KPI・期限・優先業務）は管理者が決める。
//   AIが出すのは下書きまで。何を目指すかを機械に決めさせない。
//   分ける（週→日）ところだけAIに任せる。
//
// ■ active にするまで本人には出ない
//   作りかけのゴールが朝の画面に出ると、あとで変わったときに混乱する。
//   「メンバーに出す」を押した時点で、その週の行動案も作る。

import { json, readJson, methodNotAllowed } from "../lib/http.js";
import { requireUser } from "../lib/auth.js";
import { gwContext, canManageHr } from "../lib/gw.js";
import { admin } from "../lib/supabase.js";
import { weekStart as mondayOf, isDate } from "../lib/nippo.js";
import { draftWeekGoal, splitToDays, normalizeGoal, aiConfigured } from "../lib/week-plan.js";
import { gwLog } from "../lib/gw-audit.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx) && !ctx.roles.includes("manager")) {
    return json(res, 403, { error: "forbidden", hint: "週のゴールを決められるのは管理者・責任者です" });
  }

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return write(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み取り -----------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const ws = isDate(q.get("weekStart")) ? mondayOf(q.get("weekStart")) : mondayOf(todayJst());

  const sb = admin();
  const [{ data: emps }, { data: goals }, { data: plans }] = await Promise.all([
    sb.from("gw_employees")
      .select("id, display_name, department, initial_role, status")
      .eq("tenant_id", ctx.tenantId).in("status", ["active", "leaving"])
      .order("display_name"),
    sb.from("gw_week_goals").select("*").eq("tenant_id", ctx.tenantId).eq("week_start", ws),
    sb.from("gw_day_plans")
      .select("employee_id, work_date, top_priority, actions, started_at")
      .eq("tenant_id", ctx.tenantId).eq("week_start", ws).order("work_date"),
  ]);

  const goalBy = new Map((goals || []).map((g) => [g.employee_id, g]));
  const planBy = new Map();
  for (const p of plans || []) {
    if (!planBy.has(p.employee_id)) planBy.set(p.employee_id, []);
    planBy.get(p.employee_id).push(p);
  }

  return json(res, 200, {
    weekStart: ws,
    aiReady: aiConfigured(),
    employees: (emps || []).map((e) => ({
      ...e,
      goal: goalBy.get(e.id) || null,
      days: planBy.get(e.id) || [],
    })),
  });
}

// ---- 書き込み -----------------------------------------------------------------
async function write(req, res, ctx, user) {
  const body = await readJson(req);
  const employeeId = body?.employeeId;
  const ws = isDate(body?.weekStart) ? mondayOf(body.weekStart) : mondayOf(todayJst());
  if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

  const sb = admin();
  const { data: emp } = await sb.from("gw_employees")
    .select("id, user_id, display_name, department, initial_role")
    .eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  // --- AIに下書きを作らせる（保存はしない。管理者が直してから保存する）
  if (body.ai === "draft") {
    if (!aiConfigured()) {
      return json(res, 400, { error: "ai_not_configured", hint: "AIの鍵が設定されていません" });
    }
    try {
      const material = await gatherMaterial(sb, emp, ws);
      const r = await draftWeekGoal({ employee: emp, weekStart: ws, ...material });
      return json(res, 200, { draft: r.goal, model: r.model });
    } catch (e) {
      return json(res, 502, { error: "ai_failed", detail: String(e?.message || e).slice(0, 300) });
    }
  }

  // --- 月〜金の行動に分ける
  if (body.split) {
    const { data: goal } = await sb.from("gw_week_goals")
      .select("*").eq("employee_id", employeeId).eq("week_start", ws).maybeSingle();
    if (!goal?.kgi) {
      return json(res, 400, { error: "no_goal", hint: "先に今週のKGIを保存してください" });
    }
    if (!aiConfigured()) {
      return json(res, 400, { error: "ai_not_configured", hint: "AIの鍵が設定されていません" });
    }

    const dates = workdaysOfWeek(ws, await workdaysOf(sb, employeeId));
    try {
      const r = await splitToDays({ employee: emp, goal, dates });
      const rows = r.days.map((d) => ({
        tenant_id: ctx.tenantId,
        employee_id: employeeId,
        user_id: emp.user_id || null,
        work_date: d.work_date,
        week_start: ws,
        success_line: d.success_line,
        top_priority: d.top_priority,
        actions: d.actions,
        focus: d.focus,
        source: "week_goal",
        ai_model: r.model,
        updated_at: new Date().toISOString(),
      }));
      // すでに本人が始めた日は上書きしない。
      // 走り出したあとに今日の行動が変わると、何を基準に夜を書くのか分からなくなる
      const { data: started } = await sb.from("gw_day_plans")
        .select("work_date").eq("employee_id", employeeId).eq("week_start", ws)
        .not("started_at", "is", null);
      const lock = new Set((started || []).map((s) => s.work_date));
      const toWrite = rows.filter((r2) => !lock.has(r2.work_date));

      if (toWrite.length) {
        const { error } = await sb.from("gw_day_plans")
          .upsert(toWrite, { onConflict: "employee_id,work_date" });
        if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });
      }
      await sb.from("gw_week_goals")
        .update({ status: "active", ai_model: r.model, updated_at: new Date().toISOString() })
        .eq("id", goal.id);

      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id,
        action: "week_goal.split", target: `employee:${employeeId}`,
        detail: { week_start: ws, days: toWrite.length, kept: lock.size },
      });
      return json(res, 200, { ok: true, days: toWrite.length, kept: [...lock] });
    } catch (e) {
      return json(res, 502, { error: "ai_failed", detail: String(e?.message || e).slice(0, 300) });
    }
  }

  // --- 保存
  const g = normalizeGoal(body);
  const { data: saved, error } = await sb.from("gw_week_goals").upsert({
    tenant_id: ctx.tenantId,
    employee_id: employeeId,
    week_start: ws,
    kgi: g.kgi,
    kpis: g.kpis,
    deadline: g.deadline,
    priority_work: g.priority_work,
    note: g.note,
    created_by: user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "employee_id,week_start" }).select("*").single();
  if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });

  return json(res, 200, { goal: saved });
}

// ---- 材料あつめ ---------------------------------------------------------------

// 先週のゴールと、その週に実際どうだったか。今週を決める手がかりにする
async function gatherMaterial(sb, emp, ws) {
  const prev = shiftDays(ws, -7);
  const [{ data: last }, { data: nippos }, { data: plan }] = await Promise.all([
    sb.from("gw_week_goals").select("kgi, kpis, priority_work")
      .eq("employee_id", emp.id).eq("week_start", prev).maybeSingle(),
    emp.user_id
      ? sb.from("tc_nippo").select("work_date, top_priority, work_items")
          .eq("user_id", emp.user_id).gte("work_date", prev).lt("work_date", ws)
          .order("work_date")
      : Promise.resolve({ data: [] }),
    sb.from("gw_growth_plans").select("three_month_kgi")
      .eq("employee_id", emp.id).eq("status", "active")
      .order("created_at", { ascending: false }).limit(1),
  ]);

  const lines = [];
  if (last?.kgi) lines.push(`先週のKGI：${last.kgi}`);
  for (const n of nippos || []) {
    const items = (n.work_items || []).filter((w) => w.task);
    if (!items.length) continue;
    lines.push(`${n.work_date}：` + items
      .map((w) => `${w.task}${w.actual != null ? `（実績 ${w.actual}）` : ""}`
        + (w.result ? "→できた" : w.undone_reason ? `→未達（${w.undone_reason}）` : ""))
      .join(" / "));
  }

  return {
    lastWeek: lines.join("\n") || null,
    growthPlan: plan?.[0]?.three_month_kgi || null,
    monthKgi: null,
  };
}

// その週の勤務日。既定は月〜金
function workdaysOfWeek(ws, days) {
  const list = (Array.isArray(days) && days.length ? days : [1, 2, 3, 4, 5])
    .map(Number).filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  return list.map((d) => shiftDays(ws, d - 1));
}

async function workdaysOf(sb, employeeId) {
  const { data } = await sb.from("gw_reminder_prefs")
    .select("workdays").eq("employee_id", employeeId).maybeSingle();
  return data?.workdays || null;
}

function shiftDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
