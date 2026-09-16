// 端末のAPIを、偽のSupabaseで通す。
// いちばん守りたい「本人が確認するまで、利用時間を数えない」を、実際のハンドラで確かめる。
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, writes: [] };

// ---- SELECT した列だけを返す ------------------------------------------------
//
// ■ なぜ、わざわざ削るのか
//
//   本物の PostgREST は、.select() に書いた列しか返さない。
//   偽物が行を丸ごと返していると、**書いてあるのに取り忘れている**
//   という間違いが、テストでは通ってしまう。
//
//   実際にそれで壊れた。api/devices/pair.js が enrollment_id を
//   取り忘れていて、インストーラが永久に ready:false を受け取っていた。
//   テストは全部通っていた。
//
//   だからここで、本物と同じだけ削る。
function cols(spec) {
  if (!spec || spec === "*") return null;
  const out = [];
  let depth = 0, cur = "";
  for (const ch of String(spec)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean).map((s) => {
    const paren = s.indexOf("(");
    if (paren >= 0) s = s.slice(0, paren);        // 埋め込み（rel(...)）
    const colon = s.indexOf(":");
    if (colon >= 0) s = s.slice(0, colon);        // 別名（alias:col）
    return s.trim();
  });
}

function project(row, spec) {
  if (!row) return row;
  const keep = cols(spec);
  if (!keep) return row;
  const out = {};
  for (const k of keep) if (k in row) out[k] = row[k];
  return out;
}

function table(name) {
  const f = [];
  const q = {
    select(spec) { q._cols = spec; return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    is() { return q; },
    not() { return q; },
    gte() { return q; },
    lte() { return q; },
    lt() { return q; },
    in(k, vs) { f.push([k, vs]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle() { return Promise.resolve({ data: project(pick(name, f), q._cols), error: err(name) }); },
    single() { return Promise.resolve({ data: project(pick(name, f), q._cols), error: err(name) }); },
    then(fn) { return Promise.resolve({ data: match(name, f).map((r) => project(r, q._cols)), error: err(name), count: match(name, f).length }).then(fn); },
    upsert(rows, opts) {
      db.writes.push({ op: "upsert", table: name, rows: [].concat(rows), opts });
      const r = { select: () => r, single: () => Promise.resolve({ data: [].concat(rows)[0], error: null }),
                  then: (fn) => Promise.resolve({ data: [].concat(rows), error: null }).then(fn) };
      return r;
    },
    update(row) {
      db.writes.push({ op: "update", table: name, row });
      const g = [];
      const r = { eq: (k, v) => { g.push([k, v]); return r; }, is: () => r, select: () => r,
                  single: () => Promise.resolve({ data: { ...(pick(name, g) || {}), ...row }, error: null }),
                  then: (fn) => Promise.resolve({ data: [row], error: null }).then(fn) };
      return r;
    },
    insert(row) {
      db.writes.push({ op: "insert", table: name, row });
      const made = { id: `new-${db.writes.length}`, ...row };
      (db.rows[name] = db.rows[name] || []).push(made);
      const r = { select: () => r, single: () => Promise.resolve({ data: made, error: null }),
                  then: (fn) => Promise.resolve({ data: [made], error: null }).then(fn) };
      return r;
    },
    delete() { const r = { eq: () => r, not: () => r, lt: () => r, select: () => r,
                           then: (fn) => Promise.resolve({ data: [], error: null, count: 0 }).then(fn) };
               return r; },
  };
  return q;
}
const err = (name) => (db.missing === name ? { code: "PGRST205", message: "Could not find the table" } : null);
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) => {
  if (k.startsWith("!")) return r[k.slice(1)] !== v;
  return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
}));
const pick = (name, filters) => match(name, filters)[0] || null;

// Storage の偽物。配布物のURLは、そのつど短時間だけ作られる
const storage = { calls: [] };
const fakeStorage = {
  from(bucket) {
    return {
      createSignedUrl(path, sec, opts) {
        storage.calls.push({ bucket, path, sec, download: opts?.download || null });
        if (storage.fail) return Promise.resolve({ data: null, error: new Error("no") });
        return Promise.resolve({
          data: { signedUrl: `https://xyz.supabase.co/storage/v1/object/sign/${bucket}/${path}`
                             + `?token=sig${storage.calls.length}` },
          error: null,
        });
      },
    };
  },
};
mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table, storage: fakeStorage }),
    userClient: () => ({ from: table, storage: fakeStorage }),
  },
});
// 認証と所属は別のところで守っている。ここでは端末の話だけを見る
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1", email: "yamada@8grp.co.jp" }),
                  getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ({
      tenantId: "t1", isAdmin: false, isHr: false, memberships: [], roles: [],
      employee: { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎" },
    }),
    canManageHr: () => true,
    canWipeDevice: () => true,
  },
});

const { default: me } = await import(atRoot("api/devices/me.js"));
const { default: enroll } = await import(atRoot("api/devices/enroll.js"));
const { default: config } = await import(atRoot("api/devices/config.js"));
const { default: ingest } = await import(atRoot("api/devices/ingest.js"));
const { sha256 } = await import(atRoot("lib/devices.js"));
const { default: adminDev } = await import(atRoot("api/devices/index.js"));

// ---- 偽の req/res ---------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const post = (body) => ({
  method: "POST", url: "/api/devices/me", body,
  headers: { authorization: "Bearer x", "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36" },
});
const get = (qs = "") => ({
  method: "GET", url: `/api/devices/me${qs}`, headers: { authorization: "Bearer x" },
});

// サーバは日本時間で日付を切る。偽の行も同じ日付にしないと見つからない
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

const UID = "aaaaBBBBccccDDDD11";
const UID2 = "zzzzYYYYxxxxWWWW99";

const device = (over = {}) => ({
  id: "d1", tenant_id: "t1", employee_id: "emp-1", device_uid: UID,
  label: "Windows の Chrome", source: "browser", status: "active",
  notified_at: "2026-09-01T00:00:00Z", last_seen_at: null, ...over,
});

const AGENT_ID = "8f2c1d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
const AGENT_SECRET = "s3cret-value";
const agent = (over = {}) => ({
  id: AGENT_ID, tenant_id: "t1", employee_id: "emp-1", device_uid: "agent-uid-1",
  label: "8GRP-PC-01", hostname: "8GRP-PC-01", source: "agent", status: "active",
  secret_hash: sha256(AGENT_SECRET), agent_version: "1.0.0",
  notified_at: "2026-09-01T00:00:00Z", last_seen_at: null, ...over,
});
const devReq = (method, body, secret = AGENT_SECRET) => ({
  method, url: "/api/devices/x", body,
  headers: { authorization: `Device ${AGENT_ID}:${secret}` },
});

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log("  ok", name); };
const reset = (devs = []) => {
  db.rows = { gw_devices: [...devs], gw_device_policies: [], gw_device_usage: [],
              gw_device_events: [], gw_device_alerts: [], gw_device_views: [],
              gw_device_enrollments: [], gw_device_app_usage: [], gw_device_web_usage: [],
              gw_device_releases: [] };
  db.writes = [];
  db.missing = null;
  storage.calls = []; storage.fail = false;
};
const wrote = (t, op) => db.writes.filter((w) => w.table === t && (!op || w.op === op));

console.log("— はじめての端末 —");
await ok("合図が来た時点で、台帳に載る", async () => {
  reset();
  const r = res();
  await me(post({ action: "beat", deviceUid: UID, hints: { platform: "Windows", platformVersion: "15.0.0", browser: "Chrome", screen: "1920x1080" } }), r);
  assert.equal(r.statusCode, 200);
  const ins = wrote("gw_devices", "insert")[0];
  assert.ok(ins, "端末の行ができる");
  assert.equal(ins.row.device_uid, UID);
  assert.equal(ins.row.employee_id, "emp-1");
  assert.equal(ins.row.label, "Windows 11 の Chrome");
  assert.equal(ins.row.status, "unconfirmed", "登録された時点では、まだ確認待ち");
  assert.equal(ins.row.notified_at, undefined, "勝手に確認済みにはしない");
});
await ok("「はじめて使った」を記録に残す", async () => {
  const ev = wrote("gw_device_events", "insert")[0];
  assert.equal(ev.row.kind, "first_seen");
});
await ok("確認前は、利用時間を1分も数えない", async () => {
  assert.equal(wrote("gw_device_usage").length, 0);
});
await ok("返事で「まだ確認されていない」と伝える", async () => {
  reset();
  const r = res();
  await me(post({ action: "beat", deviceUid: UID }), r);
  assert.equal(r.body.confirmed, false);
  assert.equal(r.body.deviceUid, UID);
});
await ok("変なIDは受け取らず、こちらで作り直す", async () => {
  reset();
  const r = res();
  await me(post({ action: "beat", deviceUid: "' or 1=1--" }), r);
  assert.notEqual(r.body.deviceUid, "' or 1=1--");
  assert.match(r.body.deviceUid, /^[A-Za-z0-9_-]{16,64}$/);
});
await ok("表がまだ無くても、画面は止めない", async () => {
  reset();
  db.missing = "gw_devices";
  const r = res();
  await me(post({ action: "beat", deviceUid: UID }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
});

console.log("— 見慣れない端末 —");
await ok("その人が既に別の端末を使っていれば、アラートを立てる", async () => {
  reset([device({ id: "d0", device_uid: "oldoldoldoldoldold" })]);
  await me(post({ action: "beat", deviceUid: UID2 }), res());
  const a = wrote("gw_device_alerts", "upsert")[0];
  assert.ok(a, "アラートが立つ");
  assert.equal(a.rows[0].rule, "unknown_device");
  assert.equal(a.opts.onConflict, "device_id,dedupe_key");
  assert.equal(a.opts.ignoreDuplicates, true, "同じ端末で何度も作らない");
});
await ok("その人の最初の端末では立てない（入社した日に出しても意味がない）", async () => {
  reset();
  await me(post({ action: "beat", deviceUid: UID }), res());
  assert.equal(wrote("gw_device_alerts").length, 0);
});
await ok("会社の設定で止められる", async () => {
  reset([device({ id: "d0", device_uid: "oldoldoldoldoldold" })]);
  db.rows.gw_device_policies = [{ tenant_id: "t1", unknown_alert: false }];
  await me(post({ action: "beat", deviceUid: UID2 }), res());
  assert.equal(wrote("gw_device_alerts").length, 0);
});

console.log("— 確認したあと —");
await ok("利用時間を数えはじめる", async () => {
  reset([device()]);
  const r = res();
  await me(post({ action: "beat", deviceUid: UID }), r);
  assert.equal(r.body.confirmed, true);
  const u = wrote("gw_device_usage", "upsert")[0];
  assert.ok(u);
  assert.equal(u.rows[0].active_min, 1, "はじめての合図は1分");
  assert.equal(u.rows[0].beats, 1);
  assert.equal(u.opts.onConflict, "device_id,work_date");
});
await ok("最終利用を更新する", async () => {
  const up = wrote("gw_devices", "update")[0];
  assert.ok(up.row.last_seen_at);
});
await ok("前の合図から5分なら、その5分ぶんを足す", async () => {
  reset([device()]);
  const ago = new Date(Date.now() - 5 * 60000).toISOString();
  db.rows.gw_device_usage = [{
    device_id: "d1", work_date: TODAY, active_min: 10, night_min: 0, holiday_min: 0,
    beats: 3, first_at: ago, last_at: ago,
  }];
  await me(post({ action: "beat", deviceUid: UID }), res());
  const u = wrote("gw_device_usage", "upsert")[0].rows[0];
  assert.equal(u.active_min, 15, "10 + 5");
  assert.equal(u.beats, 4);
});
await ok("間が空いたぶんは足さない（閉じていた時間）", async () => {
  reset([device()]);
  const ago = new Date(Date.now() - 3 * 3600000).toISOString();
  db.rows.gw_device_usage = [{
    device_id: "d1", work_date: TODAY, active_min: 10, night_min: 0, holiday_min: 0,
    beats: 3, first_at: ago, last_at: ago,
  }];
  await me(post({ action: "beat", deviceUid: UID }), res());
  assert.equal(wrote("gw_device_usage", "upsert")[0].rows[0].active_min, 11);
});
await ok("深夜がたまったらアラートを立てる", async () => {
  reset([device()]);
  const ago = new Date(Date.now() - 5 * 60000).toISOString();
  db.rows.gw_device_usage = [{
    device_id: "d1", work_date: TODAY, active_min: 200, night_min: 90, holiday_min: 0,
    beats: 50, first_at: ago, last_at: ago,
  }];
  db.rows.gw_device_policies = [{ tenant_id: "t1", night_from: "00:00", night_to: "23:59" }];
  await me(post({ action: "beat", deviceUid: UID }), res());
  const a = wrote("gw_device_alerts", "upsert")[0];
  assert.equal(a.rows[0].rule, "night_access");
  assert.equal(a.rows[0].severity, "warn", "要確認どまり");
});

console.log("— 拡張が届かなくなったら、いつからかを置く —");
//
//   その場の一瞬で決めると、誤検知する。
//   ブラウザの立ち上げ直し・拡張の自動更新・一時的な停止でも、
//   「合図は来ているのに拡張からは届かない」は普通に起きる。
//   毎日どこかの誰かが赤くなると、本当に外した人が埋もれる。
//   だから合図のたびに「いつから続いているか」だけを置いて、
//   × にするかどうかは見る側（lib/watch.js）が決める。

const extUp = () => wrote("gw_devices", "update")
  .filter((w) => Object.keys(w.row).join() === "ext_missing_since");

await ok("拡張から届いていなければ、時刻を置く", async () => {
  reset([device({ installed_at: "2026-09-01T00:00:00Z", last_seen_at: new Date(Date.now() - 60000).toISOString() })]);
  db.rows.gw_device_browsers = [{
    tenant_id: "t1", device_id: "d1",
    last_seen_at: new Date(Date.now() - 3 * 3600000).toISOString(),
  }];
  await me(post({ action: "beat", deviceUid: UID }), res());
  const w = extUp();
  assert.equal(w.length, 1, "1回だけ書く");
  assert.ok(w[0].row.ext_missing_since, "いつからかを置く");
});

await ok("拡張から届いていれば、時刻を消す", async () => {
  reset([device({ installed_at: "2026-09-01T00:00:00Z",
                  ext_missing_since: "2026-09-01T00:00:00Z" })]);
  db.rows.gw_device_browsers = [{
    tenant_id: "t1", device_id: "d1", last_seen_at: new Date().toISOString(),
  }];
  await me(post({ action: "beat", deviceUid: UID }), res());
  assert.equal(extUp()[0].row.ext_missing_since, null);
});

await ok("すでに立っていれば、いつからかを上書きしない", async () => {
  // ここを上書きすると、いつまでも「さっきから」になって × に届かない
  reset([device({ installed_at: "2026-09-01T00:00:00Z",
                  last_seen_at: new Date(Date.now() - 60000).toISOString(),
                  ext_missing_since: new Date(Date.now() - 3 * 3600000).toISOString() })]);
  db.rows.gw_device_browsers = [{
    tenant_id: "t1", device_id: "d1",
    last_seen_at: new Date(Date.now() - 3 * 3600000).toISOString(),
  }];
  await me(post({ action: "beat", deviceUid: UID }), res());
  assert.equal(extUp().length, 0, "触らない");
});

await ok("合図が途切れていたら、時計を引き直す", async () => {
  // ブラウザを閉じていた。開き直した直後は、拡張がまだ1回も送っていない。
  // 前の時刻を引き継ぐと、開いた瞬間に × になる
  const old = new Date(Date.now() - 5 * 3600000).toISOString();
  reset([device({ installed_at: "2026-09-01T00:00:00Z",
                  last_seen_at: old, ext_missing_since: old })]);
  db.rows.gw_device_browsers = [{ tenant_id: "t1", device_id: "d1", last_seen_at: old }];
  await me(post({ action: "beat", deviceUid: UID }), res());
  const w = extUp();
  assert.equal(w.length, 1);
  assert.ok(Date.parse(w[0].row.ext_missing_since) > Date.parse(old), "引き直す");
});

await ok("一度も登録していないブラウザには、何も置かない", async () => {
  reset([device({ installed_at: null })]);
  db.rows.gw_device_browsers = [];
  await me(post({ action: "beat", deviceUid: UID }), res());
  assert.equal(extUp().length, 0, "「未設定」と「外れた」を混ぜない");
});

console.log("— 停止・使用終了の端末 —");
await ok("使用終了にした端末からは、数えない", async () => {
  reset([device({ status: "retired" })]);
  const r = res();
  await me(post({ action: "beat", deviceUid: UID }), r);
  assert.equal(r.body.confirmed, false);
  assert.equal(wrote("gw_device_usage").length, 0);
});
await ok("停止中の端末からも、数えない", async () => {
  reset([device({ status: "suspended" })]);
  await me(post({ action: "beat", deviceUid: UID }), res());
  assert.equal(wrote("gw_device_usage").length, 0);
});

console.log("— 同じブラウザで別の人がログインした —");
await ok("その人の端末に付け替えて、確認はやり直しにする", async () => {
  reset([device({ employee_id: "emp-9" })]);
  const r = res();
  await me(post({ action: "beat", deviceUid: UID }), r);
  assert.equal(r.body.changedHands, true);
  const up = wrote("gw_devices", "update")[0];
  assert.equal(up.row.employee_id, "emp-1");
  assert.equal(up.row.notified_at, null, "前の人が読んだことを、次の人の承認にしない");
  assert.equal(up.row.status, "unconfirmed");
  assert.equal(wrote("gw_device_usage").length, 0, "確認前なので数えない");
});

console.log("— 本人の操作 —");
await ok("「このパソコンです」で確認済みになる", async () => {
  reset([device({ status: "unconfirmed", notified_at: null })]);
  const r = res();
  await me(post({ action: "confirm", deviceUid: UID }), r);
  assert.equal(r.statusCode, 200);
  const up = wrote("gw_devices", "update")[0];
  assert.ok(up.row.notified_at);
  assert.equal(up.row.status, "active");
  assert.equal(wrote("gw_device_events", "insert")[0].row.kind, "confirmed");
});
await ok("2回押しても壊れない", async () => {
  reset([device()]);
  const r = res();
  await me(post({ action: "confirm", deviceUid: UID }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(wrote("gw_devices", "update").length, 0, "もう入っているので触らない");
});
await ok("他人の端末は確認できない", async () => {
  reset([device({ employee_id: "emp-9" })]);
  const r = res();
  await me(post({ action: "confirm", deviceUid: UID }), r);
  assert.equal(r.statusCode, 404);
  assert.equal(wrote("gw_devices", "update").length, 0);
});
await ok("よその会社の端末も触れない", async () => {
  reset([device({ tenant_id: "t-other" })]);
  const r = res();
  await me(post({ action: "confirm", deviceUid: UID }), r);
  assert.equal(r.statusCode, 404);
});
await ok("名前を変えられる", async () => {
  reset([device()]);
  await me(post({ action: "rename", deviceUid: UID, label: "  事務所のノート  " }), res());
  assert.equal(wrote("gw_devices", "update")[0].row.label, "事務所のノート");
  assert.equal(wrote("gw_device_events", "insert")[0].row.kind, "renamed");
});
await ok("空の名前は受け取らない", async () => {
  reset([device()]);
  const r = res();
  await me(post({ action: "rename", deviceUid: UID, label: "   " }), r);
  assert.equal(r.statusCode, 400);
});
// 端末管理は会社ルール。本人が外して解除できる仕組みは作らない。
// 自分で外せると、私物や未登録のPCで入ったあと
// 行を消して見えなくする、という道ができてしまう
await ok("本人は端末を外せない", async () => {
  reset([device()]);
  const r = res();
  await me(post({ action: "forget", deviceUid: UID }), r);
  assert.equal(r.statusCode, 403);
  assert.equal(wrote("gw_devices", "update").length, 0, "台帳を動かさない");
  assert.match(r.body.hint, /管理者/);
});
await ok("アプリとして入れたことを残せる", async () => {
  reset([device()]);
  await me(post({ action: "installed", deviceUid: UID }), res());
  assert.ok(wrote("gw_devices", "update")[0].row.installed_at);
});
await ok("知らない操作は受け取らない", async () => {
  reset([device()]);
  const r = res();
  await me(post({ action: "delete_everything", deviceUid: UID }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(wrote("gw_devices", "update").length, 0);
});

console.log("— 本人が読む —");
// 社員向けは「会社ルールの周知」。同意を求める文にしない。
// 何をしているかは出すが、判定のしかたは出さない
await ok("周知の文が付いてくる", async () => {
  reset([device()]);
  const r = res();
  await me(get(), r);
  assert.equal(r.statusCode, 200);
  const n = r.body.notice;

  assert.match(n.lead, /情報セキュリティ・業務管理・労務管理/);
  assert.match(n.lead, /公開していません/, "判定のしかたは出さないと、そう書く");
  // この端末で、実際に取っているものだけ。
  //
  // 以前はここに「外部機器の接続状況」「ソフトウェアの変更状況」が入っていた。
  // どちらもパソコンに入れる常駐ソフト（EXE）でしか取れないもので、
  // 入れていない人には取っていない。
  // 取っていないものを「記録します」と伝えるのは、多く取るのと同じくらい良くない。
  //
  // 同じ理由で WEB利用も外した。あれは拡張をつないだ端末でしか取れない。
  // つないでいれば下の「告知に出すもの」で足して出す
  assert.deepEqual(n.areas, [
    "グループウェアの利用状況（ログイン・最終アクセス・操作中／離席）",
    "勤怠・日報・タスクの記録",
    "セキュリティ上必要な端末情報（OS・ブラウザ・端末の識別子）",
  ], "ログインするだけの端末で、実際に取っているものだけ");
  for (const gone of ["外部機器", "ソフトウェアの変更", "アプリケーション"]) {
    assert.ok(!n.areas.some((a) => a.includes(gone)),
      `EXE でしか取れない「${gone}」を、全員への案内に書いています`);
  }
  assert.match(n.rule, /私物PCでの業務利用は禁止/);
  assert.match(n.ack, /同意を求めるものではありません/);
  assert.match(n.yours, /あなたの画面に残ります/);
});

await ok("しきい値や検知条件は、社員向けに出さない", async () => {
  reset([device()]);
  const r = res();
  await me(get(), r);
  const all = JSON.stringify(r.body.notice) + JSON.stringify(r.body.agentNotice || {});
  for (const ng of ["90分", "60分", "1時間以上", "24時間", "しきい値",
                    "クエリ", "?", "Cookie", "dedupe"]) {
    assert.ok(!all.includes(ng), `社員向けに出さない: ${ng}`);
  }
});
await ok("自分の端末が出る", async () => {
  reset([device()]);
  const r = res();
  await me(get(), r);
  assert.equal(r.body.devices.length, 1);
  assert.equal(r.body.devices[0].uid, UID);
  assert.equal(r.body.devices[0].confirmed, true);
});
await ok("使用終了にした端末は、本人の画面には出さない", async () => {
  reset([device({ status: "retired" })]);
  const r = res();
  await me(get(), r);
  assert.equal(r.body.devices.length, 0);
});
await ok("同じ日に2台使っていたら、日ごとにまとめる", async () => {
  reset([device(), device({ id: "d2", device_uid: UID2 })]);
  db.rows.gw_device_usage = [
    { device_id: "d1", work_date: "2026-09-09", active_min: 100, night_min: 0, holiday_min: 0,
      first_at: "2026-09-09T00:10:00Z", last_at: "2026-09-09T05:00:00Z" },
    { device_id: "d2", work_date: "2026-09-09", active_min: 50, night_min: 10, holiday_min: 0,
      first_at: "2026-09-09T02:00:00Z", last_at: "2026-09-09T08:00:00Z" },
  ];
  const r = res();
  await me(get(), r);
  assert.equal(r.body.usage.length, 1);
  assert.equal(r.body.usage[0].activeMin, 150);
  assert.equal(r.body.usage[0].nightMin, 10);
  assert.equal(r.body.usage[0].active, "2:30");
  assert.equal(r.body.usage[0].firstAt, "2026-09-09T00:10:00Z", "いちばん早い時刻");
  assert.equal(r.body.usage[0].lastAt, "2026-09-09T08:00:00Z", "いちばん遅い時刻");
});
await ok("誰が自分の記録を見たかが返る", async () => {
  reset([device()]);
  db.rows.gw_device_views = [
    { employee_id: "emp-1", at: "2026-09-09T01:00:00Z", viewer_name: "事務", scope: "device" },
    { employee_id: "emp-1", at: "2026-09-08T01:00:00Z", viewer_name: "事務", scope: "csv" },
  ];
  const r = res();
  await me(get(), r);
  assert.equal(r.body.views.length, 2);
  assert.equal(r.body.views[0].who, "事務");
  assert.equal(r.body.views[0].what, "端末の記録");
  assert.equal(r.body.views[1].what, "書き出し");
});
await ok("表がまだ無くても、本人の画面は開く", async () => {
  reset();
  db.missing = "gw_devices";
  const r = res();
  await me(get(), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
  assert.ok(r.body.notice, "告知は読める");
});

console.log("— エージェントの資格情報 —");
await ok("シークレットが違えば 401", async () => {
  reset([agent()]);
  const r = res();
  await config(devReq("GET", null, "wrong"), r);
  assert.equal(r.statusCode, 401);
});
await ok("社員のJWTでは通らない", async () => {
  reset([agent()]);
  const r = res();
  await config({ method: "GET", url: "/x", headers: { authorization: "Bearer eyJhb..." } }, r);
  assert.equal(r.statusCode, 401);
});
await ok("ブラウザの行のIDでは通らない（シークレットを持たない）", async () => {
  reset([device({ id: AGENT_ID, source: "browser", secret_hash: null })]);
  const r = res();
  await config(devReq("GET"), r);
  assert.equal(r.statusCode, 401);
});
await ok("使用終了のパソコンは 403", async () => {
  reset([agent({ status: "retired" })]);
  const r = res();
  await config(devReq("GET"), r);
  assert.equal(r.statusCode, 403);
});

console.log("— 本人が承認するまで、エージェントは何も送らない —");
await ok("notified_at が null なら collect:false", async () => {
  reset([agent({ notified_at: null, status: "unconfirmed" })]);
  const r = res();
  await config(devReq("GET"), r);
  assert.equal(r.body.collect, false);
  assert.equal(r.body.reason, "not_notified");
  assert.equal(r.body.siteCategories, undefined, "設定そのものを配らない");
});
await ok("確認済みなら collect:true とカテゴリ表を配る", async () => {
  reset([agent()]);
  const r = res();
  await config(devReq("GET"), r);
  assert.equal(r.body.collect, true);
  assert.equal(r.body.siteCategories["github.com"], "work");
  assert.ok(r.body.never.includes("keystrokes"));
  assert.ok(r.body.never.includes("full_urls"));
});
await ok("確認前に送りつけても、1件も入らない", async () => {
  reset([agent({ notified_at: null, status: "unconfirmed" })]);
  const r = res();
  await ingest(devReq("POST", {
    events: [{ seq: 1, at: "2026-09-09T01:00:00Z", kind: "boot" }],
    usage: [{ workDate: "2026-09-09", activeMin: 400 }],
    apps: [{ workDate: "2026-09-09", exeName: "chrome.exe", minutes: 100 }],
  }), r);
  assert.equal(r.statusCode, 200, "エージェントに再送させ続けない");
  assert.equal(r.body.collect, false);
  assert.equal(db.writes.length, 0, "どの表にも書かない");
});

console.log("— 取り込み —");
await ok("できごと・稼働・アプリ・サイトが入る", async () => {
  reset([agent()]);
  const r = res();
  await ingest(devReq("POST", {
    agentVersion: "1.2.0",
    events: [{ seq: 10, at: "2026-09-09T01:00:00Z", kind: "boot" }],
    usage: [{ workDate: "2026-09-09", activeMin: 372, idleMin: 58 }],
    apps: [{ workDate: "2026-09-09", exeName: "EXCEL.EXE", minutes: 120 }],
    web: [{ workDate: "2026-09-09", category: "work", minutes: 100 }],
  }), r);
  assert.deepEqual(r.body.accepted, { events: 1, usage: 1, apps: 1, web: 1 });
  const t = db.writes.map((w) => w.table);
  assert.ok(t.includes("gw_device_events"));
  assert.ok(t.includes("gw_device_usage"));
  assert.ok(t.includes("gw_device_app_usage"));
  assert.ok(t.includes("gw_device_web_usage"));
});
await ok("同じ seq が2度来ても1行にする指定で書く", async () => {
  const w = wrote("gw_device_events", "upsert")[0];
  assert.equal(w.opts.onConflict, "device_id,seq");
  assert.equal(w.opts.ignoreDuplicates, true);
});
await ok("送られてきた余計な鍵は入らない", async () => {
  reset([agent()]);
  await ingest(devReq("POST", {
    events: [{ seq: 11, at: "2026-09-09T01:00:00Z", kind: "usb_attach",
               detail: { class: "mass_storage", windowTitle: "見積書.xlsx", url: "https://x/secret" } }],
    web: [{ workDate: "2026-09-09", category: "work", minutes: 10, hostname: "github.com" }],
  }), res());
  const ev = wrote("gw_device_events", "upsert")[0].rows[0];
  assert.deepEqual(Object.keys(ev.detail), ["class"]);
  assert.equal(wrote("gw_device_web_usage", "upsert")[0].rows[0].hostname, undefined);
});
await ok("端末が「重大です」と言ってきても、それは使わない", async () => {
  reset([agent()]);
  await ingest(devReq("POST", {
    alerts: [{ severity: "critical", title: "でっちあげ" }],
    events: [{ seq: 20, at: "2026-09-09T01:00:00Z", kind: "lock" }],
  }), res());
  assert.equal(wrote("gw_device_alerts").length, 0);
});
await ok("禁止ソフトは、会社の表に載っているときだけ重大にする", async () => {
  reset([agent()]);
  db.rows.gw_device_policies = [{ tenant_id: "t1", blocked_software: ["teamviewer"] }];
  await ingest(devReq("POST", {
    events: [{ seq: 21, at: "2026-09-09T01:00:00Z", kind: "app_install",
               detail: { name: "TeamViewer 15" } }],
  }), res());
  const a = wrote("gw_device_alerts", "upsert")[0];
  assert.equal(a.rows[0].severity, "critical");
  assert.equal(a.opts.ignoreDuplicates, true);
});

console.log("— 登録 —");
const enrollRes = async (body) => {
  const r = res();
  await enroll({ method: "POST", url: "/api/devices/enroll", headers: {}, body }, r);
  return r;
};
const openToken = (over = {}) => ({
  id: "e1", tenant_id: "t1", token_hash: sha256("ABCD-2345-KMNP"),
  employee_id: "emp-1", expires_at: new Date(Date.now() + 86400000).toISOString(),
  // created_at は DB 側で not null default now()。偽の行にも入れておく
  used_at: null, created_by: "u-hr", created_at: "2026-09-01T00:00:00Z", ...over,
});
await ok("使えないコードでは登録できない", async () => {
  reset();
  const r = await enrollRes({ enrollToken: "ABCD-2345-KMNP", deviceUid: "u1", hostname: "PC1" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_token");
});
await ok("使用済み・期限切れは、無いのと同じ返事にする", async () => {
  reset();
  db.rows.gw_device_enrollments = [openToken({ used_at: "2026-09-08T00:00:00Z" })];
  const r = await enrollRes({ enrollToken: "ABCD-2345-KMNP", deviceUid: "u1", hostname: "PC1" });
  assert.equal(r.body.error, "invalid_token");
});
await ok("使えるコードなら、端末とシークレットと案内URLを返す", async () => {
  reset();
  db.rows.gw_device_enrollments = [openToken()];
  const r = await enrollRes({ enrollToken: "abcd-2345-kmnp", deviceUid: "u1",
                              hostname: "8GRP-PC-01", agentVersion: "1.0.0" });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.secret && r.body.secret.length >= 40);
  assert.equal(r.body.collect, false, "登録しただけでは、まだ送らない");
  assert.match(r.body.linkUrl, /device-consent\.html\?link=/, "本人に開かせるURLを返す");
  const ins = wrote("gw_devices", "insert")[0];
  assert.equal(ins.row.source, "agent");
  assert.equal(ins.row.secret_hash, sha256(r.body.secret), "平文は保存しない");
  assert.equal(ins.row.notified_at, undefined, "登録では告知済みにしない");
  assert.ok(ins.row.link_code_hash, "合言葉はハッシュで持つ");
  assert.ok(wrote("gw_device_enrollments", "update")[0].row.used_at, "コードは使い切る");
});
await ok("入れ直しでは、本人の確認も割り当ても消さない", async () => {
  reset([agent({ device_uid: "u1", notified_at: "2026-09-01T00:00:00Z", employee_id: "emp-9" })]);
  db.rows.gw_device_enrollments = [openToken()];
  const r = await enrollRes({ enrollToken: "ABCD-2345-KMNP", deviceUid: "u1", hostname: "PC1-new" });
  assert.equal(r.statusCode, 200);
  const up = wrote("gw_devices", "update")[0];
  assert.equal(up.row.notified_at, undefined, "確認済みのままにする");
  assert.equal(up.row.employee_id, undefined, "使う人を勝手に付け替えない");
  assert.equal(up.row.hostname, "PC1-new");
  assert.equal(r.body.collect, true);
});
await ok("他社のパソコンは、こちらのコードでは奪えない", async () => {
  reset([agent({ device_uid: "u1", tenant_id: "t-other" })]);
  db.rows.gw_device_enrollments = [openToken()];
  const r = await enrollRes({ enrollToken: "ABCD-2345-KMNP", deviceUid: "u1", hostname: "PC1" });
  assert.equal(r.statusCode, 400);
  assert.equal(wrote("gw_devices").length, 0);
});
await ok("ブラウザの行と device_uid がぶつかっても、乗っ取れない", async () => {
  reset([device({ device_uid: "u1", source: "browser" })]);
  db.rows.gw_device_enrollments = [openToken()];
  const r = await enrollRes({ enrollToken: "ABCD-2345-KMNP", deviceUid: "u1", hostname: "PC1" });
  assert.equal(r.statusCode, 400);
});

console.log("— パソコンとブラウザをつなぐ —");
const CODE = "link-code-abc";
await ok("本人が案内を開くと、そのパソコンはその人のものになる", async () => {
  reset([agent({ employee_id: null, notified_at: null, status: "unconfirmed",
                 link_code_hash: sha256(CODE),
                 link_expires_at: new Date(Date.now() + 86400000).toISOString() }),
         device()]);
  const r = res();
  await me(post({ action: "link", linkCode: CODE, deviceUid: UID }), r);
  assert.equal(r.statusCode, 200);
  const ups = wrote("gw_devices", "update");
  assert.equal(ups[0].row.employee_id, "emp-1", "ログインしている人のパソコンになる");
  assert.equal(ups[0].row.link_code_hash, null, "合言葉は使い切る");
  assert.equal(ups[1].row.linked_device_id, AGENT_ID, "ブラウザの行から、このPCを指す");
  assert.equal(wrote("gw_device_events", "insert")[0].row.kind, "linked");
  assert.equal(r.body.device.confirmed, false, "つないだだけでは収集は始まらない");
});
await ok("使い切った合言葉は、2回目は通らない", async () => {
  reset([agent({ link_code_hash: null })]);
  const r = res();
  await me(post({ action: "link", linkCode: CODE, deviceUid: UID }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_link");
});
await ok("期限切れの合言葉も通らない", async () => {
  reset([agent({ link_code_hash: sha256(CODE),
                 link_expires_at: new Date(Date.now() - 1000).toISOString() })]);
  const r = res();
  await me(post({ action: "link", linkCode: CODE, deviceUid: UID }), r);
  assert.equal(r.statusCode, 400);
});
await ok("よその会社の合言葉は通らない", async () => {
  reset([agent({ tenant_id: "t-other", link_code_hash: sha256(CODE),
                 link_expires_at: new Date(Date.now() + 86400000).toISOString() })]);
  const r = res();
  await me(post({ action: "link", linkCode: CODE, deviceUid: UID }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(wrote("gw_devices", "update").length, 0);
});
await ok("エージェントの行も、本人が id で確認できる", async () => {
  reset([agent({ notified_at: null, status: "unconfirmed" })]);
  const r = res();
  await me(post({ action: "confirm", deviceId: AGENT_ID }), r);
  assert.equal(r.statusCode, 200);
  const up = wrote("gw_devices", "update")[0];
  assert.ok(up.row.notified_at);
  assert.equal(up.row.status, "active");
});
await ok("他人のパソコンは確認できない", async () => {
  reset([agent({ employee_id: "emp-9", notified_at: null })]);
  const r = res();
  await me(post({ action: "confirm", deviceId: AGENT_ID }), r);
  assert.equal(r.statusCode, 404);
});
await ok("エージェントを入れていれば、対象の範囲も返る", async () => {
  reset([agent()]);
  const r = res();
  await me(get(), r);
  const an = r.body.agentNotice;
  assert.ok(an, "入れている人には出す");
  assert.match(an.lead, /このパソコンを使っているあいだ/);
  assert.match(an.scope, /原則として勤務時間内/);
  assert.match(an.scope, /時間外も対象/, "安全管理に関わるものは時間外も、と書く");

  reset([device()]);
  const r2 = res();
  await me(get(), r2);
  assert.equal(r2.body.agentNotice, null, "入れていない人には出さない");
});

// 大分類は、ソフトが入っていても入っていなくても同じ。
// 行を出し分けて「取っていません」と書いたものを実は取っている、をやらない
await ok("記録する範囲は、ソフトの有無で変えない", async () => {
  reset([agent()]);
  const r = res();
  await me(get(), r);
  assert.match(r.body.notice.scope, /このパソコンを使っているあいだ/);

  reset([device()]);
  const r2 = res();
  await me(get(), r2);
  assert.deepEqual(r2.body.notice.areas, r.body.notice.areas, "大分類は同じ");
  assert.match(r2.body.notice.scope, /社内システムを開いているあいだ/);
});

console.log("— 管理者：所有者変更と紐付け解除 —");
const adminReq = (method, body, qs = "") => ({
  method, url: `/api/devices${qs}`, body, headers: { authorization: "Bearer x" },
});
const EMP = (id, name) => ({ id, tenant_id: "t1", display_name: name, user_id: `u-${id}` });

await ok("所有者を変えると、本人の確認はやり直しになる", async () => {
  reset([agent()]);
  db.rows.gw_employees = [EMP("emp-1", "山田 太郎"), EMP("emp-2", "鈴木 花子")];
  const r = res();
  await adminDev(adminReq("PATCH", { action: "assign", deviceId: AGENT_ID, employeeId: "emp-2" }), r);
  assert.equal(r.statusCode, 200);
  const up = wrote("gw_devices", "update")[0];
  assert.equal(up.row.employee_id, "emp-2");
  assert.equal(up.row.notified_at, null, "前の人が読んだことを、次の人の承認にしない");
  assert.equal(up.row.status, "unconfirmed");
  assert.equal(up.row.admin_touched_what, "assign", "管理者が触ったことを台帳に残す");
  assert.ok(up.row.admin_touched_by);
  assert.equal(wrote("gw_device_events", "insert")[0].row.kind, "assigned");
});
await ok("同じ人に付け直したときは、確認をやり直さない", async () => {
  reset([agent({ employee_id: "emp-1" })]);
  db.rows.gw_employees = [EMP("emp-1", "山田 太郎")];
  await adminDev(adminReq("PATCH", { action: "assign", deviceId: AGENT_ID, employeeId: "emp-1" }), res());
  const up = wrote("gw_devices", "update")[0];
  assert.equal(up.row.notified_at, undefined, "確認済みのままにする");
});
await ok("名簿にない人は割り当てられない", async () => {
  reset([agent()]);
  db.rows.gw_employees = [];
  const r = res();
  await adminDev(adminReq("PATCH", { action: "assign", deviceId: AGENT_ID, employeeId: "emp-9" }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "bad_employee");
});
await ok("よその会社の端末は触れない", async () => {
  reset([agent({ tenant_id: "t-other" })]);
  const r = res();
  await adminDev(adminReq("PATCH", { action: "assign", deviceId: AGENT_ID, employeeId: null }), r);
  assert.equal(r.statusCode, 404);
});
await ok("パソコン側から外すと、ぶら下がるブラウザをまとめて外す", async () => {
  reset([agent(), device({ id: "b1", linked_device_id: AGENT_ID }),
         device({ id: "b2", device_uid: UID2, linked_device_id: AGENT_ID })]);
  const r = res();
  await adminDev(adminReq("PATCH", { action: "unlink", deviceId: AGENT_ID }), r);
  assert.equal(r.statusCode, 200);
  const ups = wrote("gw_devices", "update");
  assert.ok(ups.some((u) => u.row.linked_device_id === null), "ブラウザ側の紐付けを消す");
  assert.deepEqual(r.body.unlinked, ["Windows の Chrome", "Windows の Chrome"]);
});
await ok("紐付けを外しても、記録は消さない", async () => {
  assert.equal(wrote("gw_device_usage", "delete").length, 0);
  assert.equal(wrote("gw_device_events", "delete").length, 0);
  assert.equal(wrote("gw_devices", "delete").length, 0);
});
await ok("ブラウザ側から外すと、その行だけ外れる", async () => {
  reset([device({ linked_device_id: AGENT_ID })]);
  const r = res();
  await adminDev(adminReq("PATCH", { action: "unlink", deviceId: "d1" }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(wrote("gw_devices", "update")[0].row.linked_device_id, null);
});
await ok("繋がっていない端末を外しても、壊れない", async () => {
  reset([device({ linked_device_id: null })]);
  const r = res();
  await adminDev(adminReq("PATCH", { action: "unlink", deviceId: "d1" }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.already, true);
});

console.log("— 管理者：登録コードは廃止。記録だけ残す —");

// 社員はログインしているので、誰なのかはもう分かっている。
// コードを配って打たせるのは、配る手間と打ち間違いを足しているだけで、
// 確かめられることは増えていない
await ok("管理者はもう発行できない", async () => {
  reset();
  db.rows.gw_employees = [EMP("emp-1", "山田 太郎")];
  const r = res();
  await adminDev(adminReq("PATCH", { action: "issue_token", employeeId: "emp-1" }), r);
  assert.equal(r.statusCode, 410);
  assert.match(r.body.hint, /マイページ/, "どこから登録するか言う");
  assert.equal(wrote("gw_device_enrollments", "insert").length, 0, "新しいコードは作らない");
});
await ok("まだ使っていないコードは取り消せる", async () => {
  reset();
  db.rows.gw_device_enrollments = [{ id: "e1", tenant_id: "t1", used_at: null, revoked_at: null }];
  const r = res();
  await adminDev(adminReq("PATCH", { action: "revoke_token", enrollmentId: "e1" }), r);
  assert.equal(r.statusCode, 200);
  const up = wrote("gw_device_enrollments", "update")[0];
  assert.ok(up.row.revoked_at);
  assert.ok(up.row.revoked_by);
  assert.equal(wrote("gw_device_enrollments", "delete").length, 0, "行は消さない");
});
await ok("使われたコードは取り消せない。端末を止めろと言う", async () => {
  reset();
  db.rows.gw_device_enrollments = [{ id: "e1", tenant_id: "t1", used_at: "2026-09-09T00:00:00Z" }];
  const r = res();
  await adminDev(adminReq("PATCH", { action: "revoke_token", enrollmentId: "e1" }), r);
  assert.equal(r.statusCode, 409);
  assert.match(r.body.hint, /端末のほうを停止/);
});
await ok("取り消したコードは、端末から使えない", async () => {
  reset();
  db.rows.gw_device_enrollments = [openToken({ revoked_at: "2026-09-09T00:00:00Z" })];
  const r = await enrollRes({ enrollToken: "ABCD-2345-KMNP", deviceUid: "u1", hostname: "PC1" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_token");
});
await ok("コードが使われたことを、監査ログに残す", async () => {
  reset();
  db.rows.gw_device_enrollments = [openToken()];
  await enrollRes({ enrollToken: "ABCD-2345-KMNP", deviceUid: "u1", hostname: "8GRP-PC-01" });
  const log = wrote("gw_activity_log", "insert").map((w) => w.row);
  const used = log.find((r) => r.action === "device.token_used");
  assert.ok(used, "使われたことがログに残る");
  assert.equal(used.detail.hostname, "8GRP-PC-01", "どの端末に使われたか");
  assert.equal(used.detail.issuedBy, "u-hr", "誰が発行したか");
  assert.ok(used.detail.issuedAt, "いつ発行したか");
});
await ok("発行履歴が読める", async () => {
  reset([agent()]);
  db.rows.gw_employees = [{ ...EMP("emp-1", "山田 太郎"), user_id: "u-hr" }];
  db.rows.gw_device_enrollments = [
    { id: "e1", tenant_id: "t1", employee_id: "emp-1", created_by: "u-hr",
      created_at: "2026-09-01T00:00:00Z",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      used_at: "2026-09-02T00:00:00Z", used_by: AGENT_ID, revoked_at: null },
  ];
  const r = res();
  await adminDev(adminReq("GET", null, "?enrollments=1"), r);
  assert.equal(r.statusCode, 200);
  const e = r.body.enrollments[0];
  assert.equal(e.issuedBy, "山田 太郎");
  assert.equal(e.forWhom, "山田 太郎");
  assert.equal(e.usedBy, "8GRP-PC-01", "どの端末に使われたか");
  assert.equal(e.state.key, "used");
});

console.log("— 未通信のエージェント —");
await ok("24時間届かなければ「未通信」と出す", async () => {
  const { deviceState } = await import(atRoot("lib/devices.js"));
  const old = new Date(Date.now() - 30 * 3600000).toISOString();
  const st = deviceState(
    { source: "agent", status: "active", notified_at: "2026-09-01T00:00:00Z", last_seen_at: old });
  assert.equal(st.key, "silent");
  assert.equal(st.label, "未通信");
  assert.match(st.note, /ソフトが止まっている/);
});
await ok("一度も届いていない端末は、そう書く", async () => {
  const { deviceState } = await import(atRoot("lib/devices.js"));
  const st = deviceState(
    { source: "agent", status: "active", notified_at: "2026-09-01T00:00:00Z", last_seen_at: null });
  assert.equal(st.key, "silent");
  assert.match(st.note, /まだ一度も/);
});


console.log("— 自動更新（署名が無ければ配らない）—");
const { default: manifest } = await import(atRoot("api/devices/manifest.js"));
const SIG = "oLQrEmJtUvGQJCbkRTl1yToWw_fEYsTrbMpVPxHrHZ39sznYU5XKpOl9pdVZVy5IhWqw6FUamnIrXVSMEBjiAw";
const rel = (over = {}) => ({
  id: "r1", tenant_id: "t1", version: "0.3.0", published: true,
  // 配布物は非公開のバケット。URLは持たず、置き場所だけ持つ
  bucket: "agent", object_path: "0.3.0/EIGHT-Agent-Setup.exe", url: null,
  sha256: "42e045565089fa3e05883aa74e217e46ac545c3e46e4337f5cdf21d0f709f7a7",
  size_bytes: 20912128, signature: SIG, key_id: "WGjsm6rX", ...over,
});
const noEnv = (fn) => async () => {
  const keep = {};
  for (const k of ["DEVICE_AGENT_VERSION", "DEVICE_AGENT_URL", "DEVICE_AGENT_SHA256",
                   "DEVICE_AGENT_SIZE", "DEVICE_AGENT_SIGNATURE", "DEVICE_AGENT_KEY_ID",
                   "DEVICE_AGENT_BUCKET", "DEVICE_AGENT_OBJECT"]) {
    keep[k] = process.env[k]; delete process.env[k];
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) process.env[k] = v;
  }
};

await ok("そろっていれば、署名ごと返す", noEnv(async () => {
  reset([agent()]);
  db.rows.gw_device_releases = [rel()];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.update, true);
  assert.equal(r.body.signature, SIG);
  assert.equal(r.body.sizeBytes, 20912128);
  assert.equal(r.body.keyId, "WGjsm6rX");

  // 署名されているのは置き場所。落とすURLはそのつど作る
  assert.equal(r.body.locator, "0.3.0/EIGHT-Agent-Setup.exe");
  assert.match(r.body.url, /^https:\/\//);
  assert.ok(storage.calls[0].sec <= 600, "URLは短命");
}));

await ok("上げる版が無いときは、URLを作りにいかない", noEnv(async () => {
  reset([agent({ agent_version: "0.3.0" })]);
  db.rows.gw_device_releases = [rel()];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, false);
  assert.equal(storage.calls.length, 0, "使わないURLを毎回作らない");
}));

await ok("URLを作れなければ、その回は更新させない", noEnv(async () => {
  reset([agent()]);
  storage.fail = true;
  db.rows.gw_device_releases = [rel()];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, false, "次の回に持ち越す");
}));

await ok("外に置いた版は、そのURLをそのまま返す", noEnv(async () => {
  reset([agent()]);
  db.rows.gw_device_releases = [rel({
    bucket: null, object_path: null,
    url: "https://mf.8grp.co.jp/agent/EIGHT-Agent-Setup.exe",
  })];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, true);
  assert.equal(r.body.url, "https://mf.8grp.co.jp/agent/EIGHT-Agent-Setup.exe");
  assert.equal(r.body.locator, "https://mf.8grp.co.jp/agent/EIGHT-Agent-Setup.exe",
    "外に置く版は、URLが置き場所になる");
}));

// ここがいちばん大事。商用の証明書が無いので、
// 署名の無い版を配ると「全PCで任意のコードが動く口」になる
await ok("署名が無ければ、更新させない", noEnv(async () => {
  reset([agent()]);
  db.rows.gw_device_releases = [rel({ signature: null })];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, false, "署名が無い版は配らない");
}));

await ok("大きさが無ければ、更新させない", noEnv(async () => {
  reset([agent()]);
  db.rows.gw_device_releases = [rel({ size_bytes: null })];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, false, "大きさが無いと、途中まで落ちたものを実行しかねない");
}));

await ok("置き場所が無ければ、更新させない", noEnv(async () => {
  reset([agent()]);
  db.rows.gw_device_releases = [rel({ bucket: null, object_path: null, url: null })];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, false);
}));

await ok("ハッシュが無ければ、更新させない", noEnv(async () => {
  reset([agent()]);
  db.rows.gw_device_releases = [rel({ sha256: null })];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, false);
}));

await ok("公開していない版は配らない", noEnv(async () => {
  reset([agent()]);
  db.rows.gw_device_releases = [rel({ published: false })];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, false);
}));

await ok("同じ版なら、入れ替えさせない", noEnv(async () => {
  reset([agent({ agent_version: "0.3.0" })]);
  db.rows.gw_device_releases = [rel()];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, false, "入っているのと同じ版で入れ替えを繰り返さない");
}));

await ok("よその会社の版は見えない", noEnv(async () => {
  reset([agent()]);
  db.rows.gw_device_releases = [rel({ tenant_id: "t2" })];
  const r = res();
  await manifest(devReq("GET"), r);
  assert.equal(r.body.update, false);
  assert.equal(r.body.version, null);
}));

await ok("資格情報が通らなければ、版すら教えない", noEnv(async () => {
  reset([agent()]);
  db.rows.gw_device_releases = [rel()];
  const r = res();
  await manifest(devReq("GET", null, "wrong-secret"), r);
  assert.equal(r.statusCode, 401);
  assert.equal(r.body?.version, undefined);
}));

// ---- 告知に、取っていないものを書かない ------------------------------------
//
// WEB利用（見たサイト）は、ブラウザ拡張をつないだ端末でしか取れない。
// つないでいない人の画面に「記録します」と出すと、
// 読んだ人は見たサイトが会社に渡っていると思って毎日を過ごすことになる。
// 実際には1件も渡っていない。取りすぎと同じくらい、これも嘘になる。
const WEB = "WEBの利用状況（見たサイトの種類・ドメイン・見ていた時間）";
const areasOf = async (rows, browsers) => {
  reset(rows);
  db.rows.gw_device_browsers = browsers;
  const r = res();
  await me(get(), r);
  return r.body.notice.areas;
};

console.log("— 告知に出すもの —");

await ok("拡張をつないでいない人には、WEB利用を出さない", async () => {
  const areas = await areasOf([device()], []);
  assert.ok(!areas.includes(WEB), "取れていないものを「記録します」と書かない");
  assert.ok(areas.some((a) => a.includes("グループウェアの利用状況")),
    "取れているものは、ちゃんと書く");
});

await ok("拡張がつながっていれば、WEB利用も出す", async () => {
  const areas = await areasOf([device()],
    [{ tenant_id: "t1", device_id: "d1", browser: "chrome", linked: true }]);
  assert.ok(areas.includes(WEB));
});

await ok("入れただけで、まだつないでいなければ出さない", async () => {
  const areas = await areasOf([device()],
    [{ tenant_id: "t1", device_id: "d1", browser: "chrome", linked: false }]);
  assert.ok(!areas.includes(WEB));
});

await ok("よその人の拡張では出さない", async () => {
  const areas = await areasOf([device()],
    [{ tenant_id: "t1", device_id: "d-other", browser: "chrome", linked: true }]);
  assert.ok(!areas.includes(WEB));
});

// 送っているのは拡張であって EXE ではない。
// EXE を入れたパソコンにも拡張は入るので、入れば下の行で出る
await ok("会社のソフトが入っていても、拡張がつながっていなければ出さない", async () => {
  assert.ok(!(await areasOf([agent()], [])).includes(WEB));
});

await ok("会社のソフトのパソコンでも、拡張がつながれば出す", async () => {
  const areas = await areasOf([agent()],
    [{ tenant_id: "t1", device_id: AGENT_ID, browser: "chrome", linked: true }]);
  assert.ok(areas.includes(WEB));
});

await ok("拡張の表がまだ無くても、画面は出る（WEB利用は出さない）", async () => {
  reset([device()]);
  db.missing = "gw_device_browsers";
  const r = res();
  await me(get(), r);
  assert.equal(r.statusCode, 200, "表が無いだけで、確認画面を止めない");
  assert.ok(!r.body.notice.areas.includes(WEB), "分からないときは、取っていない側に倒す");
});

console.log(`\n合計 ${n} 件 通過`);
