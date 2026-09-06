// GET  /api/autonomy            … 全員の自走レベルと、次のレベルの条件（管理者）
// GET  /api/autonomy?userId=…   … その人ぶん（本人は自分のぶんだけ）
// POST /api/autonomy {action:"set", userId, level, reason}
//
// ■ AIは上げ下げを決めない
//   システムは「条件を満たしたか」を数えるところまで。
//   上げる・下げるは人が押す。押した人と時刻を残す。
//   日報のAI評価・試用期間・契約更新と同じ扱いにしている。
//
// ■ 下げることもある
//   上げっぱなしにはしない。下げた記録も残す。
//   下がったこと自体が、次に何を見ればよいかの材料になる。
//
// ■ レベルは人の評価ではない
//   裁量の広さの話。新しく入った人が L1 なのは、
//   まだ会社の仕事の進め方を知らないというだけ。
//   画面でも「レベルが低い」ではなく「次まであと何項目」と出す。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate } from "../../lib/nippo.js";
import { recentWorkdays } from "../../lib/follow.js";
import { LEVELS, levelOf, computeMetrics, checkNext } from "../../lib/autonomy.js";

// 直近20営業日（およそ1か月）で見る。1週間だと、たまたま良かった週で上がる
const WINDOW = 20;

const canManage = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "no_employee" });

  if (req.method === "GET") return read(req, res, user, ctx);
  if (req.method === "POST") return act(req, res, user, ctx);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function read(req, res, user, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const asked = q.get("userId");
  if (asked && asked !== user.id && !canManage(ctx)) {
    return json(res, 403, { error: "forbidden" });
  }
  // 一覧を出せるのは管理者だけ。それ以外は、指定が無くても自分のぶんに絞る
  const only = asked || (canManage(ctx) ? null : user.id);

  const sb = admin();
  const today = jstDate();
  const days = recentWorkdays(today, WINDOW);
  const from = days[days.length - 1];

  let empQ = sb.from("gw_employees")
    .select("id, user_id, display_name, department, autonomy_level, autonomy_changed_at")
    .eq("tenant_id", ctx.tenantId).in("status", ["active", "leaving"])
    .not("user_id", "is", null).order("display_name").limit(300);
  if (only) empQ = empQ.eq("user_id", only);

  const { data: emps } = await empQ;
  const staff = emps || [];
  const ids = staff.map((e) => e.user_id);
  if (!ids.length) return json(res, 200, { levels: LEVELS, people: [], window: WINDOW });

  const [nippos, kpis, items, blockers] = await Promise.all([
    sb.from("tc_nippo")
      .select("user_id, work_date, work_items, issues, no_issues, improve_tags, contribution")
      .in("user_id", ids).gte("work_date", from).lte("work_date", today).limit(8000),
    sb.from("gw_daily_kpis").select("user_id, work_date, target, actual")
      .in("user_id", ids).gte("work_date", from).lte("work_date", today).limit(8000),
    sb.from("gw_action_items").select("user_id, source, status, due_date")
      .in("user_id", ids).gte("due_date", from).lte("due_date", today).limit(8000),
    // 「他の人のBlockerを外した」件数。自分のぶんは数えない
    sb.from("gw_blockers").select("resolved_by, user_id")
      .eq("status", "resolved").in("resolved_by", ids)
      .gte("resolved_at", `${from}T00:00:00Z`).limit(2000),
  ]);

  const by = (rows, key) => {
    const m = new Map(ids.map((i) => [i, []]));
    for (const r of rows || []) if (m.has(r[key])) m.get(r[key]).push(r);
    return m;
  };
  const nByUser = by(nippos.data, "user_id");
  const kByUser = by(kpis.data, "user_id");
  const iByUser = by(items.data, "user_id");
  // 他人のものを外した件数だけ数える
  const bByUser = new Map(ids.map((i) => [i, []]));
  for (const b of blockers.data || []) {
    if (b.resolved_by !== b.user_id && bByUser.has(b.resolved_by)) bByUser.get(b.resolved_by).push(b);
  }

  const people = staff.map((e) => {
    const metrics = computeMetrics({
      workdays: days,
      nippos: nByUser.get(e.user_id) || [],
      kpis: kByUser.get(e.user_id) || [],
      items: iByUser.get(e.user_id) || [],
      blockers: bByUser.get(e.user_id) || [],
    });
    const next = checkNext(e.autonomy_level, metrics);
    return {
      employeeId: e.id,
      userId: e.user_id,
      name: e.display_name,
      department: e.department,
      level: e.autonomy_level,
      levelInfo: levelOf(e.autonomy_level),
      changedAt: e.autonomy_changed_at,
      metrics,
      next,
    };
  });

  return json(res, 200, {
    levels: LEVELS,
    people,
    window: WINDOW,
    canManage: canManage(ctx),
  });
}

async function act(req, res, user, ctx) {
  if (!canManage(ctx)) return json(res, 403, { error: "forbidden" });

  const body = await readJson(req);
  if (body.action !== "set") {
    return json(res, 400, { error: "invalid_action", allowed: ["set"] });
  }

  const level = Number(body.level);
  if (![1, 2, 3, 4].includes(level)) {
    return json(res, 400, { error: "invalid_level", hint: "1〜4のいずれかです" });
  }
  const reason = String(body.reason ?? "").trim().slice(0, 2000);
  if (!reason) {
    // 理由なしで動かせると、あとから「なぜ上がった/下がった」が分からなくなる
    return json(res, 400, { error: "reason_required", hint: "変更の理由を書いてください" });
  }

  const sb = admin();
  const { data: emp } = await sb.from("gw_employees")
    .select("id, user_id, display_name, autonomy_level")
    .eq("user_id", body.userId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });
  if (emp.autonomy_level === level) return json(res, 409, { error: "no_change" });

  const now = new Date().toISOString();
  const { error: ue } = await sb.from("gw_employees").update({
    autonomy_level: level,
    autonomy_changed_at: now,
    autonomy_changed_by: user.id,
  }).eq("id", emp.id);
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  // 履歴。上げた記録だけでなく、下げた記録も残す
  await sb.from("gw_autonomy_reviews").insert({
    employee_id: emp.id,
    user_id: emp.user_id,
    from_level: emp.autonomy_level,
    to_level: level,
    metrics: body.metrics || null,
    checks: body.checks || null,
    reason,
    decided_by: user.id,
    decided_at: now,
  });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "autonomy.set",
    target: `employee:${emp.display_name}`,
    detail: { from: emp.autonomy_level, to: level },
  });

  return json(res, 200, { ok: true, level, levelInfo: levelOf(level) });
}
