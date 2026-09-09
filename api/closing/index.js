// GET   /api/closing?month=YYYY-MM        … 社員ごとの 勤怠・休暇・経費・未承認・締め状況
// GET   /api/closing?month=YYYY-MM&csv=1  … 給与計算へ渡すCSV
// PATCH /api/closing {action:"close"|"reopen", month, reason?}
//
// ■ 入口は別々のまま、締めるときだけ1か所に集める
//   勤怠・休暇・経費をひとつの画面に統合するのではない。
//   月初の「この人の分はそろったか」を、3画面で照合しなくて済むようにする。
//
// ■ 未承認が残っていたら締められない
//   締めたあとに経費の申請が出てくると、給与を計算し直すことになる。
//   締める側が見落とさないようにするのではなく、見落とせないようにする。
//
// ■ 集計は保存しない
//   毎回、元データを数え直す。写しを持つと、元を直したときに食い違う。
//   締めたときの数字だけ snapshot に控えるが、画面はそれを読まない。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  isMonth, monthRange, jstMonth, prevMonth, leaveDaysInMonth,
  canClose, CSV_HEADER, csvRow, csvCell,
} from "../../lib/closing.js";
import { monthTotals, scheduledMinutes } from "../../lib/timecard.js";

const SQL = "db/052_month_closing.sql";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 給与に関わる数字がまとまっている。人事・経営者だけ
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "PATCH") return patch(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "PATCH"]);
}

// ---- 読む ---------------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  // 締めるのはたいてい前月。指定が無ければそちらを出す
  const month = isMonth(q.get("month")) ? q.get("month") : prevMonth(jstMonth());
  const range = monthRange(month);

  const built = await build(ctx, month, range);
  if (built.error) return json(res, built.status, built.error);
  const { rows, closing } = built;

  const closed = closing?.status === "closed";

  if (q.get("csv") === "1") {
    const lines = [CSV_HEADER, ...rows.map((r) => csvRow(month, r, closed))];
    const csv = lines.map((r) => r.map(csvCell).join(",")).join("\r\n");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`月次_${month}.csv`)}`);
    // Excel が UTF-8 と分かるように BOM を付ける。付けないと日本語が化ける
    res.end("﻿" + csv);
    return;
  }

  const gate = canClose(rows);
  return json(res, 200, {
    month,
    rows,
    closing: closing
      ? { status: closing.status, closedAt: closing.closed_at, reopenedAt: closing.reopened_at,
          reopenReason: closing.reopen_reason, note: closing.note }
      : { status: "open" },
    // 締められるか。だめなときは、止めている理由を全部返す
    canClose: gate.ok,
    blockers: gate.blockers,
    totals: {
      people: rows.length,
      workMinutes: rows.reduce((a, r) => a + r.work.workMinutes, 0),
      paidLeave: round1(rows.reduce((a, r) => a + r.leave.paid, 0)),
      expense: rows.reduce((a, r) => a + r.expense.total, 0),
      pending: rows.reduce((a, r) =>
        a + r.pending.leave + r.pending.ringi + r.pending.expense + r.pending.timefix, 0),
    },
  });
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * 社員ごとに、その月の 勤怠・休暇・経費・未承認 を集める。
 *
 * 表が1つ無くても、ほかの数字まで落とさない。
 * 経費だけ未導入、といった環境でも月次締めは使えるべき
 */
async function build(ctx, month, range) {
  const sb = admin();

  const safe = async (fn, label) => {
    try {
      const r = await fn();
      if (r.error) throw r.error;
      return { data: r.data || [], missing: false };
    } catch (e) {
      // 表そのものが無いのか、別の失敗かを見分ける
      const missing = Boolean(dbSetupHint(e, SQL));
      console.error(`[closing] ${label} を読めませんでした:`, e?.message || e);
      return { data: [], missing };
    }
  };

  const [roster, entries, leaves, expenses, timefix, contracts, closingRow] = await Promise.all([
    safe(() => sb.from("gw_employees")
      .select("id, display_name, email, department, status, joined_on, left_on")
      .eq("tenant_id", ctx.tenantId).neq("status", "invited")
      .order("display_name"), "名簿"),

    safe(() => sb.from("gw_time_entries")
      .select("employee_id, work_date, clock_in, clock_out, breaks, status")
      .eq("tenant_id", ctx.tenantId)
      .gte("work_date", range.from).lt("work_date", range.to), "打刻"),

    // 休暇。承認済みと、まだ承認されていないものの両方を見る
    safe(() => sb.from("gw_requests")
      .select("id, employee_id, kind, leave_type, starts_on, ends_on, days, status")
      .eq("tenant_id", ctx.tenantId)
      // 月をまたぐ休暇も拾う。終わりが月初以降で、始まりが翌月より前
      .or(`and(starts_on.lt.${range.to},ends_on.gte.${range.from}),`
        + `and(kind.eq.ringi,created_at.gte.${range.from},created_at.lt.${range.to})`), "休暇・稟議"),

    safe(() => sb.from("gw_expense_reports")
      .select("id, employee_id, period, total_amount, status")
      .eq("tenant_id", ctx.tenantId).eq("period", month), "経費"),

    safe(() => sb.from("gw_time_fixes")
      .select("id, employee_id, work_date, status")
      .eq("tenant_id", ctx.tenantId).eq("status", "pending")
      .gte("work_date", range.from).lt("work_date", range.to), "打刻の修正"),

    safe(() => sb.from("gw_contracts").select("employee_id, work_hours, created_at")
      .eq("tenant_id", ctx.tenantId).eq("status", "active")
      .order("created_at", { ascending: false }), "雇用契約"),

    safe(() => sb.from("gw_month_closings").select("*")
      .eq("tenant_id", ctx.tenantId).eq("month", month).limit(1), "締めの記録"),
  ]);

  if (closingRow.missing) {
    return {
      status: 503,
      error: { error: "not_installed",
               hint: `この機能に必要なテーブルがまだ作られていません。管理者に ${SQL} の実行を依頼してください` },
    };
  }

  const sched = new Map();
  for (const c of contracts.data) {
    if (!sched.has(c.employee_id)) sched.set(c.employee_id, scheduledMinutes(c.work_hours));
  }

  const byEmp = (list) => {
    const m = new Map();
    for (const r of list) {
      if (!m.has(r.employee_id)) m.set(r.employee_id, []);
      m.get(r.employee_id).push(r);
    }
    return m;
  };
  const timeBy = byEmp(entries.data);
  const reqBy = byEmp(leaves.data);
  const expBy = byEmp(expenses.data);
  const fixBy = byEmp(timefix.data);

  const now = new Date();
  const rows = roster.data.map((p) => {
    const mine = timeBy.get(p.id) || [];
    const t = monthTotals(mine, { scheduled: sched.get(p.id) ?? null }, now);

    const reqs = reqBy.get(p.id) || [];
    const approvedLeave = reqs.filter((r) => r.kind === "leave" && r.status === "approved");
    const paid = approvedLeave
      .filter((r) => ["paid", "am", "pm"].includes(r.leave_type))
      .reduce((a, r) => a + leaveDaysInMonth(r, range), 0);
    const other = approvedLeave
      .filter((r) => !["paid", "am", "pm"].includes(r.leave_type))
      .reduce((a, r) => a + leaveDaysInMonth(r, range), 0);

    const exps = expBy.get(p.id) || [];
    const paidExp = exps.filter((e) => ["approved", "paid"].includes(e.status));

    const isPending = (s) => s === "pending" || s === "pending_owner";
    return {
      employee: {
        id: p.id, name: p.display_name, email: p.email,
        department: p.department, status: p.status,
      },
      work: {
        days: t.days,
        workMinutes: t.workMinutes,
        breakMinutes: t.breakMinutes,
        openDays: t.openDays,     // 退勤を打っていない日。締める前に直す必要がある
        // 深夜・休日は打刻からは出していない（割増は給与側で決める）
        nightMinutes: 0, holidayMinutes: 0,
      },
      leave: { paid: round1(paid), other: round1(other) },
      expense: {
        total: paidExp.reduce((a, e) => a + (Number(e.total_amount) || 0), 0),
        count: paidExp.length,
      },
      pending: {
        leave: reqs.filter((r) => r.kind === "leave" && isPending(r.status)).length,
        ringi: reqs.filter((r) => r.kind === "ringi" && isPending(r.status)).length,
        expense: exps.filter((e) => isPending(e.status)).length,
        timefix: (fixBy.get(p.id) || []).length,
      },
    };
  });

  return { rows, closing: closingRow.data[0] || null };
}

// ---- 締める・解く ---------------------------------------------------------------
async function patch(req, res, ctx, user) {
  const body = await readJson(req);
  const month = isMonth(body?.month) ? body.month : null;
  if (!month || !["close", "reopen"].includes(body?.action)) {
    return json(res, 400, { error: "invalid_body", required: ["month", "action(close|reopen)"] });
  }
  const range = monthRange(month);
  const sb = admin();
  const now = new Date().toISOString();

  if (body.action === "reopen") {
    const reason = String(body?.reason ?? "").trim().slice(0, 500);
    // 解くこと自体は必要だが、理由なく解けるべきではない。
    // 給与を出したあとに数字が動くのが、いちばん困る
    if (!reason) {
      return json(res, 400, { error: "no_reason", hint: "締めを解く理由を書いてください" });
    }

    const { error } = await sb.from("gw_month_closings")
      .update({ status: "open", reopened_by: user.id, reopened_at: now,
                reopen_reason: reason, updated_at: now })
      .eq("tenant_id", ctx.tenantId).eq("month", month);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message,
                                       hint: dbSetupHint(error, SQL) ?? undefined });

    // 打刻の締めも一緒に解く。片方だけ締まった状態を作らない
    await sb.from("gw_time_entries")
      .update({ locked_at: null, locked_by: null })
      .eq("tenant_id", ctx.tenantId)
      .gte("work_date", range.from).lt("work_date", range.to);

    await gwLog({
      tenantId: ctx.tenantId, actorId: ctx.employee?.id || null,
      action: "closing.reopen", target: month, detail: { reason },
    });
    return json(res, 200, { ok: true, status: "open" });
  }

  // 締める前に、もう一度数え直す。
  // 画面を開いてから締めるまでのあいだに、新しい申請が出ているかもしれない
  const built = await build(ctx, month, range);
  if (built.error) return json(res, built.status, built.error);

  const gate = canClose(built.rows);
  if (!gate.ok && !body.force) {
    return json(res, 409, {
      error: "pending_remains",
      hint: "未承認のものが残っています。先に処理してください",
      blockers: gate.blockers,
    });
  }

  const snapshot = {
    at: now,
    people: built.rows.length,
    workMinutes: built.rows.reduce((a, r) => a + r.work.workMinutes, 0),
    paidLeave: round1(built.rows.reduce((a, r) => a + r.leave.paid, 0)),
    expense: built.rows.reduce((a, r) => a + r.expense.total, 0),
    // 未承認を残したまま締めた場合、その事実も控える
    forced: !gate.ok,
    blockers: gate.ok ? [] : gate.blockers,
  };

  const { error } = await sb.from("gw_month_closings").upsert({
    tenant_id: ctx.tenantId,
    month,
    status: "closed",
    closed_by: user.id,
    closed_at: now,
    snapshot,
    note: String(body?.note ?? "").trim().slice(0, 500) || null,
    updated_at: now,
  }, { onConflict: "tenant_id,month" });
  if (error) return json(res, 500, { error: "db_write_failed", detail: error.message,
                                     hint: dbSetupHint(error, SQL) ?? undefined });

  // 打刻もまとめて締める。月は締まっているのに打刻は動く、を作らない
  await sb.from("gw_time_entries")
    .update({ locked_at: now, locked_by: user.id })
    .eq("tenant_id", ctx.tenantId)
    .gte("work_date", range.from).lt("work_date", range.to);

  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee?.id || null,
    action: "closing.close", target: month,
    detail: { people: snapshot.people, forced: snapshot.forced },
  });
  return json(res, 200, { ok: true, status: "closed", snapshot });
}
