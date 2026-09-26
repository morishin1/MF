// GET /api/dashboard/team
//   管理者ダッシュボードの1本。人ごとに「今日の3つ・完了数・期限超過・契約更新待ち」を
//   まとめて返す。詳細は返さない（押したら右ドロワー／既存の一覧で見る）。
//
// ■ なぜ1本にまとめるのか
//   ダッシュボードは「今日やること」を見る場所、詳しくは一覧やドロワーで見る、
//   という方針（GW統合設計）。ここでは gw_tasks を3回に分けて軽く引き、
//   人ごとに数えるところまでをサーバでやる。画面側は並べるだけでよい
//
// ■ 担当が付いていないタスクも出す
//   端末未登録・契約更新確認などのcron発のタスク（api/cron/task-events.js）は
//   assignee_id が null で生まれる。誰も見ないままにならないよう、
//   「未担当」という1行にまとめて必ず出す

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { jstDate } from "../../lib/devices.js";

const SQL_FLOW = "db/068_task_flow.sql";
const SQL_FOCUS = "db/072_focus_tasks.sql";
const UNASSIGNED = "unassigned";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  const today = jstDate();
  const todayStartIso = new Date(`${today}T00:00:00+09:00`).toISOString();

  const { data: emps, error: ee } = await sb.from("gw_employees")
    .select("id, display_name").eq("tenant_id", ctx.tenantId)
    .in("status", ["active", "invited"]).limit(500);
  if (ee) return json(res, 500, { error: "db_query_failed", detail: ee.message });
  const nameOf = new Map((emps || []).map((e) => [e.id, e.display_name]));

  // 未完了（期限超過・契約更新待ちの数え元）。is_template（068）が無い環境も落とさない
  const open = await soft(() => sb.from("gw_tasks")
    .select("id, assignee_id, due_on, category, is_template")
    .eq("tenant_id", ctx.tenantId).in("status", ["todo", "doing"]).limit(2000), SQL_FLOW);
  if (open.notReady) return json(res, 200, { today, team: [], notReady: true, message: open.message });

  // 今日完了した分
  const doneToday = await soft(() => sb.from("gw_tasks")
    .select("id, assignee_id")
    .eq("tenant_id", ctx.tenantId).eq("status", "done").gte("completed_at", todayStartIso).limit(2000));

  // 今日の重要タスク（3件）。072未適用の環境では空にする
  const focus = await soft(() => sb.from("gw_tasks")
    .select("id, title, focus_for, focus_rank, status")
    .eq("tenant_id", ctx.tenantId).eq("focus_date", today)
    .order("focus_rank", { ascending: true }).limit(500), SQL_FOCUS);

  const bucket = new Map(); // key -> { overdue, renewalPending, doneToday, today: [] }
  const get = (key) => {
    if (!bucket.has(key)) bucket.set(key, { overdue: 0, renewalPending: 0, doneToday: 0, today: [] });
    return bucket.get(key);
  };

  for (const t of open.rows) {
    if (t.is_template) continue;
    const key = t.assignee_id || UNASSIGNED;
    if (t.due_on && t.due_on < today) get(key).overdue++;
    if (t.category === "契約更新") get(key).renewalPending++;
  }
  for (const t of doneToday.rows) get(t.assignee_id || UNASSIGNED).doneToday++;
  for (const t of focus.rows) {
    const key = t.focus_for || UNASSIGNED;
    const b = get(key);
    if (b.today.length < 3) b.today.push({ id: t.id, title: t.title, done: t.status === "done" });
  }

  const rows = [...bucket.entries()]
    .filter(([key]) => key !== UNASSIGNED)
    .map(([key, v]) => ({ employeeId: key, name: nameOf.get(key) || "（名簿に無い担当）", ...v }));
  rows.sort((a, b) => (b.overdue - a.overdue) || (b.renewalPending - a.renewalPending)
    || a.name.localeCompare(b.name, "ja"));

  const unassigned = bucket.get(UNASSIGNED) || null;

  return json(res, 200, {
    today, team: rows,
    unassigned: unassigned && (unassigned.overdue || unassigned.renewalPending || unassigned.doneToday)
      ? unassigned : null,
    focusReady: !focus.notReady,
  });
}

/** 列・表がまだ無い環境でも落とさない。無ければ空で返す */
async function soft(fn, sqlHint) {
  try {
    const r = await fn();
    if (r.error) {
      const hint = sqlHint ? dbSetupHint(r.error, sqlHint) : null;
      if (hint) return { rows: [], notReady: true, message: hint };
      return { rows: [] };
    }
    return { rows: r.data || [] };
  } catch (e) {
    return { rows: [] };
  }
}
