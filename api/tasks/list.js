// GET /api/tasks/list?range=today|tomorrow|week|month|all&assigneeId=…&department=…
//                     &service=…&priority=…&status=…&ai=1&overdue=1&q=…
//
// 一覧は「探す場所」。1件ずつ短い行で、たくさん並べる。
//
// ■ 中身は返さない
//   目的・完了条件・コメント・履歴は、行を押して引き出しを開いたときだけ
//   （api/tasks/detail.js）。一覧に全部載せると、毎日見るには重すぎる。
//
// ■ 見える範囲
//   一般メンバー … 自分が担当のものと、自分が頼んだもの
//   管理者・人事 … 全員ぶん。担当者を自由に切り替えられる
//
// ■ 上の数は、絞り込みの影響を受けない
//   一覧を絞っても、会社の状況（期限超過が何件あるか）は変わらない。
//   絞り込むたびに数字が動くと、その数字を覚えていられなくなる。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import {
  RANGES, PRIORITIES, STATUSES, BADGES, rowOf, applyFilters, kpiOf, sortRows,
} from "../../lib/task-view.js";
import { nextFocusDate, jstToday } from "../../lib/focus.js";

const SQL = "db/072_focus_tasks.sql → 073_task_detail.sql";
const MAX = 500;

// 072 / 073 で足した列。無い環境では落として引き直す
const BASE = "id, title, assignee_id, due_on, priority, status, category, "
  + "accepted_at, completed_at, created_by, created_at, updated_at";
const WITH_NEW = `${BASE}, focus_date, focus_rank, ai_review, ai_assignee, carry_count, kpi_link, service`;

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "no_employee", hint: "社員名簿にあなたの行がありません" });

  const q = new URL(req.url, "http://localhost").searchParams;
  const manage = canManageHr(ctx);
  const sb = admin();
  const today = jstToday();
  const tomorrow = nextFocusDate(today);

  // ---- 名簿 ----
  const { data: emps } = await sb.from("gw_employees")
    .select("id, display_name, department, user_id")
    .eq("tenant_id", ctx.tenantId).in("status", ["active", "invited"])
    .order("display_name").limit(300);
  const names = new Map((emps || []).map((e) =>
    [e.id, { name: e.display_name, department: e.department || null }]));

  // ---- タスク ----
  const build = (cols) => {
    let sel = sb.from("gw_tasks").select(cols)
      .eq("tenant_id", ctx.tenantId)
      .neq("status", "cancelled")
      .order("due_on", { ascending: true, nullsFirst: false })
      .limit(MAX);
    // 一般メンバーは、自分が担当のものと、自分が頼んだものだけ
    if (!manage) sel = sel.or(`assignee_id.eq.${ctx.employee.id},created_by.eq.${user.id}`);
    return sel;
  };
  let { data, error } = await build(WITH_NEW);
  let legacy = false;
  if (error) {
    ({ data, error } = await build(BASE));
    legacy = true;
  }
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  // 繰り返しの「元」は、やる仕事ではない。一覧から外す
  const raw = (data || []).filter((t) => !t.is_template);

  const rows = raw.map((t) => rowOf({
    ...t,
    // 「未確認の依頼」を出すのは、人から頼まれたものだけ
    requested_by_other: Boolean(t.created_by && t.created_by !== user.id),
  }, { today, names }));

  // ---- 明日ぶんの状態（上の数に使う） ----
  let focusDays = [];
  if (!legacy && tomorrow) {
    const { data: fd } = await sb.from("gw_focus_days")
      .select("employee_id, focus_date, status")
      .eq("tenant_id", ctx.tenantId).eq("focus_date", tomorrow).limit(300);
    focusDays = fd || [];
  }

  const people = manage
    ? (emps || []).map((e) => ({ id: e.id, name: e.display_name, department: e.department || null }))
    : [{ id: ctx.employee.id, name: ctx.employee.display_name, department: ctx.employee.department || null }];

  const filters = {
    range: q.get("range") || "all",
    assigneeId: manage ? (q.get("assigneeId") || null) : ctx.employee.id,
    department: q.get("department") || null,
    service: q.get("service") || null,
    priority: q.get("priority") || null,
    status: q.get("status") || null,
    ai: q.get("ai") === "1",
    overdue: q.get("overdue") === "1",
    q: q.get("q") || "",
  };
  const shown = sortRows(applyFilters(rows, filters, { today, tomorrow }), today);

  return json(res, 200, {
    today, tomorrow,
    // 数は、絞り込む前のもので出す
    kpi: kpiOf(rows.filter((r) => manage || r.assigneeId === ctx.employee.id),
               { today, tomorrow, focusDays, people }),
    rows: shown,
    total: rows.length,
    // 画面の組み立てはサーバの定義から。同じ一覧を2か所に書かない
    ranges: RANGES,
    priorities: PRIORITIES,
    statuses: STATUSES,
    badges: BADGES,
    people,
    departments: [...new Set((emps || []).map((e) => e.department).filter(Boolean))].sort(),
    services: [...new Set(rows.map((r) => r.service).filter(Boolean))].sort(),
    filters,
    canManage: manage,
    me: { id: ctx.employee.id, name: ctx.employee.display_name },
    // 072 / 073 がまだのときは、印や重要タスクが出せない
    legacy,
  });
}
