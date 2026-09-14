// 端末の一生：利用停止 / 紛失 / 端末を削除。
//
// ■ 何を守るテストか
//
//   1. 押した瞬間に、そのPCからは何も受け取らなくなること
//   2. それでも「消せ」という命令だけは、そのPCに届くこと
//      （資格情報を完全に殺すと、そのPCは自分への命令を受け取れない）
//   3. 消え終わるまでは「削除待ち」で、勝手に台帳から消えないこと
//   4. **端末を消しても、過去の記録を消さないこと**
//      ここが崩れると「辞める前に消しておけば残らない」が成り立つ
//   5. 削除・紛失を押せるのは、管理者・経営者だけであること
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase。update は本当に書き換える ------------------------------
//
// 書いたつもりで書けていないと、状態の移り変わりを見るテストが
// 全部「通ったことにして」しまう。ここは実際に当てる
const db = { rows: {} };

function cols(spec) {
  if (!spec || spec === "*") return null;
  return String(spec).split(",").map((s) => s.trim().split("(")[0].split(":")[0].trim())
    .filter(Boolean);
}
function project(row, spec) {
  if (!row) return row;
  const keep = cols(spec);
  if (!keep) return row;
  // 無い列を SELECT したら、本物と同じように落とす。
  // 064 を流していない環境を作るのに使う
  const missing = keep.filter((k) => !(k in row) && !KNOWN_NULLABLE.has(k));
  if (missing.length) throw Object.assign(new Error("missing column"), { _missing: missing[0] });
  const out = {};
  for (const k of keep) out[k] = row[k] ?? null;
  return out;
}
// 行に入っていなくても「列はある」もの（値が null なだけ）
const KNOWN_NULLABLE = new Set();

function table(name) {
  const f = [];
  let spec = null;
  const rows = () => match(name, f);
  const wrap = (v) => Promise.resolve(v);
  const q = {
    select(s) { spec = s; return q; },
    eq(k, v) { f.push([k, v]); return q; },
    in(k, v) { f.push([k, v]); return q; },
    is(k, v) { f.push(["is:" + k, v]); return q; },
    not() { return q; },
    gte(k, v) { f.push([">=" + k, v]); return q; },
    lte(k, v) { f.push(["<=" + k, v]); return q; },
    lt() { return q; },
    order() { return q; },
    limit(n) { q._limit = n; return q; },
    maybeSingle() {
      try { return wrap({ data: project(rows()[0] || null, spec), error: null }); }
      catch (e) { return wrap({ data: null, error: colErr(name, e) }); }
    },
    single() {
      try { return wrap({ data: project(rows()[0] || null, spec), error: null }); }
      catch (e) { return wrap({ data: null, error: colErr(name, e) }); }
    },
    then(fn) {
      let out;
      try { out = rows().map((r) => project(r, spec)); }
      catch (e) { return wrap({ data: null, error: colErr(name, e) }).then(fn); }
      if (q._limit) out = out.slice(0, q._limit);
      return wrap({ data: out, error: null, count: out.length }).then(fn);
    },
    insert(row) {
      const made = [].concat(row).map((r, n) => ({ id: `${name}-${n}-${Date.now()}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r, single: () => wrap({ data: made[0], error: null }),
                  then: (fn) => wrap({ data: made, error: null }).then(fn) };
      return r;
    },
    upsert(row) { return q.insert(row); },
    update(patch) {
      const g = [];
      const run = () => {
        const hit = match(name, g);
        for (const r of hit) Object.assign(r, patch);
        return { data: hit, error: null };
      };
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        in: (k, v) => { g.push([k, v]); return r; },
        is: (k, v) => { g.push(["is:" + k, v]); return r; },
        select: () => r,
        single: () => wrap({ data: run().data[0] || null, error: null }),
        then: (fn) => wrap(run()).then(fn),
      };
      return r;
    },
    delete() {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        then: (fn) => {
          const hit = match(name, g);
          db.rows[name] = (db.rows[name] || []).filter((x) => !hit.includes(x));
          return wrap({ data: hit, error: null }).then(fn);
        },
      };
      return r;
    },
  };
  return q;
}
const colErr = (name, e) => ({
  code: "42703", message: `column ${name}.${e._missing || "?"} does not exist`,
});
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) => {
  if (k.startsWith("is:")) { const kk = k.slice(3); return v === null ? r[kk] == null : r[kk] === v; }
  if (k.startsWith(">=")) return String(r[k.slice(2)] ?? "") >= String(v);
  if (k.startsWith("<=")) return String(r[k.slice(2)] ?? "") <= String(v);
  return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
}));

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});

let signedIn = { id: "u-admin", email: "zimu@8grp.co.jp" };
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => signedIn, getMemberships: async () => [] },
});

let ctxNow = null;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ctxNow,
    canManageHr: () => Boolean(ctxNow.isAdmin || ctxNow.isHr),
    canWipeDevice: () => Boolean(ctxNow.isAdmin || (ctxNow.roles || []).includes("owner")),
  },
});

const logged = [];
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const told = [];
mock.module(atRoot("lib/notify.js"), {
  namedExports: {
    notify: async (list) => { told.push(...[].concat(list)); return { created: told.length }; },
    clearNotification: async () => {},
  },
});

const { default: devs } = await import(atRoot("api/devices/index.js"));
const { default: config } = await import(atRoot("api/devices/config.js"));
const { default: ingest } = await import(atRoot("api/devices/ingest.js"));
const { default: wiped } = await import(atRoot("api/devices/wiped.js"));
const { sha256 } = await import(atRoot("lib/devices.js"));

// ---- 呼び出しの道具 --------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const SECRET = "s3cr3t-device-secret";
const DEV_AUTH = { authorization: `Device 11111111-1111-1111-1111-111111111111:${SECRET}` };

async function call(handler, req) {
  const r = res();
  await handler({ headers: {}, ...req }, r);
  return r;
}
const patch = (body, headers = {}) =>
  call(devs, { method: "PATCH", url: "/api/devices",
               headers: { authorization: "Bearer x", ...headers },
               body, on: () => {} });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const DEV_ID = "11111111-1111-1111-1111-111111111111";

/** まっさらな状態に戻す。登録が終わって、ふつうに動いているPC1台 */
function setup() {
  logged.length = 0;
  told.length = 0;
  ctxNow = {
    tenantId: "t1", isAdmin: true, isHr: true, roles: ["owner"],
    employee: { id: "emp-admin", display_name: "事務" },
  };
  db.rows = {
    gw_devices: [{
      id: DEV_ID, tenant_id: "t1", device_uid: "uid-1", label: "営業ノート",
      source: "agent", hostname: "EIGHT-PC-01", serial: null,
      os: "Windows", os_version: "11", os_build: null, browser: null,
      model: null, screen: null, agent_version: "0.3.1",
      status: "active", notified_at: "2026-09-01T00:00:00Z",
      notified_kind: "self", notified_note: null,
      installed_at: "2026-09-01T00:00:00Z",
      first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-09-14T00:00:00Z",
      note: null, employee_id: "emp-1", asset_id: null, retired_at: null,
      linked_device_id: null, ownership: "company",
      admin_touched_at: null, admin_touched_by: null, admin_touched_what: null,
      secret_hash: sha256(SECRET),
      // 064
      revoked_at: null, revoked_by: null, lost_at: null,
      wipe_requested_at: null, wipe_requested_by: null, wipe_reason: null,
      wipe_done_at: null, wipe_note: null, deleted_at: null,
    }],
    gw_employees: [{ id: "emp-1", tenant_id: "t1", display_name: "山田 太郎",
                     department: "営業", user_id: "u-1" }],
    // 過去の記録。端末を消しても、これは消えてはいけない
    gw_device_events: [{ id: "ev-1", tenant_id: "t1", device_id: DEV_ID,
                         work_date: "2026-09-10", at: "2026-09-10T01:00:00Z",
                         kind: "usb_attach", detail: {}, seq: 1 }],
    gw_device_usage: [{ id: "us-1", tenant_id: "t1", device_id: DEV_ID,
                        employee_id: "emp-1", work_date: "2026-09-10",
                        active_min: 420, idle_min: 30, locked_min: 10,
                        night_min: 0, holiday_min: 0 }],
    gw_device_web_visits: [{ id: "wv-1", tenant_id: "t1", device_id: DEV_ID,
                             work_date: "2026-09-10", host: "example.com",
                             started_at: "2026-09-10T02:00:00Z", active_sec: 60 }],
    gw_device_alerts: [], gw_device_browsers: [], gw_device_policies: [],
    gw_device_views: [], gw_device_exceptions: [], gw_device_app_usage: [],
    gw_device_web_usage: [], gw_time_entries: [],
  };
}
const dev = () => db.rows.gw_devices[0];

console.log("\n=== 端末の一生：停止・紛失・削除 ===\n");

// ---------------------------------------------------------------------------
console.log("— 利用停止（あとで戻せる）—");

await ok("停止すると、そのPCは何も送らなくなる", async () => {
  setup();
  const r = await patch({ action: "suspend", deviceId: DEV_ID });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(dev().status, "suspended");

  const c = await call(config, { method: "GET", url: "/api/devices/config", headers: DEV_AUTH });
  assert.equal(c.body.collect, false);
  assert.equal(c.body.reason, "suspended");
});

await ok("停止でも、資格情報は生きている（戻せる）", async () => {
  setup();
  await patch({ action: "suspend", deviceId: DEV_ID });
  assert.equal(dev().revoked_at, null, "停止で失効させてはいけない");
  const r = await patch({ action: "resume", deviceId: DEV_ID });
  assert.equal(r.statusCode, 200);
  assert.equal(dev().status, "active");
});

// ---------------------------------------------------------------------------
console.log("\n— 紛失（手元に無いPC）—");

await ok("紛失にすると、その場で資格情報が失効する", async () => {
  setup();
  const r = await patch({ action: "lost", deviceId: DEV_ID });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(dev().lost_at, "lost_at が入っていない");
  assert.ok(dev().revoked_at, "revoked_at が入っていない");
  assert.equal(dev().status, "suspended");
});

await ok("失効した端末からは、記録を受け取らない", async () => {
  setup();
  await patch({ action: "lost", deviceId: DEV_ID });
  const before = db.rows.gw_device_events.length;
  const r = await call(ingest, {
    method: "POST", url: "/api/devices/ingest", headers: DEV_AUTH,
    body: { events: [{ seq: 2, at: "2026-09-14T05:00:00Z", kind: "boot" }] },
  });
  assert.equal(r.body.collect, false);
  assert.equal(r.body.reason, "revoked");
  assert.equal(db.rows.gw_device_events.length, before, "失効した端末の記録を入れています");
});

await ok("紛失でも「消せ」とは言わない（見つかることがある）", async () => {
  setup();
  await patch({ action: "lost", deviceId: DEV_ID });
  const c = await call(config, { method: "GET", url: "/api/devices/config", headers: DEV_AUTH });
  assert.equal(c.body.uninstall, undefined, "紛失で勝手に消してはいけない");
  assert.equal(c.body.reason, "revoked");
});

await ok("見つかったら、再開で戻せる", async () => {
  setup();
  await patch({ action: "lost", deviceId: DEV_ID });
  const r = await patch({ action: "resume", deviceId: DEV_ID });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(dev().lost_at, null);
  assert.equal(dev().revoked_at, null);
  assert.equal(dev().status, "active");
});

// ---------------------------------------------------------------------------
console.log("\n— 端末を削除 —");

await ok("押した時点で失効し、削除待ちになる", async () => {
  setup();
  const r = await patch({ action: "wipe", deviceId: DEV_ID, reason: "退職" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(dev().wipe_requested_at, "削除の指示が入っていない");
  assert.ok(dev().revoked_at, "失効していない");
  assert.equal(dev().wipe_requested_by, "u-admin");
  assert.equal(dev().wipe_reason, "退職");
  assert.equal(dev().wipe_done_at, null, "押した時点で消えたことにしてはいけない");
  assert.equal(dev().deleted_at, null, "報せが来る前に台帳から外してはいけない");
});

await ok("そのPCには「消せ」が届く", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  const c = await call(config, { method: "GET", url: "/api/devices/config", headers: DEV_AUTH });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.equal(c.body.uninstall, true, "消せという命令が届いていません");
  assert.equal(c.body.collect, false);
});

await ok("消せという命令のほかには、何も渡さない", async () => {
  setup();
  // 手元に無いPCでも、この口だけは開いている。
  // 会社の設定（カテゴリ表・勤務時間）を渡す理由は無い
  await patch({ action: "wipe", deviceId: DEV_ID });
  const c = await call(config, { method: "GET", url: "/api/devices/config", headers: DEV_AUTH });
  assert.equal(c.body.siteCategories, undefined, "カテゴリ表を渡しています");
  assert.equal(c.body.nightFrom, undefined, "勤務時間を渡しています");
});

await ok("送信の返事でも「消せ」が伝わる（5分で届く）", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  const r = await call(ingest, {
    method: "POST", url: "/api/devices/ingest", headers: DEV_AUTH,
    body: { events: [{ seq: 3, at: "2026-09-14T05:00:00Z", kind: "boot" }] },
  });
  assert.equal(r.body.uninstall, true,
    "設定の口は6時間おき。ここで伝えないと、消えるまで半日かかる");
  assert.equal(r.body.reason, "wipe");
});

await ok("削除待ちのPCからも、記録は1件も入らない", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  const before = db.rows.gw_device_events.length;
  await call(ingest, {
    method: "POST", url: "/api/devices/ingest", headers: DEV_AUTH,
    body: { events: [{ seq: 4, at: "2026-09-14T05:00:00Z", kind: "boot" }] },
  });
  assert.equal(db.rows.gw_device_events.length, before);
});

await ok("消し終わったと報せが来て、はじめて台帳から外れる", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  const r = await call(wiped, {
    method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: { left: [] },
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(dev().wipe_done_at, "消し終わりが入っていない");
  assert.ok(dev().deleted_at, "台帳から外れていない");
  assert.equal(dev().secret_hash, null, "資格情報が生きたまま残っています");
});

await ok("報せが2回来ても、こわれない", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  await call(wiped, { method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {} });
  // 1回目で secret_hash を落としているので、2回目は資格情報が通らない。
  // それでよい（もう何もすることが無い）
  const r = await call(wiped, {
    method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {},
  });
  assert.ok([200, 401].includes(r.statusCode), `いま ${r.statusCode}`);
});

await ok("言われていないのに「消えた」と言ってきても、受け取らない", async () => {
  setup();
  const r = await call(wiped, {
    method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {},
  });
  assert.equal(r.statusCode, 409, "端末の言い分だけで台帳の行を消してはいけない");
});

// ---------------------------------------------------------------------------
console.log("\n— 端末を消しても、過去の記録は消さない —");
//
//   ここが崩れると「辞める前に消しておけば残らない」が成り立つ。
//   消えるのは、台帳に並ぶ1行と、そのPCの中のエージェントだけ

await ok("できごと・稼働・WEB履歴は、そのまま残る", async () => {
  setup();
  const before = {
    events: db.rows.gw_device_events.length,
    usage: db.rows.gw_device_usage.length,
    visits: db.rows.gw_device_web_visits.length,
  };
  await patch({ action: "wipe", deviceId: DEV_ID });
  await call(wiped, { method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {} });

  // 消し終わりの1行は足されるが、前からあったものは減っていない
  assert.ok(db.rows.gw_device_events.length >= before.events,
    "できごとが減っています");
  assert.equal(db.rows.gw_device_usage.length, before.usage, "稼働の記録が消えています");
  assert.equal(db.rows.gw_device_web_visits.length, before.visits, "WEB履歴が消えています");
  assert.ok(db.rows.gw_device_usage.some((u) => u.device_id === DEV_ID),
    "この端末の稼働の記録が引けなくなっています");
});

await ok("台帳の行そのものも消さない（記録が宙に浮く）", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  await call(wiped, { method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {} });
  assert.equal(db.rows.gw_devices.length, 1, "行ごと消しています");
});

// ---------------------------------------------------------------------------
console.log("\n— 誰が押せるか —");

await ok("人事の担当者は、削除を押せない", async () => {
  setup();
  ctxNow = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"],
             employee: { id: "emp-hr", display_name: "人事" } };
  const r = await patch({ action: "wipe", deviceId: DEV_ID });
  assert.equal(r.statusCode, 403, `いま ${r.statusCode}`);
  assert.equal(dev().wipe_requested_at, null, "権限が無いのに削除が通っています");
});

await ok("人事の担当者は、紛失も押せない", async () => {
  setup();
  ctxNow = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"],
             employee: { id: "emp-hr", display_name: "人事" } };
  const r = await patch({ action: "lost", deviceId: DEV_ID });
  assert.equal(r.statusCode, 403);
  assert.equal(dev().revoked_at, null);
});

await ok("人事の担当者でも、停止と再開はできる", async () => {
  setup();
  ctxNow = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"],
             employee: { id: "emp-hr", display_name: "人事" } };
  const r = await patch({ action: "suspend", deviceId: DEV_ID });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(dev().status, "suspended");
});

await ok("経営者（owner）は押せる", async () => {
  setup();
  ctxNow = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"],
             employee: { id: "emp-own", display_name: "経営" } };
  const r = await patch({ action: "wipe", deviceId: DEV_ID });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

// ---------------------------------------------------------------------------
console.log("\n— 押し間違えたとき —");

await ok("まだ取りに来ていなければ、取り消せる", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  const r = await patch({ action: "cancel_wipe", deviceId: DEV_ID });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(dev().wipe_requested_at, null);
  assert.equal(dev().revoked_at, null, "取り消したのに失効したままです");
  // すぐ使える状態には戻さない。停止のまま、人に確かめさせる
  assert.equal(dev().status, "suspended");
});

await ok("もう消えていたら、取り消せない", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  await call(wiped, { method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {} });
  const r = await patch({ action: "cancel_wipe", deviceId: DEV_ID });
  assert.equal(r.statusCode, 409, `いま ${r.statusCode}`);
});

await ok("削除待ちを「再開」では戻さない", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  const r = await patch({ action: "resume", deviceId: DEV_ID });
  assert.equal(r.statusCode, 409,
    "消えたかもしれないPCを「使える」ことにすると、台帳が嘘になる");
});

// ---------------------------------------------------------------------------
console.log("\n— ブラウザ登録は、管理者しか外せない —");
//
//   社員の画面に「登録を外す」は出していない（api/devices/me.js の forget が 403）。
//   自分で外せると、未登録のパソコンで入ったあと登録を消す、という道ができる。
//   止められるのはここだけなので、ここが効いていることを確かめる。

/** ブラウザの行を1つ足す。登録済み・拡張とつながっている状態 */
function browserRow(over = {}) {
  const id = "22222222-2222-2222-2222-222222222222";
  db.rows.gw_devices.push({
    id, tenant_id: "t1", device_uid: "uid-b", label: "Windows の Chrome",
    source: "browser", hostname: null, browser: "Chrome",
    status: "active", notified_at: "2026-09-01T00:00:00Z",
    installed_at: "2026-09-01T00:00:00Z", ext_missing_since: "2026-09-13T00:00:00Z",
    employee_id: "emp-1", ownership: "company", secret_hash: sha256("ext-secret"),
    linked_device_id: null, last_seen_at: "2026-09-14T00:00:00Z",
    revoked_at: null, lost_at: null, wipe_requested_at: null,
    wipe_done_at: null, deleted_at: null,
    ...over,
  });
  db.rows.gw_device_browsers.push({
    tenant_id: "t1", device_id: id, browser: "chrome",
    installed: true, linked: true, ext_version: "2.0.0",
    last_seen_at: "2026-09-13T00:00:00Z",
  });
  return id;
}

await ok("登録解除で、資格情報と「登録済み」の印が消える", async () => {
  setup();
  const id = browserRow();
  const r = await patch({ action: "ext_unlink", deviceId: id });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = db.rows.gw_devices.find((x) => x.id === id);
  assert.equal(d.secret_hash, null, "資格情報を失効させる");
  assert.equal(d.installed_at, null, "「登録済み」を下ろす");
  assert.equal(db.rows.gw_device_browsers[0].linked, false);
});

await ok("解除しても、これまでの記録は消さない", async () => {
  setup();
  const id = browserRow();
  await patch({ action: "ext_unlink", deviceId: id });
  assert.equal(db.rows.gw_device_usage.length, 1);
  assert.equal(db.rows.gw_device_web_visits.length, 1);
});

await ok("解除したら、「連携異常」の時計も下ろす", async () => {
  // 管理者が外したものが、そのあとも赤く出続けるのはおかしい
  setup();
  const id = browserRow();
  await patch({ action: "ext_unlink", deviceId: id });
  assert.equal(db.rows.gw_devices.find((x) => x.id === id).ext_missing_since, null);
});

await ok("再登録は、解除したうえで本人にお願いする", async () => {
  // 拡張はブラウザの中にある。サーバから入れ直すことはできない
  setup();
  const id = browserRow();
  const r = await patch({ action: "ext_reinvite", deviceId: id });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notified, true);
  assert.equal(told.length, 1, "本人に1通");
  assert.equal(told[0].employeeId, "emp-1");
  assert.ok(/登録/.test(told[0].title), told[0].title);
});

await ok("解除も再登録も、誰が・誰のぶんを、が残る", async () => {
  setup();
  const id = browserRow();
  await patch({ action: "ext_unlink", deviceId: id });
  const a = logged.find((x) => x.action === "device.ext_unlink");
  assert.ok(a, logged.map((x) => x.action).join(","));
  assert.equal(a.actorId, "u-admin", "誰が");
  assert.equal(a.target, id, "どの端末を");
  assert.equal(a.detail.employee, "山田 太郎", "誰のぶんか");
  const ev = db.rows.gw_device_events.find((e) => e.kind === "ext_unlinked");
  assert.ok(ev, "端末のできごとにも残る");
});

await ok("パソコン（常駐ソフト）の行では使えない", async () => {
  setup();
  const r = await patch({ action: "ext_unlink", deviceId: DEV_ID });
  assert.equal(r.statusCode, 400);
});

console.log("\n— 監査に残るか —");

await ok("誰が・いつ・どの端末に削除を指示したか", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID, reason: "退職" });
  const e = logged.find((x) => x.action === "device.wipe");
  assert.ok(e, `残っていません: ${logged.map((x) => x.action).join(", ")}`);
  assert.equal(e.actorId, "u-admin");
  assert.equal(e.target, DEV_ID);
});

await ok("いつ消え終わったかも、別に残る", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  logged.length = 0;
  await call(wiped, { method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {} });
  assert.ok(logged.some((x) => x.action === "device.wipe_done"),
    `残っていません: ${logged.map((x) => x.action).join(", ")}`);
});

await ok("端末の履歴からも辿れる", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  assert.ok(db.rows.gw_device_events.some((e) => e.kind === "wipe_requested"),
    "端末の履歴に残っていません");
  await call(wiped, { method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {} });
  assert.ok(db.rows.gw_device_events.some((e) => e.kind === "wiped"));
});

// ---------------------------------------------------------------------------
console.log("\n— 一覧の見え方 —");

const list = async () => {
  const r = await call(devs, {
    method: "GET", url: "/api/devices", headers: { authorization: "Bearer x" },
  });
  return r;
};

await ok("削除待ちは、通常の一覧に残したまま「削除待ち」と出す", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  const r = await list();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  const d = (r.body.devices || []).find((x) => x.id === DEV_ID);
  assert.ok(d, "削除待ちの端末が一覧から消えています（押した人が追えません）");
  assert.equal(d.life.wiping, true);
  assert.equal(d.state.label, "削除待ち");
  assert.equal(r.body.summary.wiping, 1);
});

await ok("消え終わったら、一覧から外れる", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  await call(wiped, { method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {} });
  const r = await list();
  assert.equal((r.body.devices || []).length, 0, "台帳に残り続けています");
  assert.equal(r.body.deleted, 1, "削除済みの台数が出ていません");
});

await ok("削除済みも見たいときは、出せる", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  await call(wiped, { method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {} });
  const r = await call(devs, {
    method: "GET", url: "/api/devices?deleted=1", headers: { authorization: "Bearer x" },
  });
  assert.equal((r.body.devices || []).length, 1);
  assert.equal(r.body.showingDeleted, true);
});

await ok("消えた端末の詳細は、あとからでも開ける（監査の入口）", async () => {
  setup();
  await patch({ action: "wipe", deviceId: DEV_ID });
  await call(wiped, { method: "POST", url: "/api/devices/wiped", headers: DEV_AUTH, body: {} });
  const r = await call(devs, {
    method: "GET", url: `/api/devices?deviceId=${DEV_ID}`,
    headers: { authorization: "Bearer x" },
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.device.life.deleted, true);
});

// ---------------------------------------------------------------------------
console.log("\n— 064 をまだ流していない環境 —");
//
//   無い列を SELECT すると、そのリクエストごと落ちる。
//   端末の一覧と詳細が丸ごと開かなくなるので、そこだけは守る

await ok("064 が無くても、一覧は開ける", async () => {
  setup();
  for (const k of ["revoked_at", "revoked_by", "lost_at", "wipe_requested_at",
                   "wipe_requested_by", "wipe_reason", "wipe_done_at",
                   "wipe_note", "deleted_at"]) {
    delete dev()[k];
  }
  const r = await list();
  assert.equal(r.statusCode, 200,
    `064 を流していないだけで、端末管理が全部開かなくなります: ${JSON.stringify(r.body)}`);
  assert.equal((r.body.devices || []).length, 1);
});

await ok("064 が無くても、そのPCは動き続ける", async () => {
  setup();
  for (const k of ["revoked_at", "wipe_requested_at", "wipe_done_at", "deleted_at"]) {
    delete dev()[k];
  }
  const c = await call(config, { method: "GET", url: "/api/devices/config", headers: DEV_AUTH });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.equal(c.body.collect, true);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) { console.log(`${fail} 件 NG`); process.exit(1); }
