// GET  /api/timecard/me?month=YYYY-MM  … 今日の打刻と、その月の一覧
// POST /api/timecard/me {action}       … 打刻する
//        action: "in" 出勤 / "break" 休憩に入る / "resume" 戻る / "out" 退勤
// POST /api/timecard/me {fix:true, workDate, want, reason} … 修正を申請する
//
// ■ 時刻は本人の端末から受け取らない
//   サーバの時計で打つ。端末の時計はいくらでも動かせる。
//   「押した時刻」を根拠にする以上、根拠が本人の手元にあってはいけない。
//
// ■ 押したものは本人には直せない
//   間違えたときは、理由を書いて修正を申請する（gw_time_fixes）。
//   本人が自由に直せると、それは打刻ではなく自己申告になる。
//
// ■ 二重打刻は弾く
//   出勤中にもう一度「出勤」、休憩中に「休憩」は受け付けない。
//   連打や、複数の端末で開いている場合に起きる。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import {
  jstDate, isMonth, monthRange, dayTotals, monthTotals, onBreak,
  normalizeBreaks, scheduledMinutes, validateEntry,
} from "../../lib/timecard.js";

const FIELDS =
  "id, employee_id, work_date, clock_in, clock_out, breaks, status, source, note, "
  + "edited_at, edit_reason, locked_at, created_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません。管理者に登録を依頼してください" });
  }

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    return body?.fix ? requestFix(res, ctx, body) : stamp(res, ctx, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読む ---------------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const month = isMonth(q.get("month")) ? q.get("month") : jstDate().slice(0, 7);
  const range = monthRange(month);
  const today = jstDate();

  const sb = admin();
  const [{ data: rows }, { data: fixes }, { data: contract }] = await Promise.all([
    sb.from("gw_time_entries").select(FIELDS)
      .eq("employee_id", ctx.employee.id)
      .gte("work_date", range.from).lt("work_date", range.to)
      .order("work_date", { ascending: false }),
    sb.from("gw_time_fixes")
      .select("id, work_date, want, reason, status, decided_at, decided_note, created_at")
      .eq("employee_id", ctx.employee.id)
      .order("created_at", { ascending: false }).limit(50),
    // 所定労働時間。読めない書き方のときは null（「所定は未登録」として扱う）
    sb.from("gw_contracts").select("work_hours")
      .eq("employee_id", ctx.employee.id).eq("status", "active")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const entries = rows || [];
  const scheduled = scheduledMinutes(contract?.work_hours);
  const now = new Date();
  const todayRow = entries.find((e) => e.work_date === today) || null;

  return json(res, 200, {
    month,
    today: todayRow ? shape(todayRow, now) : null,
    // 押せるボタンはサーバが決める。画面で判断すると、
    // 別の端末で押したあとに古い画面から二重に押せてしまう
    can: {
      in: !todayRow || (!todayRow.clock_in && todayRow.status !== "absent"),
      out: Boolean(todayRow?.clock_in && !todayRow.clock_out),
      break: Boolean(todayRow?.clock_in && !todayRow.clock_out && !onBreak(todayRow)),
      resume: Boolean(todayRow?.clock_in && !todayRow.clock_out && onBreak(todayRow)),
    },
    entries: entries.map((e) => shape(e, now)),
    totals: monthTotals(entries, { scheduled }, now),
    scheduledMinutes: scheduled,
    fixes: fixes || [],
    me: { name: ctx.employee.display_name },
  });
}

function shape(e, now) {
  const t = dayTotals(e, now);
  return {
    id: e.id, workDate: e.work_date,
    clockIn: e.clock_in, clockOut: e.clock_out,
    breaks: e.breaks || [], status: e.status, source: e.source, note: e.note,
    editedAt: e.edited_at, editReason: e.edit_reason, lockedAt: e.locked_at,
    ...t,
  };
}

// ---- 打刻 ---------------------------------------------------------------------
async function stamp(res, ctx, body) {
  const action = body?.action;
  if (!["in", "out", "break", "resume"].includes(action)) {
    return json(res, 400, { error: "invalid_action", detail: "in, out, break, resume" });
  }

  const sb = admin();
  const date = jstDate();
  const now = new Date().toISOString();

  const { data: cur } = await sb.from("gw_time_entries").select(FIELDS)
    .eq("employee_id", ctx.employee.id).eq("work_date", date).maybeSingle();

  // 締めた月には打てない。ここが緩むと、給与を出したあとに数字が動く
  if (cur?.locked_at) {
    return json(res, 409, { error: "locked", hint: "この日は締め済みです。管理者にご連絡ください" });
  }

  if (action === "in") {
    if (cur?.clock_in) {
      return json(res, 409, { error: "already_in", hint: "すでに出勤を打っています" });
    }
    const row = {
      tenant_id: ctx.tenantId, employee_id: ctx.employee.id, work_date: date,
      clock_in: now, status: "open", source: "self", updated_at: now,
    };
    const saved = cur
      ? await sb.from("gw_time_entries").update(row).eq("id", cur.id).select(FIELDS).single()
      : await sb.from("gw_time_entries").insert(row).select(FIELDS).single();
    if (saved.error) return json(res, 500, { error: "db_write_failed", detail: saved.error.message });
    return json(res, 200, { ok: true, entry: shape(saved.data, new Date()) });
  }

  if (!cur?.clock_in) {
    return json(res, 409, { error: "not_in", hint: "先に出勤を打ってください" });
  }
  if (cur.clock_out) {
    return json(res, 409, { error: "already_out", hint: "すでに退勤を打っています" });
  }

  const breaks = normalizeBreaks(cur.breaks);

  if (action === "break") {
    if (onBreak(cur)) return json(res, 409, { error: "already_break", hint: "すでに休憩中です" });
    breaks.push({ start: now, end: null });
  } else if (action === "resume") {
    const open = breaks.filter((b) => !b.end).pop();
    if (!open) return json(res, 409, { error: "not_break", hint: "休憩中ではありません" });
    open.end = now;
  }

  const patch = { breaks, updated_at: now };
  if (action === "out") {
    // 休憩したまま退勤した場合は、退勤の時刻で休憩も閉じる。
    // 開いたままだと、翌日以降ずっと休憩中として数え続けてしまう
    for (const b of breaks) if (!b.end) b.end = now;
    patch.clock_out = now;
    patch.status = "closed";
  }

  const { data, error } = await sb.from("gw_time_entries")
    .update(patch).eq("id", cur.id).select(FIELDS).single();
  if (error) return json(res, 500, { error: "db_write_failed", detail: error.message });
  return json(res, 200, { ok: true, entry: shape(data, new Date()) });
}

// ---- 修正の申請 ---------------------------------------------------------------
async function requestFix(res, ctx, body) {
  const workDate = body?.workDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(workDate || ""))) {
    return json(res, 400, { error: "invalid_body", required: ["workDate"] });
  }
  const reason = String(body?.reason ?? "").trim().slice(0, 500);
  if (!reason) {
    return json(res, 400, { error: "no_reason", hint: "理由を書いてください（押し忘れ・時刻の間違いなど）" });
  }
  if (workDate > jstDate()) return json(res, 400, { error: "future", hint: "未来の日は申請できません" });

  const want = {
    clockIn: body?.want?.clockIn || null,
    clockOut: body?.want?.clockOut || null,
    breaks: normalizeBreaks(body?.want?.breaks),
    status: ["open", "closed", "absent"].includes(body?.want?.status) ? body.want.status : "closed",
  };
  const bad = validateEntry(want);
  if (bad) return json(res, 400, { error: "invalid_time", hint: bad });

  const sb = admin();
  const { data: cur } = await sb.from("gw_time_entries")
    .select("clock_in, clock_out, breaks, status, locked_at")
    .eq("employee_id", ctx.employee.id).eq("work_date", workDate).maybeSingle();

  if (cur?.locked_at) {
    return json(res, 409, { error: "locked", hint: "この月は締め済みです。管理者にご相談ください" });
  }

  // 同じ日の申請が残っているなら、新しく作らずに書き換える。
  // 何度も出されると、承認する側がどれを見ればよいか分からなくなる
  const { data: open } = await sb.from("gw_time_fixes").select("id")
    .eq("employee_id", ctx.employee.id).eq("work_date", workDate)
    .eq("status", "pending").maybeSingle();

  const row = {
    tenant_id: ctx.tenantId,
    employee_id: ctx.employee.id,
    work_date: workDate,
    want,
    before: cur ? { clockIn: cur.clock_in, clockOut: cur.clock_out, breaks: cur.breaks, status: cur.status } : null,
    reason,
    status: "pending",
  };

  const saved = open
    ? await sb.from("gw_time_fixes").update(row).eq("id", open.id).select("id").single()
    : await sb.from("gw_time_fixes").insert(row).select("id").single();
  if (saved.error) return json(res, 500, { error: "db_write_failed", detail: saved.error.message });

  // 承認する人に届ける。出したまま止まるのがいちばん困る
  try {
    const { notify } = await import("../../lib/notify.js");
    const { data: hrs } = await sb.from("gw_role_grants")
      .select("employee_id").eq("tenant_id", ctx.tenantId).in("role", ["hr", "owner"]);
    if (hrs?.length) {
      await notify([...new Set(hrs.map((h) => h.employee_id))].map((employeeId) => ({
        tenantId: ctx.tenantId, employeeId, kind: "request",
        title: `${ctx.employee.display_name}さんから打刻の修正`,
        body: `${workDate}　${reason}`,
        link: "admin-timecard.html",
        dedupeKey: `timefix:${saved.data.id}`,
      })));
    }
  } catch (e) {
    console.error("[timecard] 修正の通知を送れませんでした:", e?.message || e);
  }

  return json(res, 200, { ok: true, id: saved.data.id, updated: Boolean(open) });
}
