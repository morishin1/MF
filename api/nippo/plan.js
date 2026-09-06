// GET  /api/nippo/plan?date=YYYY-MM-DD  … 今日の行動案（本人）
// POST /api/nippo/plan { date, blocked, blockedNote } … 「今日を始める」
// POST /api/nippo/plan { date, next:true } … 明日の行動案を作り直す（夜の提出後）
//
// ■ 本人は考えない
//   何をやるかは、週のゴールから割ってある（gw_day_plans）。
//   本人がやるのは「今日を始める」を押すことと、夜に結果を返すことだけ。
//
// ■ 押した時点で、これまでの朝の日報になる
//   案を tc_nippo に写す（top_priority / goal_image / work_items）。
//   夜の日報も、週次も、AI評価も、これまでの仕組みがそのまま動く。
//   新しい表を作って別系統にすると、過去とつながらなくなる。
//
// ■ 案が無い日
//   管理者が週のゴールを出していない、AIの鍵が無い、などのとき。
//   その場合は「案はありません」を返す。画面はこれまでの手入力に戻る。
//   声かけの仕組みだけ動いて、書くものが無い、を避ける。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { jstDate, isDate, weekStart } from "../../lib/nippo.js";
import { nextDayPlan, aiConfigured } from "../../lib/week-plan.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "no_employee" });

  if (req.method === "GET") return read(req, res, user, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    if (body?.next) return makeNext(res, user, ctx, body);
    return start(res, user, ctx, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 今日の案 -----------------------------------------------------------------
async function read(req, res, user, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const date = isDate(q.get("date")) ? q.get("date") : jstDate();

  const sb = admin();
  const [{ data: plan }, { data: goal }] = await Promise.all([
    sb.from("gw_day_plans").select("*")
      .eq("employee_id", ctx.employee.id).eq("work_date", date).maybeSingle(),
    sb.from("gw_week_goals").select("kgi, kpis, deadline, priority_work, note, status")
      .eq("employee_id", ctx.employee.id).eq("week_start", weekStart(date)).maybeSingle(),
  ]);

  return json(res, 200, {
    date,
    // 作りかけのゴールは本人に出さない
    goal: goal?.status === "active" ? goal : null,
    plan: plan || null,
    started: !!plan?.started_at,
  });
}

// ---- 今日を始める -------------------------------------------------------------
//
// 案をそのまま朝の日報にする。本人が押した時刻を残すのは、
// 「案が出ていたのに走り出していない」を後から見分けるため
async function start(res, user, ctx, body) {
  const date = isDate(body?.date) ? body.date : jstDate();
  if (date > jstDate()) return json(res, 400, { error: "future_date" });

  const sb = admin();
  const { data: plan } = await sb.from("gw_day_plans").select("*")
    .eq("employee_id", ctx.employee.id).eq("work_date", date).maybeSingle();
  if (!plan) {
    return json(res, 404, {
      error: "no_plan",
      hint: "今日の行動案がまだありません。管理者に今週のゴールを出してもらってください",
    });
  }

  const now = new Date().toISOString();
  const items = (plan.actions || []).slice(0, 3).map((a) => ({
    task: a.task,
    target: a.target ?? null,
    unit: a.unit || null,
    done_when: a.done_when || null,
  }));

  // 朝の日報。これまでと同じ形で入れる
  const row = {
    user_id: user.id,
    user_name: ctx.employee.display_name,
    employ_type: ctx.employee.employment_type || null,
    work_date: date,
    top_priority: plan.top_priority || null,
    goal_image: plan.success_line || null,
    work_items: items,
    // 止まりそうなことは「あり」のときだけ中身を持つ。
    // 毎朝の自由記述にすると、書くこと自体が仕事になる
    morning_note: body?.blocked ? String(body?.blockedNote || "").trim().slice(0, 300) || "あり" : null,
    morning_at: now,
    updated_at: now,
  };

  const { data: existing } = await sb.from("tc_nippo")
    .select("id, morning_at").eq("user_id", user.id).eq("work_date", date).maybeSingle();

  if (existing) {
    // 2回目以降は morning_at を動かさない。最初に走り出した時刻を残す
    if (existing.morning_at) delete row.morning_at;
    const { error } = await sb.from("tc_nippo").update(row).eq("id", existing.id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  } else {
    const { error } = await sb.from("tc_nippo").insert(row);
    if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }

  await sb.from("gw_day_plans")
    .update({ started_at: plan.started_at || now, updated_at: now })
    .eq("id", plan.id);

  return json(res, 200, { ok: true, date, items: items.length });
}

// ---- 明日の案を作り直す -------------------------------------------------------
//
// 夜の日報を出したあとに呼ぶ。今日の結果と週の残りを見て配り直す。
// 失敗しても日報の提出は成立しているので、ここは「できなかった」で返すだけ
async function makeNext(res, user, ctx, body) {
  const date = isDate(body?.date) ? body.date : jstDate();
  if (!aiConfigured()) return json(res, 200, { ok: false, reason: "ai_not_configured" });

  const sb = admin();
  const ws = weekStart(date);
  const { data: goal } = await sb.from("gw_week_goals").select("*")
    .eq("employee_id", ctx.employee.id).eq("week_start", ws).maybeSingle();
  if (!goal?.kgi || goal.status !== "active") return json(res, 200, { ok: false, reason: "no_goal" });

  // 明日の案がある日だけ作り直す。
  // 週の最終日なら明日は無い（次の週のゴールは管理者が決める）
  const next = shiftDays(date, 1);
  const { data: nextPlan } = await sb.from("gw_day_plans").select("id, started_at, week_start")
    .eq("employee_id", ctx.employee.id).eq("work_date", next).maybeSingle();
  if (!nextPlan) return json(res, 200, { ok: false, reason: "no_next_day" });
  if (nextPlan.started_at) return json(res, 200, { ok: false, reason: "already_started" });

  const { data: nippos } = await sb.from("tc_nippo")
    .select("work_date, top_priority, work_items")
    .eq("user_id", user.id).gte("work_date", ws).lte("work_date", date).order("work_date");

  const line = (n) => (n.work_items || []).filter((w) => w.task)
    .map((w) => `${w.task}`
      + (w.target != null ? `（目標 ${w.target}${w.unit || ""}）` : "")
      + (w.actual != null ? ` 実績 ${w.actual}` : "")
      + (w.result ? " →できた" : w.undone_reason ? ` →未達（${w.undone_reason}）` : " →未記入"))
    .join(" / ");

  const today = (nippos || []).find((n) => n.work_date === date);

  try {
    const r = await nextDayPlan({
      employee: ctx.employee,
      goal,
      date: next,
      todayResult: today ? line(today) : null,
      weekSoFar: (nippos || []).map((n) => `${n.work_date}：${line(n)}`).join("\n") || null,
    });
    if (!r.day) return json(res, 200, { ok: false, reason: "ai_empty" });

    const { error } = await sb.from("gw_day_plans").update({
      success_line: r.day.success_line,
      top_priority: r.day.top_priority,
      actions: r.day.actions,
      focus: r.day.focus,
      source: "carry_over",
      ai_model: r.model,
      updated_at: new Date().toISOString(),
    }).eq("id", nextPlan.id);
    if (error) return json(res, 200, { ok: false, reason: error.message });

    return json(res, 200, { ok: true, date: next });
  } catch (e) {
    console.error("[nippo/plan] 明日の案を作れませんでした:", e?.message || e);
    return json(res, 200, { ok: false, reason: "ai_failed" });
  }
}

function shiftDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
