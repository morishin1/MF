// 経営者専用：日報PREP形式MD出力、ローカルAIの結果の下書き・公開。
// service_role で読むのは requireKeiei が owner を認証した後だけ。
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireKeiei } from "../../lib/keiei-gate.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { readIn } from "../../lib/pg-read.js";
import { rosterOf } from "../../lib/member-exec-read.js";
import { jstDate, weekStart } from "../../lib/nippo.js";
import { buildWeeklyPrepMarkdown } from "../../lib/weekly-prep-report.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ["conclusion", "reason", "evidence", "recommendation", "good_points", "improvement_points", "next_actions"];
const iso = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const dayPlus = (str, n) => {
  const d = new Date(str + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export function parsePrepPeriod(q, today = jstDate()) {
  const from = q.get("from") || weekStart(today);
  const to = q.get("to") || dayPlus(weekStart(today), 6);
  if (!iso(from) || !iso(to)) return { error: "期間の日付を確認してください" };
  const length = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000 + 1;
  if (length < 1 || length > 35) return { error: "対象期間は1〜35日で指定してください" };
  // 当週末までは週単位の公開期間として指定可。未来の週は不可。
  if (from > today || to > dayPlus(weekStart(today), 6)) return { error: "未来の週は選択できません" };
  return { from, to };
}
const shape = (r) => r ? ({
  periodStart: r.period_start, periodEnd: r.period_end, status: r.status,
  conclusion: r.conclusion || "", reason: r.reason || "", evidence: r.evidence || "",
  recommendation: r.recommendation || "", goodPoints: r.good_points || "",
  improvementPoints: r.improvement_points || "", nextActions: r.next_actions || "",
  updatedAt: r.updated_at || null, publishedAt: r.published_at || null,
}) : null;
const fail = (res, message) => json(res, 503, { error: "weekly_prep_unavailable", hint: message });
const columns = "id,user_id,work_date,submitted_at,goal_today,kgi_target,kgi_actual,kgi_achieved,work_items,issues,consult_note,improved_note,improve_tags,wins,tomorrow_plan,good_things,result_today,struggle,challenge";

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);
  const auth = await requireKeiei(req, res);
  if (!auth) return;
  res.setHeader("Cache-Control", "private, no-store");
  const { user, ctx } = auth;
  const q = new URL(req.url, "http://localhost").searchParams;
  const body = req.method === "POST" ? await readJson(req) : null;
  const periodParams = req.method === "POST"
    ? new URLSearchParams({ from: String(body?.from || ""), to: String(body?.to || "") })
    : q;
  const period = parsePrepPeriod(periodParams);
  if (period.error) return json(res, 400, { error: "invalid_period", hint: period.error });

  const sb = admin();
  const roster = await rosterOf(sb, ctx.tenantId);
  if (roster === null) return fail(res, "対象社員の名簿を取得できませんでした");
  const employeeId = req.method === "POST" ? body?.employeeId : q.get("employeeId");
  const scope = q.get("scope") || "member";
  if (req.method === "GET" && q.get("mode") === "export" && scope === "all") {
    return exportMd(res, sb, roster, period, null);
  }
  if (!ID.test(String(employeeId || ""))) return json(res, 400, { error: "invalid_employee", hint: "対象社員を選んでください" });
  const employee = roster.find((e) => e.id === employeeId);
  if (!employee) return json(res, 404, { error: "employee_not_found" });

  if (req.method === "GET" && q.get("mode") === "export") {
    return exportMd(res, sb, roster, period, employee);
  }
  if (req.method === "GET") {
    const { data, error } = await sb.from("gw_weekly_prep_feedback").select("*")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", employee.id)
      .eq("period_start", period.from).eq("period_end", period.to).order("status");
    if (error) return fail(res, "週次フィードバックの保存先を確認してください");
    return json(res, 200, {
      from: period.from, to: period.to, employeeId: employee.id,
      draft: shape((data || []).find((x) => x.status === "draft")),
      published: shape((data || []).find((x) => x.status === "published")),
    });
  }
  const action = String(body?.action || "");
  if (!["save", "publish", "withdraw"].includes(action)) return json(res, 400, { error: "invalid_action" });
  if (action === "withdraw") {
    const { error } = await sb.from("gw_weekly_prep_feedback").delete()
      .eq("tenant_id", ctx.tenantId).eq("employee_id", employee.id)
      .eq("period_start", period.from).eq("period_end", period.to).eq("status", "published");
    if (error) return fail(res, "公開の取り消しができませんでした");
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "weekly_prep.withdraw",
      target: "employee:" + employee.id, detail: { from: period.from, to: period.to } });
    return json(res, 200, { ok: true, status: "withdrawn" });
  }
  const clean = {};
  for (const f of FIELDS) {
    const raw = body?.[f];
    if (typeof raw !== "string" || raw.length > 6000)
      return json(res, 400, { error: "invalid_field", hint: "入力文は各欄6,000文字以内で指定してください", field: f });
    clean[f] = raw.trim();
  }
  if (action === "publish" && (!clean.good_points || !clean.improvement_points || !clean.next_actions))
    return json(res, 400, { error: "feedback_incomplete", hint: "公開には「良かった点・改善点・来週の行動」が必要です" });
  const now = new Date().toISOString();
  const status = action === "save" ? "draft" : "published";
  const { data, error } = await sb.from("gw_weekly_prep_feedback").upsert({
    tenant_id: ctx.tenantId, employee_id: employee.id, period_start: period.from, period_end: period.to,
    status, ...clean, created_by: user.id, updated_by: user.id, updated_at: now,
    published_at: status === "published" ? now : null,
  }, { onConflict: "tenant_id,employee_id,period_start,period_end,status" }).select("*").single();
  if (error) return fail(res, "週次フィードバックを保存できませんでした");
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "weekly_prep." + action,
    target: "employee:" + employee.id, detail: { from: period.from, to: period.to } });
  return json(res, 200, { ok: true, feedback: shape(data) });
}

async function exportMd(res, sb, roster, period, selected) {
  const employees = selected ? [selected] : roster;
  const ids = employees.map((e) => e.user_id).filter(Boolean);
  if (!ids.length) return json(res, 200, {
    filename: `weekly-prep_${period.from}_${period.to}.md`,
    markdown: "# 分析対象日報なし\n対象社員が存在しません。\n",
  });
  const reviewFrom = weekStart(period.from), reviewTo = weekStart(period.to);
  const prevStart = dayPlus(reviewFrom, -7);
  const [daily, reviews, previousReviews] = await Promise.all([
    readIn((part) => sb.from("tc_nippo").select(columns).in("user_id", part)
      .gte("work_date", period.from).lte("work_date", period.to)
      .not("submitted_at", "is", null).order("work_date").order("id"), ids),
    readIn((part) => sb.from("tc_weekly_review").select("id,user_id,week_start,q1,q2,q3,q4")
      .in("user_id", part).gte("week_start", reviewFrom).lte("week_start", reviewTo)
      .order("week_start").order("id"), ids),
    readIn((part) => sb.from("tc_weekly_review").select("id,user_id,week_start,q1,q2,q3,q4")
      .in("user_id", part).eq("week_start", prevStart).order("id"), ids),
  ]);
  if (!daily || !reviews || !previousReviews) return fail(res, "日報の記録を取得できませんでした");
  const markdown = buildWeeklyPrepMarkdown({
    from: period.from, to: period.to, employees, nippos: daily, reviews, previousReviews,
  });
  const suffix = selected ? selected.id.slice(0, 8) : "all";
  return json(res, 200, {
    filename: `eight_nippo_PREP_${period.from}_${period.to}_${suffix}.md`,
    markdown,
    count: { employees: employees.length, reports: daily.length, reviews: reviews.length },
  });
}
