// GET  /api/dashboard?date=YYYY-MM-DD … 個人ダッシュボード
// POST /api/dashboard {kind:"kpi",   …} … KPIの目標・実績
// POST /api/dashboard {kind:"action", …} … 次にやることの追加・完了・取りやめ
//
// この画面で一番見せたいのは「何点だったか」ではなく「次に何をするか」。
// なので返す順番も、上から
//   ① 今日の最優先 ② 今日のKPI ③ 昨日のAIフィードバック ④ 今週の状況 ⑤ 10か条
// にしてある。会社の評価を見る画面ではなく、仕事を前に進める画面にする。
//
// ■ 誰が何を書けるか
//   本人 … KPIの実績（actual）、次にやることの完了・取りやめ、自分で足した項目
//   上司 … KPIの目標（target）、指示としての項目
//
//   RLS は列を絞れないので、本人に update を許すと target まで書き換えられる
//   （目標を下げれば達成率が上がってしまう）。
//   そのため書き込みは service_role のこの API だけにして、
//   「本人が触ってよい列か」はここで見る。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate, weekStart, isDate } from "../../lib/nippo.js";
import { weekdaysOf } from "../../lib/nippo-period.js";
import { score, ACTIONS } from "../../lib/scoring.js";
import {
  ensureKpis, kpiRate, closeItems, shapeKpi, shapeItem, nextWorkday,
} from "../../lib/actions.js";
import { shapeBlocker } from "../../lib/blockers.js";
import { levelOf } from "../../lib/autonomy.js";

const canManage = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, {
      error: "no_employee",
      hint: "社員名簿にあなたの行がありません。管理者に登録を依頼してください。",
    });
  }

  if (req.method === "GET") return read(req, res, user, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    if (body?.kind === "kpi") return saveKpi(res, user, ctx, body);
    if (body?.kind === "action") return saveAction(res, user, ctx, body);
    return json(res, 400, { error: "invalid_kind", allowed: ["kpi", "action"] });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res, user, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const date = isDate(q.get("date")) ? q.get("date") : jstDate();

  // 他人のぶんを見るのは管理者・人事・経営者だけ
  const asked = q.get("userId");
  const userId = asked && asked !== user.id
    ? (canManage(ctx) ? asked : null)
    : user.id;
  if (!userId) return json(res, 403, { error: "forbidden" });

  const sb = admin();
  const ws = weekStart(date);
  const days = weekdaysOf(ws);

  const [kpis, items, weekNippos, weekEvals, weekly, recentEvals, blockers, emp] = await Promise.all([
    ensureKpis(sb, userId, date),

    // 今日ぶんと、やり残し（期限が過ぎてまだ開いているもの）
    sb.from("gw_action_items").select("*")
      .eq("user_id", userId).eq("status", "open").lte("due_date", date)
      .order("due_date").order("priority").limit(20),

    sb.from("tc_nippo").select("*")
      .eq("user_id", userId).gte("work_date", days[0]).lte("work_date", days[4]),

    sb.from("gw_nippo_ai_evals").select("*")
      .eq("user_id", userId).gte("work_date", days[0]).lte("work_date", days[4])
      .eq("status", "completed").order("created_at", { ascending: false }),

    sb.from("tc_weekly_review").select("*")
      .eq("user_id", userId).eq("week_start", ws).maybeSingle(),

    // 10か条のレーダーは直近7日で見る。1日ぶんだと上下が大きすぎて意味が読めない
    sb.from("gw_nippo_ai_evals").select("work_date, scores, created_at")
      .eq("user_id", userId).eq("status", "completed")
      .lte("work_date", date).order("work_date", { ascending: false }).limit(20),

    // 止まっている仕事。TODAY の次に出す（§12④）
    sb.from("gw_blockers").select("*")
      .eq("user_id", userId).eq("status", "open").order("blocked_since").limit(10),

    // 自走レベル。画面には「次のレベルまであと何項目」として出す
    sb.from("gw_employees").select("autonomy_level").eq("user_id", userId).maybeSingle(),
  ]);

  const open = items.data || [];
  const kpiSummary = kpiRate(kpis);

  // 昨日のフィードバック。1日ぶんにつき、最後に出た評価だけを見る
  const evalsByDate = dedupeByDate(weekEvals.data || []);
  const prev = [...evalsByDate.values()]
    .filter((e) => e.work_date < date)
    .sort((a, b) => (a.work_date < b.work_date ? 1 : -1))[0] || null;

  return json(res, 200, {
    date,
    userId,
    // ① 今日の最優先。ひとつだけ大きく出す
    top: open.length ? shapeItem(open[0]) : null,
    // その下に小さく並べる残り
    actions: open.slice(1).map(shapeItem),
    overdue: open.filter((a) => a.due_date < date).length,

    // ② 今日のKPI
    kpis: kpis.map(shapeKpi),
    kpiSummary,
    canSetTarget: canManage(ctx) || userId === user.id,

    // ③ 止まっている仕事。放っておくと、翌日も同じところで止まる
    blockers: (blockers.data || []).map((b) => shapeBlocker(b, date)),

    // ④ 自走レベル。裁量の広さの話で、人の評価ではない。
    //    画面では「レベルが低い」ではなく「次まであと何項目」と出す
    autonomy: (() => {
      const level = emp.data?.autonomy_level || 1;
      return { level, info: levelOf(level) };
    })(),

    // ⑤ 昨日のAIフィードバック
    yesterday: prev ? {
      date: prev.work_date,
      good: (prev.good_points || []).slice(0, 2),
      next: prev.tomorrow_advice,
      comment: prev.ai_comment,
      total: prev.manager_total ?? prev.total_score,
    } : null,

    // ④ 今週の状況
    week: weekSummary({
      weekStart: ws, days, date,
      nippos: weekNippos.data || [],
      evals: [...evalsByDate.values()],
      review: weekly.data || null,
    }),

    // ⑤ 10か条（直近7日ぶんの平均）
    radar: radar(recentEvals.data || []),

    // 今日の日報が出ているか。出ていなければ画面から促す
    submittedToday: (weekNippos.data || []).some((n) => n.work_date === date),
    nextWorkday: nextWorkday(date),
  });
}

/** 1日につき最後の評価だけを残す。再採点したぶんが二重に効かないように */
function dedupeByDate(evals) {
  const m = new Map();
  for (const e of evals) if (!m.has(e.work_date)) m.set(e.work_date, e);
  return m;
}

function weekSummary({ weekStart: ws, days, nippos, evals, review, date }) {
  const submitted = new Set(nippos.map((n) => n.work_date));

  const withKgi = nippos.filter((n) => n.kgi_achieved === true || n.kgi_achieved === false);
  const kgiHit = withKgi.filter((n) => n.kgi_achieved === true).length;

  // 改善回数。§9④ の「改善回数」はここ
  const improves = nippos.reduce((a, n) => a + ((n.improve_tags || []).length ? 1 : 0), 0);
  const results = nippos.reduce(
    (a, n) => a + (n.work_items || []).filter((w) => w.result).length, 0);

  // 10か条の平均は、日次の点を重み付けして100点にする
  const perKey = {};
  for (const a of ACTIONS) {
    const vals = evals.map((e) => e.scores?.[a.key])
      .filter((s) => s && s.status === "evaluated" && Number.isFinite(s.score))
      .map((s) => s.score);
    perKey[a.key] = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
  }

  return {
    weekStart: ws,
    submitted: submitted.size,
    workdays: days.length,
    // 週の途中で「2/5日」と出すと未提出に見える。まだ来ていない日は分母から外す
    elapsed: days.filter((d) => d <= date).length,
    kgiRate: withKgi.length ? Math.round((kgiHit / withKgi.length) * 100) : null,
    kgiHit, kgiOf: withKgi.length,
    improveCount: improves,
    resultCount: results,
    avgTotal: score(perKey).total,
    // 管理者が確定した週次評価は、本人へ提出されてから見せる
    weeklyTotal: review?.submitted_at ? (review.eval_total ?? null) : null,
  };
}

/** 直近7日ぶんの10か条の平均。日々の上下ではなく傾向を見る */
function radar(rows) {
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.work_date)) seen.set(r.work_date, r);
  const recent = [...seen.values()].slice(0, 7);

  const perKey = {};
  for (const a of ACTIONS) {
    const vals = recent.map((e) => e.scores?.[a.key])
      .filter((s) => s && s.status === "evaluated" && Number.isFinite(s.score))
      .map((s) => s.score);
    perKey[a.key] = vals.length
      ? Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 10) / 10
      : null;
  }

  const s = score(perKey);
  return {
    days: recent.length,
    actions: ACTIONS.map((a) => ({ key: a.key, short: a.short, label: a.label, avg: perKey[a.key] })),
    categories: s.categories,
    total: s.total,
  };
}

// ---- KPI --------------------------------------------------------------------
async function saveKpi(res, user, ctx, body) {
  const date = isDate(body.date) ? body.date : jstDate();
  const targetUser = body.userId && body.userId !== user.id
    ? (canManage(ctx) ? body.userId : null)
    : user.id;
  if (!targetUser) return json(res, 403, { error: "forbidden" });

  const sb = admin();
  const mine = targetUser === user.id;
  const manager = canManage(ctx);

  // 実績だけ入れる（本人）
  if (body.action === "actual") {
    const rows = [];
    for (const [id, v] of Object.entries(body.actuals || {})) {
      if (v === "" || v === null) { rows.push({ id, actual: null }); continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        return json(res, 400, { error: "invalid_actual", hint: "実績は0以上の数字です" });
      }
      rows.push({ id, actual: n });
    }
    for (const r of rows) {
      // 自分の行だけ。id は画面から来る値なので user_id でも絞る
      const { error } = await sb.from("gw_daily_kpis")
        .update({ actual: r.actual, updated_at: new Date().toISOString() })
        .eq("id", r.id).eq("user_id", targetUser);
      if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    }
    return json(res, 200, { ok: true, updated: rows.length });
  }

  // 目標を決める。管理者か、本人が自分のぶんを決める場合
  if (body.action === "target") {
    if (!mine && !manager) return json(res, 403, { error: "forbidden" });

    const list = (body.kpis || []).slice(0, 5);
    const rows = [];
    for (const [i, k] of list.entries()) {
      const label = String(k.label ?? "").trim().slice(0, 60);
      if (!label) continue;
      const target = k.target === "" || k.target == null ? null : Number(k.target);
      if (target != null && (!Number.isFinite(target) || target < 0)) {
        return json(res, 400, { error: "invalid_target", hint: "目標は0以上の数字です" });
      }
      rows.push({
        user_id: targetUser, work_date: date, sort_order: i,
        label, unit: String(k.unit ?? "").trim().slice(0, 10) || null,
        target, source: "manual", target_set_by: user.id,
        updated_at: new Date().toISOString(),
      });
    }

    // 消えた行を残さない。目標を入れ替えたのに古い行が並ぶと分からなくなる。
    // ラベルに読点が入ることがあるので、PostgREST の in 句には渡さず id で消す
    const keep = rows.map((r) => r.label);
    const { data: existing } = await sb.from("gw_daily_kpis").select("id, label")
      .eq("user_id", targetUser).eq("work_date", date);
    const stale = (existing || []).filter((e) => !keep.includes(e.label)).map((e) => e.id);
    if (stale.length) {
      const { error: de } = await sb.from("gw_daily_kpis").delete().in("id", stale);
      if (de) return json(res, 500, { error: "db_delete_failed", detail: de.message });
    }

    if (rows.length) {
      // actual は残す。目標を直したときに実績まで消えると、その日の記録が飛ぶ
      const { error } = await sb.from("gw_daily_kpis")
        .upsert(rows, { onConflict: "user_id,work_date,label" });
      if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });
    }

    // 次からの雛形にする。毎日同じ目標を入れ直さなくて済む
    if (body.saveTemplate) {
      await sb.from("gw_kpi_templates").update({ active: false }).eq("user_id", targetUser);
      if (rows.length) {
        await sb.from("gw_kpi_templates").upsert(
          rows.map((r, i) => ({
            user_id: targetUser, sort_order: i, label: r.label,
            unit: r.unit, target: r.target, active: true,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: "user_id,label" });
      }
    }

    if (!mine) {
      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id, action: "dashboard.kpi_target",
        target: `user:${targetUser}`, detail: { date, labels: keep },
      });
    }
    return json(res, 200, { ok: true, kpis: rows.length });
  }

  return json(res, 400, { error: "invalid_action", allowed: ["actual", "target"] });
}

// ---- 次にやること -----------------------------------------------------------
async function saveAction(res, user, ctx, body) {
  const sb = admin();

  if (body.action === "add") {
    const title = String(body.title ?? "").trim().slice(0, 200);
    if (!title) return json(res, 400, { error: "invalid_title", hint: "内容を書いてください" });

    const forOther = body.userId && body.userId !== user.id;
    if (forOther && !canManage(ctx)) return json(res, 403, { error: "forbidden" });
    const targetUser = forOther ? body.userId : user.id;

    const due = isDate(body.dueDate) ? body.dueDate : jstDate();
    let priority = Number(body.priority);
    if (![1, 3, 5].includes(priority)) priority = 5;

    // 「今日の最優先」はその日ひとつだけ。すでに埋まっていれば2番手に落とす
    if (priority === 1) {
      const { data: taken } = await sb.from("gw_action_items").select("id")
        .eq("user_id", targetUser).eq("due_date", due)
        .eq("priority", 1).eq("status", "open").limit(1);
      if (taken?.length) priority = 2;
    }

    const { data, error } = await sb.from("gw_action_items").insert({
      user_id: targetUser,
      title,
      detail: String(body.detail ?? "").trim().slice(0, 2000) || null,
      source: forOther ? "manager" : "self",
      due_date: due,
      priority,
      created_by: user.id,
    }).select("*").single();
    if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

    if (forOther) {
      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id, action: "dashboard.action_assign",
        target: `user:${targetUser}`, detail: { title, due },
      });
    }
    return json(res, 200, { item: shapeItem(data) });
  }

  if (body.action === "done") {
    const n = await closeItems(sb, {
      userId: user.id, ids: [body.id], nippoId: null, note: body.note,
    });
    if (!n) return json(res, 404, { error: "not_found", hint: "すでに閉じているか、自分のものではありません" });
    return json(res, 200, { ok: true });
  }

  if (body.action === "drop") {
    // 消さずに「やらない」で残す。やらないと決めたことも記録のうち
    const { data, error } = await sb.from("gw_action_items")
      .update({
        status: "dropped",
        done_note: String(body.note ?? "").trim().slice(0, 2000) || null,
        done_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", body.id).eq("user_id", user.id).eq("status", "open")
      .select("id");
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    if (!data?.length) return json(res, 404, { error: "not_found" });
    return json(res, 200, { ok: true });
  }

  if (body.action === "top") {
    // 一番上に出すものを入れ替える。いまの1番を3番へ下げてから入れ替える
    const { data: it } = await sb.from("gw_action_items").select("*")
      .eq("id", body.id).eq("user_id", user.id).maybeSingle();
    if (!it) return json(res, 404, { error: "not_found" });

    await sb.from("gw_action_items")
      .update({ priority: 3, updated_at: new Date().toISOString() })
      .eq("user_id", user.id).eq("due_date", it.due_date)
      .eq("priority", 1).eq("status", "open");

    const { error } = await sb.from("gw_action_items")
      .update({ priority: 1, updated_at: new Date().toISOString() }).eq("id", it.id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    return json(res, 200, { ok: true });
  }

  return json(res, 400, { error: "invalid_action", allowed: ["add", "done", "drop", "top"] });
}
