// GET /api/tasks/board?date=YYYY-MM-DD[&department=…][&employeeId=…][&state=done|warn|working][&ai=1]
//
// 管理者が「誰が何をしていて、誰が止まっているか」を1枚で見るためのもの。
//
// ■ 出すのは3つだけ
//   今日の3件と完了数／明日の3件の状態／止まっていること。
//   個々のタスクの中身は、その人を開いたときだけ（api/tasks/focus.js）。
//   一覧に全部出すと、毎日見るには重すぎて、結局誰も見なくなる。
//
// ■ 数字の意味を1つにする
//   完了数の分母は「その日に決めた重要タスクの数」。
//   積んであるタスクの総数ではない。3件終われば 3/3 で終わり。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { boardSummary, nextFocusDate, jstToday, focusRows } from "../../lib/focus.js";

const SQL = "db/072_focus_tasks.sql";
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const q = new URL(req.url, "http://localhost").searchParams;
  const date = isDate(q.get("date")) ? q.get("date") : jstToday();
  const tomorrow = nextFocusDate(date);
  const sb = admin();

  const { data: emps, error } = await sb.from("gw_employees")
    .select("id, display_name, department, position, status")
    .eq("tenant_id", ctx.tenantId).in("status", ["active", "invited"])
    .order("department").order("display_name").limit(300);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  const ids = (emps || []).map((e) => e.id);
  if (!ids.length) return json(res, 200, { date, tomorrow, rows: [], summary: boardSummary([]), departments: [] });

  const [days, tasks] = await Promise.all([
    sb.from("gw_focus_days").select("employee_id, focus_date, status, ai, confirmed_at")
      .eq("tenant_id", ctx.tenantId).in("focus_date", [date, tomorrow].filter(Boolean)).limit(1000),
    sb.from("gw_tasks")
      .select("id, title, assignee_id, focus_for, focus_date, focus_rank, status, due_on, priority, "
            + "done_condition, ai_review, carry_count")
      .eq("tenant_id", ctx.tenantId).in("focus_date", [date, tomorrow].filter(Boolean))
      .limit(2000),
  ]);
  if (days.error || tasks.error) {
    const e = days.error || tasks.error;
    const hint = dbSetupHint(e, SQL) || (/focus_date|gw_focus_days/.test(e.message) ? `${SQL} をまだ流していません` : null);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: e.message });
  }

  // 1人1行（lib/focus.js。経営のメンバー実行状況も同じ関数で作る）
  let rows = focusRows({ emps: emps || [], days: days.data || [], tasks: tasks.data || [], date, tomorrow })
    .map(({ _today, _tomorrow, ...r }) => r);

  // ---- 絞り込み ----
  const dep = q.get("department");
  if (dep) rows = rows.filter((r) => (r.department || "") === dep);
  if (q.get("employeeId")) rows = rows.filter((r) => r.employeeId === q.get("employeeId"));
  if (q.get("state")) rows = rows.filter((r) => r.state === q.get("state"));
  if (q.get("ai") === "1") rows = rows.filter((r) => r.hasAi);
  // 完了・未完了で絞る（今日ぶん）
  if (q.get("done") === "1") rows = rows.filter((r) => r.today.allDone);
  if (q.get("done") === "0") rows = rows.filter((r) => !r.today.allDone);

  // 止まっている人を上に。毎日見る画面なので、探させない
  const order = { warn: 0, working: 1, done: 2 };
  rows.sort((a, b) => (order[a.state] - order[b.state])
    || String(a.department || "").localeCompare(String(b.department || ""))
    || String(a.name).localeCompare(String(b.name)));

  return json(res, 200, {
    date, tomorrow,
    rows,
    summary: boardSummary(rows),
    departments: [...new Set((emps || []).map((e) => e.department).filter(Boolean))].sort(),
    people: (emps || []).map((e) => ({ id: e.id, name: e.display_name, department: e.department || null })),
    states: [
      { key: "warn", label: "注意" },
      { key: "working", label: "進行中" },
      { key: "done", label: "完了" },
    ],
  });
}
