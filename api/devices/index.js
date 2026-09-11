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
// ■ 台帳は1つ。載り方が2つある
//   source='browser' … ブラウザが持つID。社内システムに入ると自動で載る
//   source='agent'   … PCに入れた常駐ソフト
//   同じPCの両方がつながっていれば、ブラウザはPCの下にたたんで出す。
//   台帳に同じPCが2行並ぶと、何台あるのか分からなくなる。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  isDate, jstDate, deviceState, sinceLabel, clock, newEnrollToken, sha256,
  tokenDays, tokenState, TOKEN_DAYS,
  EVENT_LABEL, SEVERITY_LABEL, RULE_LABEL, CATEGORY_LABEL,
  CSV_HEADER, csvRow, csvCell,
} from "../../lib/devices.js";

// 053 → 054 → 055 の順で流す。列が足りないときも同じ案内を出す
const SQL = "db/053_devices.sql → 054_device_agent.sql → 055_device_admin.sql";
const FIELDS = "id, tenant_id, device_uid, label, source, hostname, serial, os, os_version, "
  + "os_build, browser, model, screen, agent_version, status, notified_at, installed_at, "
  + "first_seen_at, last_seen_at, note, employee_id, asset_id, retired_at, linked_device_id, "
  + "admin_touched_at, admin_touched_by, admin_touched_what";

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
  if (q.get("enrollments") === "1") {
    return enrollments(res, ctx, { sb, devices, people });
  }
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
      id: d.id, label: d.label, source: d.source,
      hostname: d.hostname,
      os: d.os_version ? `${d.os} ${d.os_version}` : d.os,
      browser: d.browser, model: d.model, screen: d.screen,
      agentVersion: d.agent_version,
      status: d.status,
      confirmed: Boolean(d.notified_at), notifiedAt: d.notified_at,
      installed: Boolean(d.installed_at),
      linkedTo: d.linked_device_id,
      firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at,
      lastSeen: sinceLabel(d.last_seen_at, now, d.source === "agent" ? "未受信" : "利用なし"),
      note: d.note,
      adminTouchedAt: d.admin_touched_at,
      adminTouchedWhat: d.admin_touched_what,
      employee: people.get(d.employee_id) || null,
      openAlerts: { critical: c.critical || 0, warn: c.warn || 0 },
      state: deviceState(d, { critical: c.critical || 0, warn: c.warn || 0, staleDays, now }),
    };
  });

  // 同じPCのブラウザは、そのPCの下にたたむ。
  // 台帳に同じPCが2行並ぶと、何台あるのか分からなくなる
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    if (r.linkedTo && byId.has(r.linkedTo)) {
      const parent = byId.get(r.linkedTo);
      (parent.browsers = parent.browsers || []).push({
        id: r.id, label: r.label, browser: r.browser,
        confirmed: r.confirmed, lastSeen: r.lastSeen,
      });
      r.foldedInto = r.linkedTo;
    }
  }

  const { data: recent } = await sb.from("gw_device_alerts")
    .select("id, device_id, severity, rule, title, status, occurred_at")
    .eq("tenant_id", ctx.tenantId).eq("status", "open")
    .order("occurred_at", { ascending: false }).limit(30);

  await logView(sb, ctx, user, { scope: "list" });

  return json(res, 200, {
    devices: rows.filter((r) => !r.foldedInto),
    folded: rows.filter((r) => r.foldedInto).length,
    alerts: (recent || []).map((a) => ({
      id: a.id, severity: a.severity, severityLabel: SEVERITY_LABEL[a.severity] || a.severity,
      rule: a.rule, ruleLabel: RULE_LABEL[a.rule] || a.rule,
      title: a.title, occurredAt: a.occurred_at,
      label: byId.get(a.device_id)?.label || "",
      employee: byId.get(a.device_id)?.employee || null,
    })),
    summary: {
      total: rows.filter((r) => !r.foldedInto).length,
      agents: rows.filter((r) => r.source === "agent").length,
      active: rows.filter((r) => r.status === "active").length,
      waiting: rows.filter((r) => r.state.key === "waiting").length,
      stale: rows.filter((r) => r.state.key === "stale").length,
      silent: rows.filter((r) => r.state.key === "silent").length,
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

  const isAgent = d.source === "agent";

  const [usage, events, alerts, apps, web, browsers] = await Promise.all([
    sb.from("gw_device_usage")
      .select("work_date, active_min, idle_min, locked_min, night_min, holiday_min, "
            + "beats, first_at, last_at")
      .eq("device_id", deviceId).gte("work_date", from).lte("work_date", to)
      .order("work_date", { ascending: false }).limit(120),
    sb.from("gw_device_events").select("id, at, work_date, kind, detail")
      .eq("device_id", deviceId).order("at", { ascending: false }).limit(120),
    sb.from("gw_device_alerts")
      .select("id, severity, rule, title, detail, status, occurred_at, decided_at, decided_note")
      .eq("device_id", deviceId).order("occurred_at", { ascending: false }).limit(60),
    // アプリとサイトはエージェントだけが送ってくる。ブラウザの行では引かない
    isAgent
      ? sb.from("gw_device_app_usage").select("work_date, exe_name, product, minutes")
          .eq("device_id", deviceId).gte("work_date", from).lte("work_date", to)
          .order("minutes", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] }),
    isAgent
      ? sb.from("gw_device_web_usage").select("work_date, category, minutes")
          .eq("device_id", deviceId).gte("work_date", from).lte("work_date", to).limit(400)
      : Promise.resolve({ data: [] }),
    // このPCの中で使われているブラウザ
    isAgent
      ? sb.from("gw_devices").select("id, label, browser, notified_at, last_seen_at")
          .eq("linked_device_id", deviceId).limit(20)
      : Promise.resolve({ data: [] }),
  ]);

  // アプリは同じ実行ファイルを日ごとに持っているので、期間ぶんを足す
  const appTotal = new Map();
  for (const a of apps.data || []) {
    const cur = appTotal.get(a.exe_name) || { exeName: a.exe_name, product: a.product, minutes: 0 };
    cur.minutes += a.minutes;
    appTotal.set(a.exe_name, cur);
  }
  const webTotal = new Map();
  for (const w of web.data || []) {
    webTotal.set(w.category, (webTotal.get(w.category) || 0) + w.minutes);
  }

  // 管理者が最後に触った人の名前
  let adminName = null;
  if (d.admin_touched_by) {
    const { data: who } = await sb.from("gw_employees")
      .select("display_name").eq("user_id", d.admin_touched_by)
      .eq("tenant_id", ctx.tenantId).maybeSingle();
    adminName = who?.display_name || null;
  }

  await logView(sb, ctx, user, {
    scope: "device", deviceId, employeeId: d.employee_id, workDate: to,
  });

  return json(res, 200, {
    device: {
      id: d.id, label: d.label, source: d.source,
      hostname: d.hostname, serial: d.serial, agentVersion: d.agent_version,
      osBuild: d.os_build,
      os: d.os_version ? `${d.os} ${d.os_version}` : d.os,
      browser: d.browser, model: d.model, screen: d.screen,
      status: d.status, note: d.note,
      confirmed: Boolean(d.notified_at), notifiedAt: d.notified_at,
      installed: Boolean(d.installed_at),
      linkedTo: d.linked_device_id,
      adminTouchedAt: d.admin_touched_at,
      adminTouchedBy: adminName,
      adminTouchedWhat: d.admin_touched_what,
      firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at,
      lastSeen: sinceLabel(d.last_seen_at, Date.now(),
        d.source === "agent" ? "未受信" : "利用なし"),
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
      activeMin: u.active_min, idleMin: u.idle_min, lockedMin: u.locked_min,
      nightMin: u.night_min, holidayMin: u.holiday_min,
      active: clock(u.active_min), idle: clock(u.idle_min), night: clock(u.night_min),
      beats: u.beats, firstAt: u.first_at, lastAt: u.last_at,
    })),
    // エージェントだけが送ってくるもの。ブラウザの行では空になる
    apps: [...appTotal.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 20)
      .map((a) => ({ ...a, label: clock(a.minutes) })),
    web: [...webTotal.entries()].sort((a, b) => b[1] - a[1])
      .map(([category, minutes]) => ({
        category, label: CATEGORY_LABEL[category] || category, minutes, time: clock(minutes),
      })),
    browsers: (browsers.data || []).map((b) => ({
      id: b.id, label: b.label, browser: b.browser,
      confirmed: Boolean(b.notified_at),
      lastSeen: sinceLabel(b.last_seen_at),
    })),
    events: (events.data || []).map((e) => ({
      id: e.id, at: e.at, date: e.work_date, kind: e.kind,
      label: EVENT_LABEL[e.kind] || e.kind, detail: e.detail,
    })),
    alerts: (alerts.data || []).map((a) => ({
      id: a.id, severity: a.severity, severityLabel: SEVERITY_LABEL[a.severity] || a.severity,
      rule: a.rule, ruleLabel: RULE_LABEL[a.rule] || a.rule,
      title: a.title, detail: a.detail, status: a.status,
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

  // 登録コードの発行。平文はここで1度だけ返す
  if (action === "issue_token") {
    const token = newEnrollToken();
    const employeeId = body.employeeId || null;
    if (employeeId && !(await ownEmployee(sb, ctx.tenantId, employeeId))) {
      return json(res, 400, { error: "bad_employee" });
    }
    // 有効期限は発行するときに選ぶ。既定は7日。長く生かしておく理由がない
    const days = tokenDays(body.expiresInDays, 7);
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

    const { data: made, error } = await sb.from("gw_device_enrollments").insert({
      tenant_id: ctx.tenantId,
      token_hash: sha256(token),
      employee_id: employeeId,
      expires_at: expiresAt,
      created_by: user.id,
    }).select("id").single();
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_query_failed", detail: error.message });
    }
    // 誰が・誰あてに・いつまでのコードを出したか。使われたときの記録は enroll.js が残す
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id,
      action: "device.token_issued", target: made.id,
      detail: {
        forEmployeeId: employeeId,
        forWhom: employeeId ? (await employees(sb, ctx.tenantId)).get(employeeId)?.name : null,
        expiresAt, days,
      },
    });
    return json(res, 200, {
      token, expiresAt, days,
      note: "このコードは1回だけ使えます。この画面を閉じると、もう出せません",
    });
  }

  // 出したコードを取り消す。行は消さない。
  // 消すと「誰がいつ何に使ったか」まで消えて、監査の役に立たなくなる
  if (action === "revoke_token") {
    if (!body.enrollmentId) return json(res, 400, { error: "bad_request" });
    const { data: enr } = await sb.from("gw_device_enrollments")
      .select("id, tenant_id, used_at, revoked_at")
      .eq("id", body.enrollmentId).maybeSingle();
    if (!enr || enr.tenant_id !== ctx.tenantId) return json(res, 404, { error: "not_found" });
    if (enr.used_at) {
      return json(res, 409, { error: "already_used",
        hint: "このコードはもう使われています。取り消しても、入った端末は止まりません。"
            + "端末のほうを停止してください" });
    }
    if (enr.revoked_at) return json(res, 200, { ok: true, already: true });

    const { error } = await sb.from("gw_device_enrollments")
      .update({ revoked_at: now, revoked_by: user.id }).eq("id", enr.id);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                  action: "device.token_revoked", target: enr.id });
    return json(res, 200, { ok: true });
  }

  const deviceId = body.deviceId;
  if (!deviceId) return json(res, 400, { error: "bad_request" });

  const { data: dev } = await sb.from("gw_devices")
    .select("id, tenant_id, label, hostname, source, employee_id, status, linked_device_id")
    .eq("id", deviceId).maybeSingle();
  if (!dev || dev.tenant_id !== ctx.tenantId) return json(res, 404, { error: "not_found" });

  // 管理者が触ったことを、台帳の行にも残す。
  // くわしい経緯は gw_activity_log を見るが、
  // 一覧を見たときに「最近誰かが動かした」と分かるほうがよい
  const patchRow = {
    updated_at: now,
    admin_touched_at: now,
    admin_touched_by: user.id,
    admin_touched_what: action,
  };
  let event = null;
  let extra = {};

  if (action === "assign") {
    const employeeId = body.employeeId || null;
    if (employeeId && !(await ownEmployee(sb, ctx.tenantId, employeeId))) {
      return json(res, 400, { error: "bad_employee" });
    }
    const before = dev.employee_id;
    patchRow.employee_id = employeeId;
    if (body.assetId !== undefined) patchRow.asset_id = body.assetId || null;
    // 使う人が変わったら、告知はやり直し。
    // 前の人が読んだことを、次の人の承認にはしない
    if (employeeId !== before) {
      patchRow.notified_at = null;
      patchRow.status = "unconfirmed";
      event = "assigned";
      const people = await employees(sb, ctx.tenantId);
      extra = {
        from: before ? people.get(before)?.name || null : null,
        to: employeeId ? people.get(employeeId)?.name || null : null,
      };
    }
  } else if (action === "unlink") {
    // パソコンとブラウザの紐付けを外す。
    // 間違って繋いだのを直すための操作で、記録は何も消さない
    if (dev.source === "agent") {
      // このパソコンを指しているブラウザを、まとめて外す
      const { data: kids } = await sb.from("gw_devices")
        .select("id, label").eq("linked_device_id", dev.id).eq("tenant_id", ctx.tenantId);
      if (kids?.length) {
        await sb.from("gw_devices")
          .update({ linked_device_id: null, updated_at: now })
          .eq("linked_device_id", dev.id).eq("tenant_id", ctx.tenantId);
      }
      extra = { unlinked: (kids || []).map((k) => k.label) };
    } else {
      if (!dev.linked_device_id) {
        return json(res, 200, { ok: true, already: true });
      }
      patchRow.linked_device_id = null;
      extra = { from: dev.linked_device_id };
    }
    event = "unlinked";
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
      detail: event === "renamed" ? { name: patchRow.label }
        : event === "assigned" ? { name: extra.to || "（割り当てなし）" }
        : {},
    });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                action: `device.${action}`, target: deviceId,
                detail: { label: patchRow.label || dev.hostname || dev.label,
                          source: dev.source, ...extra } });
  return json(res, 200, { ok: true, ...extra });
}

// ---- 登録コードの履歴（監査） -------------------------------------------------
/**
 * 誰がいつ発行して、いつ・どの端末に使われたか。
 *
 * 使ったコードも取り消したコードも消さない。
 * 監査で見たいのは「コードがある」ことではなく「何に使われたか」のほう。
 */
async function enrollments(res, ctx, { sb, devices, people }) {
  const { data, error } = await sb.from("gw_device_enrollments")
    .select("id, employee_id, expires_at, used_at, used_by, revoked_at, revoked_by, "
          + "created_by, created_at")
    .eq("tenant_id", ctx.tenantId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  // 発行者・取り消した人は auth.users。名簿から名前を引く
  const byUser = new Map();
  {
    const ids = [...new Set((data || [])
      .flatMap((r) => [r.created_by, r.revoked_by]).filter(Boolean))];
    if (ids.length) {
      const { data: emp } = await sb.from("gw_employees")
        .select("user_id, display_name").eq("tenant_id", ctx.tenantId).in("user_id", ids);
      for (const e of emp || []) byUser.set(e.user_id, e.display_name);
    }
  }
  const byDevice = new Map((devices || []).map((d) => [d.id, d]));
  const now = Date.now();

  return json(res, 200, {
    enrollments: (data || []).map((r) => {
      const dev = byDevice.get(r.used_by);
      return {
        id: r.id,
        issuedBy: byUser.get(r.created_by) || "（不明）",
        issuedAt: r.created_at,
        forWhom: people.get(r.employee_id)?.name || null,
        expiresAt: r.expires_at,
        usedAt: r.used_at,
        usedBy: dev ? (dev.hostname || dev.label) : null,
        usedDeviceId: r.used_by,
        revokedAt: r.revoked_at,
        revokedBy: r.revoked_by ? (byUser.get(r.revoked_by) || "（不明）") : null,
        state: tokenState(r, now),
      };
    }),
    tokenDays: TOKEN_DAYS,
  });
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
