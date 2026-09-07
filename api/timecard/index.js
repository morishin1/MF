// GET   /api/timecard?month=YYYY-MM[&employeeId=…]  … 全員ぶんの打刻と、承認待ちの修正
// GET   /api/timecard?month=YYYY-MM&csv=1           … 給与計算へ渡すCSV
// PATCH /api/timecard {action:"edit", employeeId, workDate, ...}   … 直す
// PATCH /api/timecard {action:"approve"|"reject", fixId, note}     … 修正の申請を決める
// PATCH /api/timecard {action:"lock"|"unlock", month, employeeId?} … 月を締める／解く
//
// ■ 直した記録は消せない
//   管理者は直接直せる。止めると、本人が休みの日に会社が入れられない。
//   代わりに「誰が・いつ・なぜ」を必ず行に残す（edited_by / edited_at / edit_reason）。
//
// ■ 締めたら動かさない
//   給与を計算したあとに数字が動くと、支給額と記録が合わなくなる。
//   締めを解くのも管理者だが、解いたことも活動ログに残る。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notify } from "../../lib/notify.js";
import {
  jstDate, isDate, isMonth, monthRange, dayTotals, monthTotals,
  normalizeBreaks, scheduledMinutes, validateEntry, csvRow, CSV_HEADER,
} from "../../lib/timecard.js";

const FIELDS =
  "id, employee_id, work_date, clock_in, clock_out, breaks, status, source, note, "
  + "edited_by, edited_at, edit_reason, locked_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return list(req, res, ctx);
  if (req.method === "PATCH") return patch(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "PATCH"]);
}

// ---- 一覧 ---------------------------------------------------------------------
async function list(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const month = isMonth(q.get("month")) ? q.get("month") : jstDate().slice(0, 7);
  const range = monthRange(month);
  const employeeId = q.get("employeeId") || null;

  const sb = admin();
  let entriesQ = sb.from("gw_time_entries").select(FIELDS)
    .eq("tenant_id", ctx.tenantId)
    .gte("work_date", range.from).lt("work_date", range.to)
    .order("work_date", { ascending: false });
  if (employeeId) entriesQ = entriesQ.eq("employee_id", employeeId);

  const [{ data: entries }, { data: roster }, { data: fixes }, { data: contracts }] = await Promise.all([
    entriesQ,
    sb.from("gw_employees").select("id, display_name, department, status")
      .eq("tenant_id", ctx.tenantId).neq("status", "left")
      .order("display_name"),
    sb.from("gw_time_fixes")
      .select("id, employee_id, work_date, want, before, reason, status, decided_at, decided_note, created_at")
      .eq("tenant_id", ctx.tenantId).eq("status", "pending")
      .order("created_at", { ascending: true }),
    sb.from("gw_contracts").select("employee_id, work_hours, created_at")
      .eq("tenant_id", ctx.tenantId).eq("status", "active")
      .order("created_at", { ascending: false }),
  ]);

  const people = new Map((roster || []).map((e) => [e.id, e]));
  const sched = new Map();
  for (const c of contracts || []) {
    if (!sched.has(c.employee_id)) sched.set(c.employee_id, scheduledMinutes(c.work_hours));
  }
  const now = new Date();
  const rows = entries || [];

  // CSV。給与計算に渡すためのもの
  if (q.get("csv") === "1") {
    const lines = [CSV_HEADER, ...rows
      .slice()
      .sort((a, b) => a.work_date.localeCompare(b.work_date)
        || (people.get(a.employee_id)?.display_name || "").localeCompare(
          people.get(b.employee_id)?.display_name || "", "ja"))
      .map((e) => csvRow(e, people.get(e.employee_id), now))];
    const csv = lines.map((r) => r.map(csvCell).join(",")).join("\r\n");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`打刻_${month}.csv`)}`);
    // Excel が UTF-8 と分かるように BOM を付ける。付けないと日本語が化ける
    res.end("﻿" + csv);
    return;
  }

  // 人ごとにまとめる。名簿の順に並べ、打刻が1件も無い人も出す
  const byEmployee = new Map();
  for (const e of rows) {
    if (!byEmployee.has(e.employee_id)) byEmployee.set(e.employee_id, []);
    byEmployee.get(e.employee_id).push(e);
  }

  const today = jstDate();
  const members = (roster || [])
    .filter((p) => !employeeId || p.id === employeeId)
    .map((p) => {
      const mine = byEmployee.get(p.id) || [];
      const scheduled = sched.get(p.id) ?? null;
      const todayRow = mine.find((e) => e.work_date === today) || null;
      return {
        employee: { id: p.id, name: p.display_name, department: p.department, status: p.status },
        scheduledMinutes: scheduled,
        totals: monthTotals(mine, { scheduled }, now),
        today: todayRow ? shape(todayRow, now) : null,
        entries: mine.map((e) => shape(e, now)),
        locked: mine.length > 0 && mine.every((e) => e.locked_at),
      };
    });

  return json(res, 200, {
    month,
    members,
    // 承認待ちの修正。名前を添えて返す（画面で名簿と突き合わせない）
    fixes: (fixes || []).map((f) => ({
      ...f, employeeName: people.get(f.employee_id)?.display_name || "—",
    })),
    // いま出勤中の人。朝いちばんに見るのはここ
    working: members
      .filter((m) => m.today && m.today.open)
      .map((m) => ({ name: m.employee.name, since: m.today.clockIn, onBreak: m.today.onBreak })),
  });
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function shape(e, now) {
  const t = dayTotals(e, now);
  return {
    id: e.id, employeeId: e.employee_id, workDate: e.work_date,
    clockIn: e.clock_in, clockOut: e.clock_out, breaks: e.breaks || [],
    status: e.status, source: e.source, note: e.note,
    editedAt: e.edited_at, editReason: e.edit_reason, lockedAt: e.locked_at,
    ...t,
  };
}

// ---- 直す・決める・締める -------------------------------------------------------
async function patch(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();

  if (body?.action === "edit") return edit(res, sb, ctx, user, body);
  if (body?.action === "approve" || body?.action === "reject") {
    return decide(res, sb, ctx, user, body);
  }
  if (body?.action === "lock" || body?.action === "unlock") {
    return lock(res, sb, ctx, user, body);
  }
  return json(res, 400, { error: "invalid_action", detail: "edit, approve, reject, lock, unlock" });
}

/** 管理者が直接直す。理由を必ず残す */
async function edit(res, sb, ctx, user, body) {
  const { employeeId, workDate } = body;
  if (!employeeId || !isDate(workDate)) {
    return json(res, 400, { error: "invalid_body", required: ["employeeId", "workDate"] });
  }
  const reason = String(body?.reason ?? "").trim().slice(0, 500);
  if (!reason) return json(res, 400, { error: "no_reason", hint: "直した理由を書いてください" });

  const patchIn = {
    clockIn: body.clockIn || null,
    clockOut: body.clockOut || null,
    breaks: normalizeBreaks(body.breaks),
    status: ["open", "closed", "absent"].includes(body.status) ? body.status : "closed",
  };
  const bad = validateEntry(patchIn);
  if (bad) return json(res, 400, { error: "invalid_time", hint: bad });

  // 自社の名簿にいる人か。id は画面から来るので、ここで確かめないと
  // 他社の社員の行を、自社の tenant_id で作れてしまう
  const { data: who } = await sb.from("gw_employees").select("id")
    .eq("tenant_id", ctx.tenantId).eq("id", employeeId).maybeSingle();
  if (!who) return json(res, 404, { error: "employee_not_found" });

  const { data: cur } = await sb.from("gw_time_entries").select("id, locked_at")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId).eq("work_date", workDate).maybeSingle();
  if (cur?.locked_at) {
    return json(res, 409, { error: "locked", hint: "締め済みです。先に締めを解いてください" });
  }

  const saved = await writeEntry(sb, ctx, { employeeId, workDate, ...patchIn }, {
    id: cur?.id, editedBy: user.id, reason,
  });
  if (saved.error) return json(res, 500, { error: "db_write_failed", detail: saved.error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "timecard.edit",
    target: `employee:${employeeId}`, detail: { workDate, reason },
  });
  return json(res, 200, { ok: true, entry: shape(saved.data, new Date()) });
}

/** 修正の申請を承認／却下する */
async function decide(res, sb, ctx, user, body) {
  if (!body?.fixId) return json(res, 400, { error: "invalid_body", required: ["fixId"] });

  const { data: fix } = await sb.from("gw_time_fixes").select("*")
    .eq("id", body.fixId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!fix) return json(res, 404, { error: "fix_not_found" });
  if (fix.status !== "pending") {
    return json(res, 409, { error: "already_decided", hint: "この申請はすでに処理済みです" });
  }

  const approve = body.action === "approve";
  const note = String(body?.note ?? "").trim().slice(0, 500) || null;
  const now = new Date().toISOString();

  if (approve) {
    const { data: cur } = await sb.from("gw_time_entries").select("id, locked_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", fix.employee_id)
      .eq("work_date", fix.work_date).maybeSingle();
    if (cur?.locked_at) {
      return json(res, 409, { error: "locked", hint: "締め済みです。先に締めを解いてください" });
    }

    const saved = await writeEntry(sb, ctx, {
      employeeId: fix.employee_id, workDate: fix.work_date,
      clockIn: fix.want?.clockIn || null,
      clockOut: fix.want?.clockOut || null,
      breaks: normalizeBreaks(fix.want?.breaks),
      status: fix.want?.status || "closed",
    }, { id: cur?.id, editedBy: user.id, reason: `本人の申請：${fix.reason}` });
    if (saved.error) return json(res, 500, { error: "db_write_failed", detail: saved.error.message });
  }

  const { error } = await sb.from("gw_time_fixes").update({
    status: approve ? "approved" : "rejected",
    decided_by: user.id, decided_at: now, decided_note: note,
  }).eq("id", fix.id);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await notify([{
    tenantId: ctx.tenantId, employeeId: fix.employee_id, kind: "request",
    title: approve ? "打刻の修正が反映されました" : "打刻の修正は見送りになりました",
    body: `${fix.work_date}${note ? `　${note}` : ""}`,
    link: "timecard.html",
    dedupeKey: `timefix-done:${fix.id}`,
  }]);
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: approve ? "timecard.fix_approve" : "timecard.fix_reject",
    target: `employee:${fix.employee_id}`, detail: { workDate: fix.work_date, note },
  });
  return json(res, 200, { ok: true, status: approve ? "approved" : "rejected" });
}

/** 月を締める／解く */
async function lock(res, sb, ctx, user, body) {
  const month = isMonth(body?.month) ? body.month : null;
  if (!month) return json(res, 400, { error: "invalid_body", required: ["month"] });
  const range = monthRange(month);
  const on = body.action === "lock";

  let q = sb.from("gw_time_entries")
    .update(on
      ? { locked_at: new Date().toISOString(), locked_by: user.id }
      : { locked_at: null, locked_by: null })
    .eq("tenant_id", ctx.tenantId)
    .gte("work_date", range.from).lt("work_date", range.to);
  if (body.employeeId) q = q.eq("employee_id", body.employeeId);

  const { data, error } = await q.select("id");
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: on ? "timecard.lock" : "timecard.unlock",
    target: body.employeeId ? `employee:${body.employeeId}` : `month:${month}`,
    detail: { month, rows: (data || []).length },
  });
  return json(res, 200, { ok: true, rows: (data || []).length });
}

/** 打刻の行を書く。無ければ作る。直した記録を必ず添える */
function writeEntry(sb, ctx, v, { id, editedBy, reason }) {
  const now = new Date().toISOString();
  const row = {
    tenant_id: ctx.tenantId,
    employee_id: v.employeeId,
    work_date: v.workDate,
    clock_in: v.clockIn || null,
    clock_out: v.clockOut || null,
    breaks: v.breaks || [],
    status: v.status,
    source: "admin",
    edited_by: editedBy,
    edited_at: now,
    edit_reason: reason,
    updated_at: now,
  };
  return id
    ? sb.from("gw_time_entries").update(row).eq("id", id).select(FIELDS).single()
    : sb.from("gw_time_entries").insert(row).select(FIELDS).single();
}
