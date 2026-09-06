// GET  /api/nippo/monthly?month=YYYY-MM&userId=… … その月の集計と、いまの総括
// POST /api/nippo/monthly {month, userId, action}
//        action="summarize" … AIに月次の総括を書かせる
//        action="save"      … 管理者コメントを保存する
//        action="submit"    … 本人へ提出する
//
// 月次は「評価」ではなく「成長確認」。
// 点数は週次で確定しているので、ここでは集計と前月比、そして
// 「何が伸びて、次の月に何をするか」を出す。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate } from "../../lib/nippo.js";
import { CRITERIA } from "../../lib/nippo-eval.js";
import {
  monthlyMetrics, summarizeMonth, monthStart, isConfigured, MONTHLY_PROMPT_VERSION,
} from "../../lib/nippo-period.js";

const canReview = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);
const isMonth = (s) => /^\d{4}-\d{2}$/.test(String(s || ""));

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  if (req.method === "GET") return read(req, res, ctx, user);
  if (req.method === "POST") {
    if (!canReview(ctx)) return json(res, 403, { error: "forbidden" });
    return act(req, res, ctx, user);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

/** その月の平日数。土日は分母に入れない（祝日までは見ていない） */
function workdaysIn(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let n = 0;
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

const range = (month) => {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
};

const prevMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

async function gather(sb, userId, month) {
  const [from, to] = range(month);
  const [pf, pt] = range(prevMonth(month));

  const [{ data: weeks }, { data: prevWeeks }, { data: nippos }, { data: row }] = await Promise.all([
    sb.from("tc_weekly_review").select("*")
      .eq("user_id", userId).gte("week_start", from).lte("week_start", to).order("week_start"),
    sb.from("tc_weekly_review").select("eval_total, ai_total")
      .eq("user_id", userId).gte("week_start", pf).lte("week_start", pt),
    sb.from("tc_nippo").select("work_date, kgi_achieved, work_items")
      .eq("user_id", userId).gte("work_date", from).lte("work_date", to),
    sb.from("gw_nippo_monthly").select("*")
      .eq("user_id", userId).eq("month", monthStart(from)).maybeSingle(),
  ]);

  return {
    weeks: weeks || [],
    prevWeeks: prevWeeks || [],
    nippos: nippos || [],
    row: row || null,
    workdays: workdaysIn(month),
  };
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res, ctx, user) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const month = isMonth(q.get("month")) ? q.get("month") : jstDate().slice(0, 7);
  const userId = q.get("userId") || user.id;

  // 本人以外を見るのは管理者だけ
  if (userId !== user.id && !canReview(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = admin();
  const { weeks, prevWeeks, nippos, row, workdays } = await gather(sb, userId, month);
  const metrics = monthlyMetrics({ month, weeks, prevWeeks, nippos, workdays });

  // 本人には、提出されたものだけ見せる
  const mine = userId === user.id && !canReview(ctx);
  const summary = (!mine || row?.submitted_at) ? shape(row) : null;

  // できるようになったことの積み上げ。月が変わっても消えないので、
  // その月ぶんだけでなく、これまでのぶんを全部出す（§27）
  const { data: growth } = await sb.from("gw_growth_history")
    .select("happened_on, title, evidence, source")
    .eq("user_id", userId).order("happened_on", { ascending: false }).limit(60);

  return json(res, 200, {
    month, userId, metrics, criteria: CRITERIA,
    summary,
    growth: growth || [],
    // 週ごとの推移。グラフに使う
    trend: weeks.map((w) => ({
      weekStart: w.week_start,
      total: w.eval_total ?? w.ai_total ?? null,
      submitted: !!w.submitted_at,
    })),
    aiConfigured: isConfigured(),
    canReview: canReview(ctx),
  });
}

// ---- 操作 -------------------------------------------------------------------
async function act(req, res, ctx, user) {
  const body = await readJson(req);
  const month = isMonth(body?.month) ? body.month : jstDate().slice(0, 7);
  if (!body?.userId) return json(res, 400, { error: "invalid_body", required: ["userId"] });

  const sb = admin();
  const { data: emp } = await sb.from("gw_employees")
    .select("display_name").eq("user_id", body.userId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  const { weeks, prevWeeks, nippos, workdays } = await gather(sb, body.userId, month);
  const metrics = monthlyMetrics({ month, weeks, prevWeeks, nippos, workdays });

  if (body.action === "summarize") {
    if (!isConfigured()) {
      return json(res, 503, { error: "not_configured", hint: "AI評価の鍵が未設定です" });
    }
    if (!weeks.length) {
      return json(res, 400, { error: "no_weeks", hint: "この月の週次評価がまだありません" });
    }

    await upsert(sb, body.userId, month, emp, {
      ai_status: "processing", ai_prompt_version: MONTHLY_PROMPT_VERSION, metrics,
    });

    // 「先月までできなかった」を判断するには、先月の記録が要る。
    // 渡さないと learned は毎月同じことを書きがちになる
    const { data: prevMonth } = await sb.from("gw_nippo_monthly")
      .select("ai_learned, ai_summary")
      .eq("user_id", body.userId).lt("month", `${month}-01`)
      .order("month", { ascending: false }).limit(1).maybeSingle();

    const r = await summarizeMonth({
      metrics, weeks,
      prevMonth: prevMonth ? { learned: prevMonth.ai_learned || [] } : null,
    });
    const patch = r.ok
      ? {
          ai_status: "completed",
          ai_model: r.model,
          ai_summary: r.result.summary,
          ai_strengths: r.result.strengths,
          ai_improvements: r.result.improvements,
          ai_learned: r.result.learned || [],
          ai_error: null,
          ai_generated_at: new Date().toISOString(),
          metrics,
        }
      : { ai_status: "failed", ai_error: String(r.detail || "").slice(0, 500), metrics };

    const saved = await upsert(sb, body.userId, month, emp, patch);
    if (!r.ok) {
      return json(res, 502, { summary: shape(saved), error: "ai_failed", hint: "AIが応答しませんでした" });
    }

    // できるようになったことを積み上げる（要件定義 §27「デキル履歴」）。
    // 点数は月が変われば消えるが、これは消えない。
    // 作り直しても増えないよう、(本人, 月, 内容) で一意にしてある
    for (const title of r.result.learned || []) {
      const { error } = await sb.from("gw_growth_history").insert({
        user_id: body.userId,
        happened_on: `${month}-01`,
        title: String(title).slice(0, 300),
        evidence: r.result.summary ? String(r.result.summary).slice(0, 1000) : null,
        source: "monthly",
        source_ref: month,
        created_by: user.id,
      });
      // 23505 = 同じものが既にある。作り直しただけなので黙って進む
      if (error && error.code !== "23505") {
        console.error("[monthly] デキル履歴を残せませんでした:", error.message);
      }
    }

    return json(res, 200, { summary: shape(saved), metrics });
  }

  if (body.action === "save" || body.action === "submit") {
    const patch = {
      manager_comment: String(body.comment ?? "").trim().slice(0, 4000) || null,
      decided_by: user.id,
      metrics,
      updated_at: new Date().toISOString(),
    };
    if (body.action === "submit") patch.submitted_at = new Date().toISOString();

    const saved = await upsert(sb, body.userId, month, emp, patch);
    if (body.action === "submit") {
      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id, action: "nippo.monthly_submit",
        target: `employee:${emp.display_name}`, detail: { month, avg: metrics.avgScore },
      });
    }
    return json(res, 200, { summary: shape(saved), metrics });
  }

  return json(res, 400, { error: "unknown_action" });
}

async function upsert(sb, userId, month, emp, patch) {
  const { data, error } = await sb.from("gw_nippo_monthly").upsert({
    user_id: userId,
    month: monthStart(`${month}-01`),
    user_name: emp.display_name,
    ...patch,
  }, { onConflict: "user_id,month" }).select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

function shape(r) {
  if (!r) return null;
  return {
    month: r.month,
    userName: r.user_name,
    aiStatus: r.ai_status,
    aiSummary: r.ai_summary,
    aiStrengths: r.ai_strengths || [],
    aiImprovements: r.ai_improvements || [],
    aiLearned: r.ai_learned || [],
    aiModel: r.ai_model,
    aiError: r.ai_error,
    managerComment: r.manager_comment,
    submittedAt: r.submitted_at,
    metrics: r.metrics,
  };
}
