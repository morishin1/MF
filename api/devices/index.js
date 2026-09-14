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
import { gwContext, canManageHr, canWipeDevice } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notify } from "../../lib/notify.js";
import {
  isDate, jstDate, deviceState, sinceLabel, clock, newEnrollToken, sha256,
  tokenDays, tokenState, TOKEN_DAYS,
  EVENT_LABEL, SEVERITY_LABEL, RULE_LABEL, CATEGORY_LABEL,
  CSV_HEADER, csvRow, csvCell,
  browserLabel, browserState, ownershipState, OWNERSHIP,
} from "../../lib/devices.js";

// 053 → 054 → 055 の順で流す。列が足りないときも同じ案内を出す
const SQL = "db/053_devices.sql → 054_device_agent.sql → 055_device_admin.sql";
const FIELDS = "id, tenant_id, device_uid, label, source, hostname, serial, os, os_version, "
  + "os_build, browser, model, screen, agent_version, status, notified_at, installed_at, "
  + "first_seen_at, last_seen_at, note, employee_id, asset_id, retired_at, linked_device_id, "
  + "admin_touched_at, admin_touched_by, admin_touched_what, "
  + "ownership, notified_kind, notified_note";

// 064（端末の一生）で足した列。本体と分けてある。
//
// まだ 064 を流していない環境で、無い列を SELECT すると
// そのリクエストごと落ちる。端末の一覧と詳細が丸ごと開かなくなるので、
// まず足したほうで引いて、だめなら本体だけで引き直す
const LIFE_FIELDS = "revoked_at, lost_at, wipe_requested_at, wipe_requested_by, "
  + "wipe_reason, wipe_done_at, deleted_at";

/**
 * 台帳を読む。064 がまだでも開けるようにする。
 * @returns {Promise<{data:object[]|null, error:object|null, life:boolean}>}
 */
async function readDevices(sb, tenantId) {
  const q = (cols) => sb.from("gw_devices").select(cols)
    .eq("tenant_id", tenantId)
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1000);
  const first = await q(`${FIELDS}, ${LIFE_FIELDS}`);
  if (!first.error) return { ...first, life: true };
  const again = await q(FIELDS);
  return { ...again, life: false };
}

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

  const { data: all, error } = await readDevices(sb, ctx.tenantId);

  // 消え終わった端末は、台帳から外す。行は消さない（過去の記録が宙に浮く）。
  // 「削除済みも見る」を押したときだけ出す
  const withDeleted = q.get("deleted") === "1";
  const devices = withDeleted ? all : (all || []).filter((d) => !d.deleted_at);
  const deletedCount = (all || []).length - (devices || []).length;

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
  // 1台ぶんは、台帳から外したものも開ける。
  // 「消えたあと、あの端末に何があったか」を見るのは監査の入口なので、
  // 一覧に出さないことと、開けないことは別
  if (deviceId) return detail(req, res, ctx, user, { sb, devices: all, people, deviceId, q, policy });

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

  // 私物利用の承認。行ごとに「業務に使ってよいか」を出すのに要る。
  // 060 を流していない環境でも落とさない
  let exceptions = [];
  try {
    const { data } = await sb.from("gw_device_exceptions")
      .select("id, employee_id, device_id, reason, expires_on, revoked_at")
      .eq("tenant_id", ctx.tenantId).limit(500);
    exceptions = data || [];
  } catch (e) { /* 表がまだ無い */ }
  const exByEmp = new Map();
  for (const e of exceptions) {
    if (!exByEmp.has(e.employee_id)) exByEmp.set(e.employee_id, []);
    exByEmp.get(e.employee_id).push(e);
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
      // 会社貸与か私物か。私物PCでの業務利用は禁止なので、行に出す
      ownership: d.ownership || "unknown",
      own: ownershipState(d, { exceptions: exByEmp.get(d.employee_id) || [] }),
      // 周知を、本人が押したのか、管理者が対面で行ったのか
      notifiedKind: d.notified_kind || null,
      notifiedNote: d.notified_note || null,
      // 端末の一生（064）。画面の「…」で何を出すかを、ここで決める
      life: {
        revoked: Boolean(d.revoked_at),
        lost: Boolean(d.lost_at),
        wiping: Boolean(d.wipe_requested_at) && !d.wipe_done_at,
        wipeRequestedAt: d.wipe_requested_at || null,
        wipeReason: d.wipe_reason || null,
        wipedAt: d.wipe_done_at || null,
        deleted: Boolean(d.deleted_at),
      },
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

  // ---- 1台のPCの中の、ブラウザごとの状態 ----
  //
  // 人から見れば1台なので、Agent と Chrome と Edge を別の行にしない。
  // 「入っているのに、つながっていない」が分かるようにする
  const { data: brs } = await sb.from("gw_device_browsers")
    .select("device_id, browser, installed, linked, ext_version, last_seen_at")
    .eq("tenant_id", ctx.tenantId);
  for (const b of brs || []) {
    const row = byId.get(b.device_id);
    if (!row) continue;
    (row.links = row.links || []).push({
      browser: b.browser, label: browserLabel(b.browser),
      installed: b.installed, linked: b.linked,
      extVersion: b.ext_version,
      lastSeen: sinceLabel(b.last_seen_at, now, "未受信"),
      state: browserState(b, now),
    });
  }
  for (const r of rows) {
    if (r.links) r.links.sort((a, b2) => a.browser.localeCompare(b2.browser));
  }

  const { data: recent } = await sb.from("gw_device_alerts")
    .select("id, device_id, severity, rule, title, status, occurred_at")
    .eq("tenant_id", ctx.tenantId).eq("status", "open")
    .order("occurred_at", { ascending: false }).limit(30);

  // 未確認の件数は、上の30件とは別に数える。
  // 30件で切った数を「残り件数」として出すと、31件目から嘘になる
  const { count: openWarn } = await sb.from("gw_device_alerts")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenantId).eq("status", "open")
    .in("severity", ["warn", "critical"]);

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
      // 管理者が「確認した」を押していないもの。
      // 一覧を開かなくても件数だけは分かるようにする（管理画面TOPで使う）
      openAlerts: openWarn || 0,
      // 会社貸与と確かめられていないパソコン。
      // 業務は原則、会社貸与PCだけと決めてある
      unmanaged: rows.filter((r) => !r.foldedInto && r.own?.key === "check").length,
      banned: rows.filter((r) => !r.foldedInto && r.own?.key === "banned").length,
      // 消せと言ってあるが、まだそのPCから報せが来ていないもの
      wiping: rows.filter((r) => !r.foldedInto && r.life?.wiping).length,
    },
    // 台帳から外した端末の数。0 のときは画面に何も出さない
    deleted: deletedCount,
    showingDeleted: withDeleted,
    // 削除・紛失を押せる人か。押せない人には、その項目を出さない
    canWipe: canWipeDevice(ctx),
    // 割り当て先の候補
    people: [...people.values()],
    ownerships: OWNERSHIP,
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

  // その人に出ている私物利用の承認
  let myExceptions = [];
  try {
    const { data } = await sb.from("gw_device_exceptions")
      .select("id, employee_id, device_id, reason, expires_on, revoked_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", d.employee_id || "").limit(50);
    myExceptions = data || [];
  } catch (e) { /* 060 がまだ */ }

  // 管理者が最後に触った人の名前
  let adminName = null;
  if (d.admin_touched_by) {
    const { data: who } = await sb.from("gw_employees")
      .select("display_name").eq("user_id", d.admin_touched_by)
      .eq("tenant_id", ctx.tenantId).maybeSingle();
    adminName = who?.display_name || null;
  }

  // 誰が削除を指示したか。監査ログにも残るが、
  // 「削除待ち」の行を見ている人が、その場で分かるほうがよい
  let wiperName = null;
  if (d.wipe_requested_by) {
    const { data: who } = await sb.from("gw_employees")
      .select("display_name").eq("user_id", d.wipe_requested_by)
      .eq("tenant_id", ctx.tenantId).limit(1).maybeSingle();
    wiperName = who?.display_name || null;
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
      // 周知を、本人が押したのか、管理者が対面・書面で行ったのか
      notifiedKind: d.notified_kind || null,
      notifiedNote: d.notified_note || null,
      // 会社貸与か私物か。私物PCでの業務利用は禁止
      ownership: d.ownership || "unknown",
      own: ownershipState(d, { exceptions: myExceptions }),
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
      // 端末の一生（064）。「…」に何を出すか、画面はここを見る
      life: {
        revoked: Boolean(d.revoked_at), revokedAt: d.revoked_at || null,
        lost: Boolean(d.lost_at), lostAt: d.lost_at || null,
        wiping: Boolean(d.wipe_requested_at) && !d.wipe_done_at,
        wipeRequestedAt: d.wipe_requested_at || null,
        wipeRequestedBy: wiperName,
        wipeReason: d.wipe_reason || null,
        wipedAt: d.wipe_done_at || null,
        wipeNote: d.wipe_note || null,
        deleted: Boolean(d.deleted_at),
      },
    },
    canWipe: canWipeDevice(ctx),
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

  // 登録コードの発行は、もうしない。
  //
  // 社員はグループウェアにログインしている。誰なのかはもう分かっている。
  // コードを配って打たせるのは、配る手間と打ち間違いを足しているだけで、
  // 確かめられることは増えていない。
  //
  // いまは本人がマイページから始める（api/devices/setup.js）。
  // 過去に出したコードの記録（gw_device_enrollments）は監査のため残してある
  if (action === "issue_token") {
    return json(res, 410, {
      error: "gone",
      hint: "登録コードは使わなくなりました。"
          + "本人がマイページの「会社PCのセキュリティ設定」から登録します",
    });
  }

  // 確認待ちの人に、押してくださいと知らせる。
  //
  // 押すまで利用時間を1分も数えないので、押されないまま溜まると
  // 台帳が空のまま増えていく。週1回ゼロにする運用の、その1回ぶん。
  //
  // 端末は動かさない。送るのは知らせだけ
  if (action === "nudge_waiting") {
    const { data: waiting, error } = await sb.from("gw_devices")
      .select("id, employee_id, label, hostname, source, first_seen_at")
      .eq("tenant_id", ctx.tenantId)
      .is("notified_at", null)
      .in("status", ["active", "unconfirmed"])
      .limit(500);
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_query_failed", detail: error.message });
    }

    // 1人が3台放っていても、知らせは1通。
    // 台数ぶん届くと、読まれずに消される
    const byEmp = new Map();
    for (const d of waiting || []) {
      if (!d.employee_id) continue;
      const cur = byEmp.get(d.employee_id) || { n: 0, label: "" };
      cur.n += 1;
      if (!cur.label) cur.label = d.hostname || d.label || "";
      byEmp.set(d.employee_id, cur);
    }
    if (!byEmp.size) return json(res, 200, { sent: 0, people: 0 });

    await notify([...byEmp.entries()].map(([employeeId, v]) => ({
      tenantId: ctx.tenantId,
      employeeId,
      kind: "device_confirm",
      title: v.n > 1
        ? `確認していない端末が ${v.n}台 あります`
        : `${v.label || "端末"} の確認をお願いします`,
      body: "マイページの「端末の設定」を開いて、記録することを読んでから"
          + "「このパソコンです」を押してください。押すまで記録は始まりません。",
      link: "device-consent.html",
      // 1人につき1通。押すまで何度促しても、同じ1通を新しくするだけ
      dedupeKey: "device_confirm",
    })));

    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id,
      action: "device.nudge_waiting", target: null,
      detail: { people: byEmp.size, devices: (waiting || []).length },
    });
    return json(res, 200, { sent: byEmp.size, people: byEmp.size, devices: (waiting || []).length });
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
    .select("id, tenant_id, label, hostname, source, employee_id, status, linked_device_id, "
          + "ownership, notified_at")
    .eq("id", deviceId).maybeSingle();
  if (!dev || dev.tenant_id !== ctx.tenantId) return json(res, 404, { error: "not_found" });

  // 一生ぶんの列は別に取る。064 をまだ流していない環境で、
  // 無い列を SELECT するとこのリクエストごと落ちる（＝画面が全部止まる）
  const life = await lifeOf(sb, deviceId);

  // 取り消せない操作だけ、権限をもう一段上げる。
  // 一覧からワンクリックでは出していないが、API を直に叩けば同じなので、
  // 止めるのはここ
  if (["wipe", "cancel_wipe", "lost"].includes(action) && !canWipeDevice(ctx)) {
    return json(res, 403, {
      error: "forbidden",
      hint: "端末の削除・紛失の登録は、管理者と経営者だけができます",
    });
  }

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
    // 使う人が変わったら、周知はやり直し。
    // 前の人が読んだことを、次の人に周知したことにはしない
    if (employeeId !== before) {
      patchRow.notified_at = null;
      patchRow.notified_kind = null;
      patchRow.notified_by = null;
      patchRow.notified_note = null;
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
  } else if (action === "ext_unlink" || action === "ext_reinvite") {
    // ブラウザ拡張の登録を、管理者が外す。
    //
    // ■ 社員側にこの操作は出していない
    //
    //   自分で外せると、私物や未登録のパソコンで入ったあと
    //   登録を外して見えなくする、という道ができる。
    //   だから外せるのは管理者だけ、と決めてある（api/devices/me.js の forget）。
    //   その「管理者だけ」の実体がここ。
    //
    // ■ 記録は消さない
    //
    //   消すのは資格情報（secret_hash）と「登録済み」の印だけ。
    //   これまでの WEB利用も、できごとも、そのまま残る。
    //   外した事実も、下で できごと と 監査ログ の両方に残す。
    //
    // ■ 「再登録」は、こちらから入れ直すことはできない
    //
    //   拡張はブラウザの中にあって、サーバからは入れられない。
    //   できるのは、いまの登録をきれいに外して、
    //   本人に「マイページから登録してください」と知らせるところまで。
    //   押した管理者に、そう分かる返事を返す
    if (dev.source !== "browser") {
      return json(res, 400, {
        error: "bad_request",
        hint: "ブラウザの登録に対する操作です。パソコン（常駐ソフト）の行では使えません",
      });
    }
    patchRow.secret_hash = null;
    patchRow.installed_at = null;
    // 「いつから届かないか」も下ろす。外したあとまで数え続けると、
    // 管理者が外したものが「連携異常」として赤く出続ける
    extra = { extCleared: true };
    event = action === "ext_unlink" ? "ext_unlinked" : "ext_reinvited";

    await sb.from("gw_device_browsers")
      .update({ linked: false, updated_at: now })
      .eq("device_id", dev.id).eq("tenant_id", ctx.tenantId);

    // 067 をまだ流していない環境でも、外すことそのものは通す
    try {
      await sb.from("gw_devices").update({ ext_missing_since: null }).eq("id", dev.id);
    } catch (e) { /* 067 がまだ */ }

    if (action === "ext_reinvite" && dev.employee_id) {
      await notify([{
        tenantId: ctx.tenantId,
        employeeId: dev.employee_id,
        kind: "device_confirm",
        title: "パソコンの登録をやり直してください",
        body: "ブラウザ拡張からの通信が確認できないため、登録を一度外しました。"
            + "マイページを開いて、もう一度このパソコンを登録してください。",
        link: "mypage.html",
        dedupeKey: "device_ext_reinvite",
      }]);
      extra.notified = true;
    }
  } else if (action === "ownership") {
    // 会社貸与か私物か。
    // 私物PCでの業務利用は禁止なので、ここを付けると管理画面で目立つ
    const own = String(body.ownership || "");
    if (!["company", "personal", "unknown"].includes(own)) {
      return json(res, 400, { error: "bad_request" });
    }
    patchRow.ownership = own;
    event = "ownership";
    extra = { from: dev.ownership, to: own };
  } else if (action === "mark_notified") {
    // 管理者が対面・書面で周知したときの記録。
    //
    // 端末管理は会社ルールなので、本人が押さないことが拒否にはならない。
    // ただし「周知した」と誰かが言うだけでは記録にならないので、
    // いつ・どう周知したかを必ず書かせる
    const note = String(body.note || "").trim().slice(0, 300);
    if (!note) {
      return json(res, 400, {
        error: "bad_request",
        hint: "いつ・どこで・どう周知したかを書いてください（記録に残ります）",
      });
    }
    if (dev.notified_at) return json(res, 200, { ok: true, already: true });
    patchRow.notified_at = now;
    patchRow.notified_kind = "admin";
    patchRow.notified_by = user.id;
    patchRow.notified_note = note;
    patchRow.status = "active";
    event = "notified_by_admin";
    extra = { note };
  } else if (action === "rename") {
    const label = String(body.label || "").trim().slice(0, 60);
    if (!label) return json(res, 400, { error: "bad_request" });
    patchRow.label = label;
    event = "renamed";
  } else if (action === "suspend") {
    // すぐに送信を止める。資格情報はそのまま。あとで再開できる。
    // 修理に出す・長期休職・様子を見たい、のときはこれ
    patchRow.status = "suspended";
    event = "suspended";
  } else if (action === "resume") {
    // 本人の確認がまだなら、確認待ちに戻す
    patchRow.status = "active";
    // 紛失として止めていたなら、そこも戻す。
    // 「見つかったので、また使う」が1回で済むように
    if (life.lost_at || life.revoked_at) {
      patchRow.lost_at = null;
      patchRow.revoked_at = null;
      patchRow.revoked_by = null;
      extra = { lostCleared: true };
    }
    // 削除待ちのものを、再開では戻さない。
    // 消えたかもしれないPCを「使える」ことにすると、台帳が嘘になる
    if (life.wipe_requested_at && !life.wipe_done_at) {
      return json(res, 409, {
        error: "wipe_pending",
        hint: "この端末は削除待ちです。使い続けるなら、先に削除を取り消してください",
      });
    }
    event = "resumed";
  } else if (action === "retire") {
    patchRow.status = "retired";
    patchRow.retired_at = now;
    event = "retired";
  } else if (action === "lost") {
    // 紛失。止めるだけでなく、資格情報をその場で失効させる。
    //
    // 手元に無いPCから記録が届き続けるほうが困る。
    // 削除と違って、そのPCの中のエージェントは消さない
    // （消せという命令を届けるには、そのPCが手元に戻るか、
    //   ネットにつながる必要がある。戻ったときは「端末を削除」を押す）
    patchRow.status = "suspended";
    patchRow.lost_at = now;
    patchRow.revoked_at = now;
    patchRow.revoked_by = user.id;
    event = "lost";
  } else if (action === "wipe") {
    // 端末を削除。資格情報を失効させ、そのPCに「自分を消せ」と置く。
    //
    // ここでできるのは、失効と、命令を置くところまで。
    // 実際に消えるのは、そのPCが次にサーバへ来たとき。
    // 消えたかどうかは api/devices/wiped が呼ばれてはじめて分かるので、
    // それまでは「削除待ち」と出す
    if (life.wipe_requested_at && !life.wipe_done_at) {
      return json(res, 200, { ok: true, already: true, pending: true });
    }
    if (life.wipe_done_at) return json(res, 200, { ok: true, already: true });
    patchRow.status = "retired";
    patchRow.retired_at = now;
    patchRow.revoked_at = now;
    patchRow.revoked_by = user.id;
    patchRow.wipe_requested_at = now;
    patchRow.wipe_requested_by = user.id;
    patchRow.wipe_reason = String(body.reason || "").trim().slice(0, 200) || null;
    event = "wipe_requested";
    extra = { reason: patchRow.wipe_reason };
    // ブラウザ側の行も道連れにしない。あれは別の端末として数えている。
    // ただし、消えるPCを指したままにしておくと、
    // 台帳に親のいない行が残る
    await sb.from("gw_devices")
      .update({ linked_device_id: null, updated_at: now })
      .eq("linked_device_id", dev.id).eq("tenant_id", ctx.tenantId);
  } else if (action === "cancel_wipe") {
    // 押し間違えた。まだそのPCが取りにきていなければ、戻せる。
    // 取りにきたあとは戻らない（もう消えている）
    if (!life.wipe_requested_at) return json(res, 200, { ok: true, already: true });
    if (life.wipe_done_at) {
      return json(res, 409, {
        error: "already_wiped",
        hint: "この端末はもう消え終わっています。使うなら、入れ直してください",
      });
    }
    patchRow.wipe_requested_at = null;
    patchRow.wipe_requested_by = null;
    patchRow.wipe_reason = null;
    patchRow.revoked_at = null;
    patchRow.revoked_by = null;
    patchRow.status = "suspended";
    event = "wipe_canceled";
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
  // 誰が・いつ・**誰の**端末を変えたか。
  // 端末のIDだけ残しても、あとから読む人には誰のことか分からない。
  // 台帳の行が消えたり付け替わったりしても、監査ログのほうは読めるようにする
  let whose = null;
  if (dev.employee_id) {
    const { data: who } = await sb.from("gw_employees")
      .select("display_name").eq("id", dev.employee_id)
      .eq("tenant_id", ctx.tenantId).limit(1).maybeSingle();
    whose = who?.display_name || null;
  }

  await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                action: `device.${action}`, target: deviceId,
                detail: { label: patchRow.label || dev.hostname || dev.label,
                          source: dev.source,
                          employeeId: dev.employee_id || null, employee: whose,
                          ...extra } });
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

/**
 * 端末の一生ぶんの列（064）。
 *
 * 本体の SELECT に混ぜない。064 をまだ流していない環境で
 * 無い列を SELECT すると、そのリクエストごと落ちる。
 * 端末の一覧と詳細が全部開かなくなるので、ここは別に取って、
 * 取れなければ「何も起きていない」として扱う
 */
async function lifeOf(sb, deviceId) {
  try {
    const { data, error } = await sb.from("gw_devices")
      .select("revoked_at, lost_at, wipe_requested_at, wipe_done_at, deleted_at")
      .eq("id", deviceId).maybeSingle();
    if (error || !data) return {};
    return data;
  } catch (e) {
    return {};
  }
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
