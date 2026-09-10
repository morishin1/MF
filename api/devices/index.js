// GET   /api/devices                       … 台帳の一覧とサマリ
// GET   /api/devices?deviceId=…            … 1台の記録
// GET   /api/devices?csv=1&from=&to=       … 書き出し
// PATCH /api/devices {action, …}           … assign / suspend / resume /
//                                             retire / note / rename
//
// ■ 見たことを残す
//   GET のたびに gw_device_views へ1行入れる。書き出しも残す。
//   本人は「自分の記録を、いつ誰が見たか」を読める。
//   見る側の記録が残らない仕組みは、監視になる。
//
// ■ ここで分かるのは「どの端末から社内システムに入ったか」まで
//   常駐ソフトは入れていない。パソコンで何をしていたかは分からないし、
//   分かるように見せない。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  isDate, jstDate, deviceState, sinceLabel, clock,
  EVENT_LABEL, SEVERITY_LABEL, CSV_HEADER, csvRow, csvCell,
} from "../../lib/devices.js";

const SQL = "db/053_devices.sql";
const FIELDS = "id, tenant_id, device_uid, label, os, os_version, browser, model, screen, "
  + "status, notified_at, installed_at, first_seen_at, last_seen_at, note, "
  + "employee_id, asset_id, retired_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 人の働き方が見える。人事・経営者だけ
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res, ctx, user);
  if (req.method === "PATCH") return patch(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "PATCH"]);
}

// ---- 見る -------------------------------------------------------------------
async function read(req, res, ctx, user) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = admin();
  const deviceId = q.get("deviceId");
  const wantCsv = q.get("csv") === "1";

  const { data: devices, error } = await sb
    .from("gw_devices").select(FIELDS)
    .eq("tenant_id", ctx.tenantId)
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1000);

  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const people = await employees(sb, ctx.tenantId);
  const policy = await policyOf(sb, ctx.tenantId);

  if (wantCsv) return csv(req, res, ctx, user, { sb, devices, people, q });
  if (deviceId) return detail(req, res, ctx, user, { sb, devices, people, deviceId, q, policy });

  // 開いているアラートを端末ごとに数える
  const counts = new Map();
  {
    const { data: al } = await sb.from("gw_device_alerts")
      .select("device_id, severity").eq("tenant_id", ctx.tenantId)
      .eq("status", "open").limit(2000);
    for (const a of al || []) {
      const c = counts.get(a.device_id) || { critical: 0, warn: 0, info: 0 };
      c[a.severity] = (c[a.severity] || 0) + 1;
      counts.set(a.device_id, c);
    }
  }

  const now = Date.now();
  const staleDays = Number(policy.stale_days) || 60;
  const rows = (devices || []).map((d) => {
    const c = counts.get(d.id) || { critical: 0, warn: 0 };
    return {
      id: d.id, label: d.label,
      os: d.os_version ? `${d.os} ${d.os_version}` : d.os,
      browser: d.browser, model: d.model, screen: d.screen,
      status: d.status,
      confirmed: Boolean(d.notified_at), notifiedAt: d.notified_at,
      installed: Boolean(d.installed_at),
      firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at,
      lastSeen: sinceLabel(d.last_seen_at, now),
      note: d.note,
      employee: people.get(d.employee_id) || null,
      openAlerts: { critical: c.critical || 0, warn: c.warn || 0 },
      state: deviceState(d, { critical: c.critical || 0, warn: c.warn || 0, staleDays, now }),
    };
  });

  const { data: recent } = await sb.from("gw_device_alerts")
    .select("id, device_id, severity, rule, title, status, occurred_at")
    .eq("tenant_id", ctx.tenantId).eq("status", "open")
    .order("occurred_at", { ascending: false }).limit(30);

  const byId = new Map(rows.map((r) => [r.id, r]));

  await logView(sb, ctx, user, { scope: "list" });

  return json(res, 200, {
    devices: rows,
    alerts: (recent || []).map((a) => ({
      id: a.id, severity: a.severity, severityLabel: SEVERITY_LABEL[a.severity] || a.severity,
      rule: a.rule, title: a.title, occurredAt: a.occurred_at,
      label: byId.get(a.device_id)?.label || "",
      employee: byId.get(a.device_id)?.employee || null,
    })),
    summary: {
      total: rows.length,
      active: rows.filter((r) => r.status === "active").length,
      waiting: rows.filter((r) => r.state.key === "waiting").length,
      stale: rows.filter((r) => r.state.key === "stale").length,
      unknown: (recent || []).filter((a) => a.rule === "unknown_device").length,
    },
    // 割り当て先の候補
    people: [...people.values()],
  });
}

// ---- 1台ぶん ----------------------------------------------------------------
async function detail(req, res, ctx, user, { sb, devices, people, deviceId, q, policy }) {
  const d = (devices || []).find((x) => x.id === deviceId);
  if (!d) return json(res, 404, { error: "not_found" });

  const to = isDate(q.get("to")) ? q.get("to") : jstDate();
  const from = isDate(q.get("from")) ? q.get("from") : back(to, 29);

  const [usage, events, alerts] = await Promise.all([
    sb.from("gw_device_usage")
      .select("work_date, active_min, night_min, holiday_min, beats, first_at, last_at")
      .eq("device_id", deviceId).gte("work_date", from).lte("work_date", to)
      .order("work_date", { ascending: false }).limit(120),
    sb.from("gw_device_events").select("id, at, work_date, kind, detail")
      .eq("device_id", deviceId).order("at", { ascending: false }).limit(60),
    sb.from("gw_device_alerts")
      .select("id, severity, rule, title, detail, status, occurred_at, decided_at, decided_note")
      .eq("device_id", deviceId).order("occurred_at", { ascending: false }).limit(60),
  ]);

  await logView(sb, ctx, user, {
    scope: "device", deviceId, employeeId: d.employee_id, workDate: to,
  });

  return json(res, 200, {
    device: {
      id: d.id, label: d.label,
      os: d.os_version ? `${d.os} ${d.os_version}` : d.os,
      browser: d.browser, model: d.model, screen: d.screen,
      status: d.status, note: d.note,
      confirmed: Boolean(d.notified_at), notifiedAt: d.notified_at,
      installed: Boolean(d.installed_at),
      firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at,
      lastSeen: sinceLabel(d.last_seen_at),
      employee: people.get(d.employee_id) || null,
      state: deviceState(d, {
        critical: (alerts.data || []).filter((a) => a.status === "open" && a.severity === "critical").length,
        warn: (alerts.data || []).filter((a) => a.status === "open" && a.severity === "warn").length,
        staleDays: Number(policy.stale_days) || 60,
      }),
    },
    range: { from, to },
    usage: (usage.data || []).map((u) => ({
      date: u.work_date,
      activeMin: u.active_min, nightMin: u.night_min, holidayMin: u.holiday_min,
      active: clock(u.active_min), night: clock(u.night_min),
      beats: u.beats, firstAt: u.first_at, lastAt: u.last_at,
    })),
    events: (events.data || []).map((e) => ({
      id: e.id, at: e.at, date: e.work_date, kind: e.kind,
      label: EVENT_LABEL[e.kind] || e.kind, detail: e.detail,
    })),
    alerts: (alerts.data || []).map((a) => ({
      id: a.id, severity: a.severity, severityLabel: SEVERITY_LABEL[a.severity] || a.severity,
      rule: a.rule, title: a.title, detail: a.detail, status: a.status,
      occurredAt: a.occurred_at, decidedAt: a.decided_at, decidedNote: a.decided_note,
    })),
  });
}

// ---- 書き出し ---------------------------------------------------------------
async function csv(req, res, ctx, user, { sb, devices, people, q }) {
  const to = isDate(q.get("to")) ? q.get("to") : jstDate();
  const from = isDate(q.get("from")) ? q.get("from") : back(to, 29);
  const byDevice = new Map((devices || []).map((d) => [d.id, d]));

  const { data } = await sb.from("gw_device_usage")
    .select("device_id, employee_id, work_date, active_min, night_min, holiday_min, first_at, last_at")
    .eq("tenant_id", ctx.tenantId)
    .gte("work_date", from).lte("work_date", to)
    .order("work_date", { ascending: true })
    .limit(20000);

  const lines = [CSV_HEADER, ...(data || []).map((u) => {
    const dev = byDevice.get(u.device_id);
    return csvRow(u, dev, people.get(u.employee_id ?? dev?.employee_id) || null);
  })];

  // 書き出しも閲覧履歴に残す。一覧で見るより、持ち出すほうが重い
  await logView(sb, ctx, user, { scope: "csv", workDate: to });

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(`端末_${from}_${to}.csv`)}`);
  // Excel が UTF-8 と分かるように BOM を付ける
  res.end("﻿" + lines.map((r) => r.map(csvCell).join(",")).join("\r\n"));
}

// ---- 変える -----------------------------------------------------------------
async function patch(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();
  const action = String(body.action || "");
  const now = new Date().toISOString();

  const deviceId = body.deviceId;
  if (!deviceId) return json(res, 400, { error: "bad_request" });

  const { data: dev } = await sb.from("gw_devices")
    .select("id, tenant_id, label, employee_id, status")
    .eq("id", deviceId).maybeSingle();
  if (!dev || dev.tenant_id !== ctx.tenantId) return json(res, 404, { error: "not_found" });

  const patchRow = { updated_at: now };
  let event = null;

  if (action === "assign") {
    const employeeId = body.employeeId || null;
    if (employeeId && !(await ownEmployee(sb, ctx.tenantId, employeeId))) {
      return json(res, 400, { error: "bad_employee" });
    }
    patchRow.employee_id = employeeId;
    if (body.assetId !== undefined) patchRow.asset_id = body.assetId || null;
    // 使う人が変わったら、告知はやり直し。
    // 前の人が読んだことを、次の人の承認にはしない
    if (employeeId !== dev.employee_id) {
      patchRow.notified_at = null;
      patchRow.status = "unconfirmed";
    }
  } else if (action === "rename") {
    const label = String(body.label || "").trim().slice(0, 60);
    if (!label) return json(res, 400, { error: "bad_request" });
    patchRow.label = label;
    event = "renamed";
  } else if (action === "suspend") {
    patchRow.status = "suspended";
    event = "suspended";
  } else if (action === "resume") {
    // 本人の確認がまだなら、確認待ちに戻す
    patchRow.status = "active";
    event = "resumed";
  } else if (action === "retire") {
    patchRow.status = "retired";
    patchRow.retired_at = now;
    event = "retired";
  } else if (action === "note") {
    patchRow.note = body.note ? String(body.note).slice(0, 1000) : null;
  } else {
    return json(res, 400, { error: "bad_action" });
  }

  const { error } = await sb.from("gw_devices").update(patchRow).eq("id", deviceId);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  if (event) {
    await sb.from("gw_device_events").insert({
      tenant_id: ctx.tenantId, device_id: deviceId,
      work_date: jstDate(), at: now, kind: event,
      detail: event === "renamed" ? { name: patchRow.label } : {},
    });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                action: `device.${action}`, target: deviceId,
                detail: { label: patchRow.label || dev.label } });
  return json(res, 200, { ok: true });
}

// ---- 小物 -------------------------------------------------------------------

/** 社員名簿。id → { id, name, department } */
async function employees(sb, tenantId) {
  const { data } = await sb.from("gw_employees")
    .select("id, display_name, department")
    .eq("tenant_id", tenantId)
    .order("display_name", { ascending: true })
    .limit(500);
  return new Map((data || []).map((e) => [e.id, {
    id: e.id, name: e.display_name, display_name: e.display_name, department: e.department,
  }]));
}

async function ownEmployee(sb, tenantId, employeeId) {
  const { data } = await sb.from("gw_employees")
    .select("id").eq("id", employeeId).eq("tenant_id", tenantId).maybeSingle();
  return Boolean(data);
}

async function policyOf(sb, tenantId) {
  const { data } = await sb.from("gw_device_policies")
    .select("stale_days").eq("tenant_id", tenantId).maybeSingle();
  return data || {};
}

/**
 * 見たことを残す。ここが落ちても、見るほうは止めない。
 * ただし console には出す。残らなくなっていることに気づけるように
 */
async function logView(sb, ctx, user, { scope, deviceId = null, employeeId = null, workDate = null }) {
  try {
    const { error } = await sb.from("gw_device_views").insert({
      tenant_id: ctx.tenantId,
      viewer_id: user.id,
      viewer_name: ctx.employee?.display_name || user.email || null,
      device_id: deviceId,
      employee_id: employeeId,
      scope,
      work_date: workDate,
    });
    if (error) throw error;
  } catch (e) {
    console.error("[devices] view log failed:", e?.message || e);
  }
}

/** YYYY-MM-DD の n 日前 */
function back(dateStr, n) {
  const t = Date.parse(`${dateStr}T00:00:00Z`) - n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
