// 週1回でゼロにする運用まわり。
//
//   ・WEB履歴が90日で消えること
//   ・昨日の「△ 要確認」がアラートとして残ること
//   ・確認待ちが放置されたら知らせること
//   ・確認待ちの人に、まとめてお知らせを送れること
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, writes: [] };
const deleted = [];

function table(name) {
  const f = [];
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    in(k, vs) { f.push([k, vs]); return q; },
    is(k, v) { f.push(["is:" + k, v]); return q; },
    not(k, op, v) { f.push(["not:" + k, v]); return q; },
    gte(k, v) { f.push([">=" + k, v]); return q; },
    lte(k, v) { f.push(["<=" + k, v]); return q; },
    lt(k, v) { f.push(["<" + k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle() { return Promise.resolve({ data: match(name, f)[0] || null, error: err(name) }); },
    single() { return Promise.resolve({ data: match(name, f)[0] || null, error: err(name) }); },
    then(fn) {
      const rows = match(name, f);
      return Promise.resolve({ data: rows, error: err(name), count: rows.length }).then(fn);
    },
    upsert(rows, opts) {
      db.writes.push({ op: "upsert", table: name, rows: [].concat(rows), opts });
      const list = db.rows[name] = db.rows[name] || [];
      for (const r of [].concat(rows)) {
        // onConflict を真似る。同じ dedupe_key は増やさない
        const dup = list.some((x) => x.device_id === r.device_id && x.dedupe_key === r.dedupe_key);
        if (!dup) list.push({ id: `a-${list.length + 1}`, status: "open", ...r });
      }
      const rr = { select: () => rr, single: () => Promise.resolve({ data: null, error: err(name) }),
                   then: (fn) => Promise.resolve({ data: [].concat(rows), error: err(name) }).then(fn) };
      return rr;
    },
    insert(row) {
      db.writes.push({ op: "insert", table: name, row });
      const made = { id: `new-${db.writes.length}`, ...row };
      (db.rows[name] = db.rows[name] || []).push(made);
      const r = { select: () => r, single: () => Promise.resolve({ data: made, error: null }),
                  then: (fn) => Promise.resolve({ data: [made], error: null }).then(fn) };
      return r;
    },
    update(row) {
      db.writes.push({ op: "update", table: name, row });
      const r = { eq: () => r, is: () => r, in: () => r, select: () => r,
                  single: () => Promise.resolve({ data: row, error: null }),
                  then: (fn) => Promise.resolve({ data: [row], error: null }).then(fn) };
      return r;
    },
    delete(opts) {
      const g = [];
      const run = () => {
        const hit = match(name, g);
        deleted.push({ table: name, filters: [...g], rows: hit });
        db.rows[name] = (db.rows[name] || []).filter((r) => !hit.includes(r));
        return { data: hit, error: err(name), count: hit.length };
      };
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        in: (k, v) => { g.push([k, v]); return r; },
        is: (k, v) => { g.push(["is:" + k, v]); return r; },
        not: (k, o, v) => { g.push(["not:" + k, v]); return r; },
        lt: (k, v) => { g.push(["<" + k, v]); return r; },
        select: () => r,
        then: (fn) => Promise.resolve(run()).then(fn),
      };
      return r;
    },
  };
  return q;
}
const err = (name) => (db.missing?.includes(name)
  ? { code: "PGRST205", message: "Could not find the table" } : null);
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) => {
  if (k.startsWith("is:")) { const kk = k.slice(3); return v === null ? r[kk] == null : r[kk] === v; }
  if (k.startsWith("not:")) return r[k.slice(4)] != null;
  if (k.startsWith("<")) return String(r[k.slice(1)] ?? "") < String(v);
  if (k.startsWith(">=")) return String(r[k.slice(2)] ?? "") >= String(v);
  if (k.startsWith("<=")) return String(r[k.slice(2)] ?? "") <= String(v);
  return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
}));

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
let signedIn = { id: "u-1", email: "zimu@8grp.co.jp" };
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => signedIn, getMemberships: async () => [] },
});
let ctxNow = null;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => ctxNow, canManageHr: () => ctxNow.isHr },
});
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const notified = [];
mock.module(atRoot("lib/notify.js"), {
  namedExports: {
    notify: async (rows) => { notified.push(...rows); return { created: rows.length }; },
    clearNotification: async () => {},
  },
});
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => {} } });
mock.module(atRoot("lib/expenses.js"), {
  namedExports: { canReviewExpense: () => false },
});

const { default: cron } = await import(atRoot("api/cron/devices.js"));
const { default: exceptions } = await import(atRoot("api/devices/exceptions.js"));
const { default: devs } = await import(atRoot("api/devices/index.js"));
const { default: badges } = await import(atRoot("api/badges.js"));
const D = await import(atRoot("lib/devices.js"));

// ---- 偽の req/res ---------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const o = res(); await h(req, o); return o; };
const get = (path, qs = "") => ({ method: "GET", url: `${path}${qs}`, headers: { authorization: "Bearer x" } });
const patch = (body) => ({ method: "PATCH", url: "/api/devices", body, headers: { authorization: "Bearer x" } });

const HR = { tenantId: "t1", isAdmin: true, isHr: true, roles: ["hr"],
             employee: { id: "emp-hr", display_name: "事務" } };

const day = (n) => new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
const TODAY = day(0);
const YDAY = day(-1);

const reset = () => {
  db.rows = {
    gw_devices: [], gw_device_policies: [], gw_device_usage: [], gw_device_events: [],
    gw_device_alerts: [], gw_device_views: [], gw_device_app_usage: [],
    gw_device_web_usage: [], gw_device_web_visits: [], gw_device_browsers: [],
    gw_time_entries: [], gw_employees: [], gw_notifications: [],
    gw_device_exceptions: [],
  };
  db.writes = []; db.missing = null; logged.length = 0;
  notified.length = 0; deleted.length = 0;
  ctxNow = HR;
};

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log("  ok", name); };

const agent = (over = {}) => ({
  id: "d1", tenant_id: "t1", employee_id: "emp-1", device_uid: "u1",
  label: "8GRP-PC-01", hostname: "8GRP-PC-01", source: "agent", status: "active",
  notified_at: "2026-09-01T00:00:00Z", last_seen_at: new Date().toISOString(),
  first_seen_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", ...over,
});
const visit = (over = {}) => ({
  id: 1, tenant_id: "t1", device_id: "d1", employee_id: "emp-1",
  work_date: YDAY, category: "sns", active_sec: 600, in_work_hours: true,
  host: "x.com", path: "", started_at: `${YDAY}T02:00:00Z`, ...over,
});

// =============================================================================
console.log("\n== WEB履歴の保存期間（90日）==");

await ok("90日より古い履歴は消える", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_web_visits = [
    visit({ id: 1, work_date: day(-91) }),
    visit({ id: 2, work_date: day(-89) }),
    visit({ id: 3, work_date: TODAY }),
  ];
  await call(cron, get("/api/cron/devices"));
  const left = db.rows.gw_device_web_visits.map((v) => v.id).sort();
  assert.deepEqual(left, [2, 3], "90日を過ぎたぶんだけ消える");
});

await ok("会社ごとの設定で日数を変えられる", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_policies = [{ tenant_id: "t1", keep_visits_days: 30 }];
  db.rows.gw_device_web_visits = [
    visit({ id: 1, work_date: day(-31) }),
    visit({ id: 2, work_date: day(-29) }),
  ];
  await call(cron, get("/api/cron/devices"));
  assert.deepEqual(db.rows.gw_device_web_visits.map((v) => v.id), [2]);
});

await ok("よその会社の履歴は消さない", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_web_visits = [
    visit({ id: 1, work_date: day(-200) }),
    visit({ id: 2, tenant_id: "t2", work_date: day(-200) }),
  ];
  await call(cron, get("/api/cron/devices"));
  assert.deepEqual(db.rows.gw_device_web_visits.map((v) => v.id), [2],
    "自分の会社のぶんだけ消す");
});

// =============================================================================
console.log("\n== 昨日の「△ 要確認」を残す ==");

await ok("勤務中の SNS・動画が続いたら、確認する先ができる", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  // 既定は90分。100分ぶん
  db.rows.gw_device_web_visits = [visit({ active_sec: 100 * 60 })];
  const r = await call(cron, get("/api/cron/devices"));
  assert.equal(r.statusCode, 200);

  const a = db.rows.gw_device_alerts.find((x) => x.rule === "distract_in_work");
  assert.ok(a, "アラートになる");
  assert.equal(a.severity, "warn", "critical にはしない（不正と決めつけない）");
  assert.equal(a.status, "open", "確認するまで残る");
  assert.equal(a.detail.employeeId, "emp-1", "誰のことか分かる");
  assert.equal(a.device_id, "d1");
});

await ok("しきい値に届かなければ、何も出さない", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_web_visits = [visit({ active_sec: 30 * 60 })];
  await call(cron, get("/api/cron/devices"));
  assert.equal(db.rows.gw_device_alerts.filter((a) => a.rule === "distract_in_work").length, 0);
});

await ok("勤務時間外のぶんは数えない", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_web_visits = [visit({ active_sec: 300 * 60, in_work_hours: false })];
  await call(cron, get("/api/cron/devices"));
  assert.equal(db.rows.gw_device_alerts.filter((a) => a.rule === "distract_in_work").length, 0,
    "働き方を見るのは勤務時間内だけ、と社員に言ってある");
});

await ok("2回まわしても、同じ日のぶんは増えない", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_web_visits = [visit({ active_sec: 100 * 60 })];
  await call(cron, get("/api/cron/devices"));
  await call(cron, get("/api/cron/devices"));
  assert.equal(db.rows.gw_device_alerts.filter((a) => a.rule === "distract_in_work").length, 1);
});

await ok("勤務しているのに操作がほとんど無ければ、確認を促す", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_web_visits = [visit({ active_sec: 60 })];
  db.rows.gw_device_usage = [
    { tenant_id: "t1", device_id: "d1", work_date: YDAY, active_min: 20, night_min: 0 },
  ];
  db.rows.gw_time_entries = [{
    tenant_id: "t1", employee_id: "emp-1", work_date: YDAY,
    clock_in: `${YDAY}T00:00:00Z`, clock_out: `${YDAY}T09:00:00Z`,
  }];
  await call(cron, get("/api/cron/devices"));
  const a = db.rows.gw_device_alerts.find((x) => x.rule === "no_activity");
  assert.ok(a, "9時間の勤務で操作20分なら、確かめる");
  assert.equal(a.severity, "warn");
});

await ok("退勤を押していない日は、長時間の勤務として扱わない", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_web_visits = [visit({ active_sec: 60 })];
  db.rows.gw_device_usage = [
    { tenant_id: "t1", device_id: "d1", work_date: YDAY, active_min: 20, night_min: 0 },
  ];
  db.rows.gw_time_entries = [{
    tenant_id: "t1", employee_id: "emp-1", work_date: YDAY,
    clock_in: `${YDAY}T00:00:00Z`, clock_out: null,
  }];
  await call(cron, get("/api/cron/devices"));
  assert.equal(db.rows.gw_device_alerts.filter((a) => a.rule === "no_activity").length, 0,
    "押し忘れを理由に毎回引っかかると、誰も見なくなる");
});

await ok("深夜のWEB利用は、1時間から", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_web_visits = [visit({ active_sec: 60 })];
  db.rows.gw_device_usage = [
    { tenant_id: "t1", device_id: "d1", work_date: YDAY, active_min: 300, night_min: 90 },
  ];
  await call(cron, get("/api/cron/devices"));
  const a = db.rows.gw_device_alerts.find((x) => x.rule === "night_web");
  assert.ok(a, "働きすぎに気づくため");
  assert.equal(a.severity, "warn");
});

// =============================================================================
console.log("\n== 本人の確認待ちを、放置させない ==");

await ok("3日たっても押されていなければ、知らせる", async () => {
  reset();
  db.rows.gw_devices = [agent({
    notified_at: null, status: "unconfirmed",
    first_seen_at: new Date(Date.now() - 5 * 86400000).toISOString(),
  })];
  await call(cron, get("/api/cron/devices"));
  const a = db.rows.gw_device_alerts.find((x) => x.rule === "confirm_waiting");
  assert.ok(a, "溜まっていることが見えないと、週1回の運用が回らない");
  assert.match(a.title, /5日/);
});

await ok("押してある端末には出ない", async () => {
  reset();
  db.rows.gw_devices = [agent({
    first_seen_at: new Date(Date.now() - 30 * 86400000).toISOString(),
  })];
  await call(cron, get("/api/cron/devices"));
  assert.equal(db.rows.gw_device_alerts.filter((a) => a.rule === "confirm_waiting").length, 0);
});

await ok("入れたばかりの端末には出ない", async () => {
  reset();
  db.rows.gw_devices = [agent({
    notified_at: null, status: "unconfirmed",
    first_seen_at: new Date(Date.now() - 3600000).toISOString(),
  })];
  await call(cron, get("/api/cron/devices"));
  assert.equal(db.rows.gw_device_alerts.filter((a) => a.rule === "confirm_waiting").length, 0,
    "入れたその日に催促しない");
});

await ok("0 を入れたら、知らせない", async () => {
  reset();
  db.rows.gw_device_policies = [{ tenant_id: "t1", confirm_wait_days: 0 }];
  db.rows.gw_devices = [agent({
    notified_at: null, status: "unconfirmed",
    first_seen_at: new Date(Date.now() - 30 * 86400000).toISOString(),
  })];
  await call(cron, get("/api/cron/devices"));
  assert.equal(db.rows.gw_device_alerts.filter((a) => a.rule === "confirm_waiting").length, 0);
});

// =============================================================================
console.log("\n== まとめてお知らせを送る ==");

await ok("確認していない人に届く", async () => {
  reset();
  db.rows.gw_devices = [
    agent({ id: "d1", employee_id: "emp-1", notified_at: null, status: "unconfirmed" }),
    agent({ id: "d2", employee_id: "emp-2", notified_at: null, status: "unconfirmed" }),
    agent({ id: "d3", employee_id: "emp-3" }),   // 押してある
  ];
  const r = await call(devs, patch({ action: "nudge_waiting" }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.sent, 2);
  assert.deepEqual(notified.map((x) => x.employeeId).sort(), ["emp-1", "emp-2"]);
  assert.equal(notified[0].link, "device-consent.html", "押す場所まで連れていく");
});

await ok("1人が3台放っていても、知らせは1通", async () => {
  reset();
  db.rows.gw_devices = [
    agent({ id: "d1", employee_id: "emp-1", notified_at: null, status: "unconfirmed" }),
    agent({ id: "d2", employee_id: "emp-1", notified_at: null, status: "unconfirmed" }),
    agent({ id: "d3", employee_id: "emp-1", notified_at: null, status: "unconfirmed" }),
  ];
  const r = await call(devs, patch({ action: "nudge_waiting" }));
  assert.equal(r.body.sent, 1, "台数ぶん届くと、読まれずに消される");
  assert.match(notified[0].title, /3台/);
});

await ok("送ったことを監査に残す", async () => {
  reset();
  db.rows.gw_devices = [agent({ notified_at: null, status: "unconfirmed" })];
  await call(devs, patch({ action: "nudge_waiting" }));
  assert.ok(logged.find((e) => e.action === "device.nudge_waiting"));
});

// =============================================================================
console.log("\n== 管理画面TOPの件数 ==");

await ok("未確認のアラートと、確認待ちの台数が出る", async () => {
  reset();
  db.rows.gw_devices = [
    agent({ id: "d1" }),
    agent({ id: "d2", employee_id: "emp-2", notified_at: null, status: "unconfirmed" }),
  ];
  db.rows.gw_device_alerts = [
    { id: "a1", tenant_id: "t1", device_id: "d1", status: "open", severity: "warn", rule: "distract_in_work" },
    { id: "a2", tenant_id: "t1", device_id: "d1", status: "open", severity: "critical", rule: "usb_attach" },
    { id: "a3", tenant_id: "t1", device_id: "d1", status: "open", severity: "info", rule: "no_access" },
    { id: "a4", tenant_id: "t1", device_id: "d1", status: "ack", severity: "warn", rule: "night_web" },
  ];
  const r = await call(badges, get("/api/badges"));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.devices.alerts, 2, "確認したものと、情報どまりのものは数えない");
  assert.equal(r.body.devices.waiting, 1);
  assert.equal(r.body.badges.devices, 3, "メニューの数字は合計");
});

await ok("人事でなければ、件数そのものを返さない", async () => {
  reset();
  ctxNow = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
             employee: { id: "emp-1", display_name: "山田" } };
  db.rows.gw_devices = [agent({ notified_at: null, status: "unconfirmed" })];
  const r = await call(badges, get("/api/badges"));
  assert.equal(r.body.devices, null);
  assert.equal(r.body.badges.devices, undefined);
});

await ok("一覧にも未確認の件数が出る（30件で切らない）", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  db.rows.gw_device_alerts = [
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `a${i}`, tenant_id: "t1", device_id: "d1", status: "open",
      severity: "warn", rule: "distract_in_work", title: "x", occurred_at: TODAY,
    })),
    // 情報どまりのものと、確認済みのものは数えない
    { id: "i1", tenant_id: "t1", device_id: "d1", status: "open",
      severity: "info", rule: "no_access", title: "x", occurred_at: TODAY },
    { id: "k1", tenant_id: "t1", device_id: "d1", status: "ack",
      severity: "warn", rule: "night_web", title: "x", occurred_at: TODAY },
  ];
  const r = await call(devs, get("/api/devices"));
  assert.equal(r.body.summary.openAlerts, 40,
    "一覧に出す30件と件数は別に数える。情報どまり・確認済みは入れない");
});

// =============================================================================
// 業務は原則、会社貸与PCだけ。私物PCでの業務利用は禁止している。
// ただし禁止だけを突きつけると黙って使われるので、通る道を残す
console.log("\n== 会社貸与か私物か ==");

const post = (path, body) => ({ method: "POST", url: path, body, headers: { authorization: "Bearer x" } });
const patchX = (body) => ({ method: "PATCH", url: "/api/devices/exceptions", body, headers: { authorization: "Bearer x" } });

await ok("エージェントが入っているものは、会社貸与として出る", async () => {
  reset();
  db.rows.gw_devices = [agent({ ownership: "company" })];
  const r = await call(devs, get("/api/devices"));
  const d = r.body.devices[0];
  assert.equal(d.own.key, "ok");
  assert.equal(r.body.summary.unmanaged, 0);
});

await ok("区分が付いていない端末は「未確認」として数える", async () => {
  reset();
  db.rows.gw_devices = [agent({ source: "browser", ownership: "unknown" })];
  const r = await call(devs, get("/api/devices"));
  assert.equal(r.body.devices[0].own.key, "check");
  assert.equal(r.body.summary.unmanaged, 1);
});

await ok("私物で承認が無ければ「禁止」と出る", async () => {
  reset();
  db.rows.gw_devices = [agent({ source: "browser", ownership: "personal" })];
  const r = await call(devs, get("/api/devices"));
  const d = r.body.devices[0];
  assert.equal(d.own.key, "banned");
  assert.match(d.own.note, /事前承認/);
  assert.equal(r.body.summary.banned, 1);
});

await ok("期限内の承認があれば、私物でも通る", async () => {
  reset();
  db.rows.gw_devices = [agent({ source: "browser", ownership: "personal" })];
  db.rows.gw_device_exceptions = [{
    id: "x1", tenant_id: "t1", employee_id: "emp-1", device_id: null,
    reason: "貸与PCの修理中", expires_on: day(7), revoked_at: null,
  }];
  const r = await call(devs, get("/api/devices"));
  assert.equal(r.body.devices[0].own.key, "allowed");
  assert.equal(r.body.summary.banned, 0);
});

await ok("期限が切れた承認は効かない", async () => {
  reset();
  db.rows.gw_devices = [agent({ source: "browser", ownership: "personal" })];
  db.rows.gw_device_exceptions = [{
    id: "x1", tenant_id: "t1", employee_id: "emp-1",
    reason: "修理中", expires_on: day(-1), revoked_at: null,
  }];
  const r = await call(devs, get("/api/devices"));
  assert.equal(r.body.devices[0].own.key, "banned", "1回出した承認が既得権にならない");
});

await ok("取り消した承認は効かない", async () => {
  reset();
  db.rows.gw_devices = [agent({ source: "browser", ownership: "personal" })];
  db.rows.gw_device_exceptions = [{
    id: "x1", tenant_id: "t1", employee_id: "emp-1",
    reason: "修理中", expires_on: day(30), revoked_at: new Date().toISOString(),
  }];
  const r = await call(devs, get("/api/devices"));
  assert.equal(r.body.devices[0].own.key, "banned");
});

await ok("よその人の承認は効かない", async () => {
  reset();
  db.rows.gw_devices = [agent({ source: "browser", ownership: "personal", employee_id: "emp-1" })];
  db.rows.gw_device_exceptions = [{
    id: "x1", tenant_id: "t1", employee_id: "emp-2",
    reason: "修理中", expires_on: day(30), revoked_at: null,
  }];
  const r = await call(devs, get("/api/devices"));
  assert.equal(r.body.devices[0].own.key, "banned");
});

console.log("\n== 私物PC利用の事前承認 ==");

await ok("期限つきで出せる。本人にも届く", async () => {
  reset();
  db.rows.gw_employees = [{ id: "emp-1", tenant_id: "t1", display_name: "山田 太郎" }];
  const r = await call(exceptions, post("/api/devices/exceptions", {
    employeeId: "emp-1", reason: "貸与PCの修理中", expiresOn: day(14),
    deviceNote: "自宅の MacBook",
  }));
  assert.equal(r.statusCode, 200);
  const made = db.rows.gw_device_exceptions[0];
  assert.equal(made.employee_id, "emp-1");
  assert.equal(made.expires_on, day(14));
  assert.equal(notified[0].employeeId, "emp-1", "本人に届く");
  assert.match(notified[0].title, /承認されました/);
  assert.ok(logged.find((e) => e.action === "device.exception_approved"));
});

await ok("理由が無ければ出せない", async () => {
  reset();
  db.rows.gw_employees = [{ id: "emp-1", tenant_id: "t1", display_name: "山田" }];
  const r = await call(exceptions, post("/api/devices/exceptions", {
    employeeId: "emp-1", expiresOn: day(14),
  }));
  assert.equal(r.statusCode, 400);
  assert.equal(db.rows.gw_device_exceptions.length, 0);
});

await ok("期限が無ければ出せない（無期限を作らない）", async () => {
  reset();
  db.rows.gw_employees = [{ id: "emp-1", tenant_id: "t1", display_name: "山田" }];
  const r = await call(exceptions, post("/api/devices/exceptions", {
    employeeId: "emp-1", reason: "修理中",
  }));
  assert.equal(r.statusCode, 400);
});

await ok("遠すぎる期限は受け取らない", async () => {
  reset();
  db.rows.gw_employees = [{ id: "emp-1", tenant_id: "t1", display_name: "山田" }];
  const r = await call(exceptions, post("/api/devices/exceptions", {
    employeeId: "emp-1", reason: "修理中", expiresOn: day(400),
  }));
  assert.equal(r.statusCode, 400);
  assert.match(r.body.hint, /365日/, "無期限の代わりに遠い日付を入れられると、期限を切った意味がない");
});

await ok("よその会社の社員には出せない", async () => {
  reset();
  db.rows.gw_employees = [{ id: "emp-x", tenant_id: "t2", display_name: "よその人" }];
  const r = await call(exceptions, post("/api/devices/exceptions", {
    employeeId: "emp-x", reason: "修理中", expiresOn: day(14),
  }));
  assert.equal(r.statusCode, 400);
});

await ok("人事でなければ、出すことも読むこともできない", async () => {
  reset();
  ctxNow = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
             employee: { id: "emp-1", display_name: "山田" } };
  assert.equal((await call(exceptions, get("/api/devices/exceptions"))).statusCode, 403);
  assert.equal((await call(exceptions, post("/api/devices/exceptions", {
    employeeId: "emp-1", reason: "x", expiresOn: day(1),
  }))).statusCode, 403);
});

await ok("取り消しても、行は消さない", async () => {
  reset();
  db.rows.gw_device_exceptions = [{
    id: "x1", tenant_id: "t1", employee_id: "emp-1",
    reason: "修理中", expires_on: day(30), revoked_at: null,
  }];
  const r = await call(exceptions, patchX({ action: "revoke", id: "x1", note: "貸与PCが直った" }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_device_exceptions.length, 1, "出したことも取り消したことも残す");
  assert.ok(logged.find((e) => e.action === "device.exception_revoked"));
  assert.match(notified[0].title, /取り消されました/, "本人にも伝える");
});

console.log("\n== 周知の記録 ==");

await ok("本人が押さないままでも、管理者が周知済みにできる", async () => {
  reset();
  db.rows.gw_devices = [agent({ notified_at: null, status: "unconfirmed" })];
  const r = await call(devs, patch({
    action: "mark_notified", deviceId: "d1",
    note: "2026-09-20 の朝礼で端末管理規程を配布し、口頭で説明した",
  }));
  assert.equal(r.statusCode, 200);
  const up = db.writes.find((w) => w.table === "gw_devices" && w.op === "update");
  assert.ok(up.row.notified_at);
  assert.equal(up.row.notified_kind, "admin", "本人が押したのと区別する");
  assert.match(up.row.notified_note, /朝礼/);
});

await ok("どう周知したか書かなければ、記録にしない", async () => {
  reset();
  db.rows.gw_devices = [agent({ notified_at: null, status: "unconfirmed" })];
  const r = await call(devs, patch({ action: "mark_notified", deviceId: "d1", note: "  " }));
  assert.equal(r.statusCode, 400);
  assert.equal(db.writes.filter((w) => w.table === "gw_devices" && w.op === "update").length, 0);
});

await ok("会社貸与か私物かを、管理者が付けられる", async () => {
  reset();
  db.rows.gw_devices = [agent({ source: "browser", ownership: "unknown" })];
  const r = await call(devs, patch({ action: "ownership", deviceId: "d1", ownership: "personal" }));
  assert.equal(r.statusCode, 200);
  const up = db.writes.find((w) => w.table === "gw_devices" && w.op === "update");
  assert.equal(up.row.ownership, "personal");
});

await ok("知らない区分は受け取らない", async () => {
  reset();
  db.rows.gw_devices = [agent()];
  const r = await call(devs, patch({ action: "ownership", deviceId: "d1", ownership: "whatever" }));
  assert.equal(r.statusCode, 400);
});

console.log(`\n合計 ${n} 件 通過`);
