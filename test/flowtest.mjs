// EXE を実行してから、管理画面にそのPCが出るまでを、通しで走らせる。
//
// ■ なぜ通しで見るのか
//
//   1つずつは通るのに、つないだところで止まる、が実際に起きた。
//   api/devices/pair.js が enrollment_id を **SELECT し忘れていて**、
//   インストーラは永久に ready:false を受け取っていた。
//   画面には「時間内に終わりませんでした」としか出ないので、
//   どこで止まったのかも分からなかった。
//
//   偽の Supabase が行を丸ごと返していたので、テストは全部通っていた。
//   いまは本物と同じで、SELECT に書いた列しか返さない。
//
// ■ 見る順番（Windows実機でやることと同じ）
//
//   ① EXE がこのPCの札を預ける
//   ② 本人がブラウザで中身を見る
//   ③ まだ押していないので、インストーラは空振りする
//   ④ 本人が「このパソコンです」を押す
//   ⑤ インストーラが登録コードを引き取る   ← ここが止まっていた
//   ⑥ エージェントが登録する
//   ⑦ 引き取りは1回だけ
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);


// ---- SELECT した列だけを返す ------------------------------------------------
//
// 本物の PostgREST は、.select() に書いた列しか返さない。
// 偽物が行を丸ごと返していると、「書いてあるのに取り忘れている」が通ってしまう
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
    if (paren >= 0) s = s.slice(0, paren);
    const colon = s.indexOf(":");
    if (colon >= 0) s = s.slice(0, colon);
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

// ---- 偽の Supabase ----------------------------------------------------------
const db = { rows: {}, writes: [] };
let NOCOL = false;  // 063 未適用（last_poll_at が無い）状態

function table(name) {
  const f = [];
  const q = {
    _cols: null,
    select(spec) { q._cols = spec; return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    is(k, v) { f.push([k, v === null ? null : v]); return q; },
    not() { q._not = true; return q; },
    in(k, vs) { f.push([k, vs]); return q; },
    lt() { return q; },
    gte() { return q; },
    lte() { return q; },
    order() { return q; },
    limit(n) { q._limit = n; return q; },
    maybeSingle() {
      // 無い列を SELECT したら、本物は落ちる
      if (NOCOL && /last_poll_at/.test(q._cols || "")) {
        return Promise.resolve({ data: null,
          error: { code: "42703", message: 'column "last_poll_at" does not exist' } });
      }
      return Promise.resolve({ data: project(match(name, f)[0] || null, q._cols), error: null });
    },
    single() { return Promise.resolve({ data: project(match(name, f)[0] || null, q._cols), error: null }); },
    then(fn) {
      let rows = match(name, f).map((r) => project(r, q._cols));
      if (q._limit) rows = rows.slice(0, q._limit);
      return Promise.resolve({ data: rows, error: null, count: rows.length }).then(fn);
    },
    insert(row) {
      const made = { id: `${name}-${(db.rows[name] || []).length + 1}`, ...row };
      (db.rows[name] = db.rows[name] || []).push(made);
      db.writes.push({ op: "insert", table: name, row: made });
      const r = { select: (s) => { r._c = s; return r; },
                  single: () => Promise.resolve({ data: project(made, r._c), error: null }),
                  then: (fn) => Promise.resolve({ data: [made], error: null }).then(fn) };
      return r;
    },
    upsert(rows) {
      const list = [].concat(rows);
      for (const row of list) (db.rows[name] = db.rows[name] || []).push({ id: `${name}-u`, ...row });
      db.writes.push({ op: "upsert", table: name, rows: list });
      const r = { select: () => r, single: () => Promise.resolve({ data: list[0], error: null }),
                  then: (fn) => Promise.resolve({ data: list, error: null }).then(fn) };
      return r;
    },
    update(row) {
      const g = [];
      let notNullCol = null;
      const r = {
        eq(k, v) { g.push([k, v]); return r; },
        is(k, v) { g.push([k, v]); return r; },
        not(k) { notNullCol = k; return r; },
        select(s) { r._c = s; return r; },
        then(fn) {
          let hits = match(name, g);
          // .not("code_once", "is", null) … 中身があるものだけ
          if (notNullCol) hits = hits.filter((x) => x[notNullCol] != null);
          for (const h of hits) Object.assign(h, row);
          db.writes.push({ op: "update", table: name, row, hit: hits.length });
          return Promise.resolve({ data: hits, error: null }).then(fn);
        },
        single() { return r.then((x) => ({ data: x.data[0] || null, error: null })); },
      };
      return r;
    },
    delete() {
      const g = [];
      const r = { eq(k, v) { g.push([k, v]); return r; }, not: () => r, lt: () => r,
                  is: () => r, in: () => r, select: () => r,
                  then: (fn) => Promise.resolve({ data: [], error: null }).then(fn) };
      return r;
    },
  };
  return q;
}
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) => {
  if (k.startsWith("!")) return r[k.slice(1)] !== v;
  if (v === null) return r[k] == null;
  return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
}));

const fakeStorage = { from: () => ({
  createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://x/y" }, error: null }),
}) };

mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table, storage: fakeStorage }),
    userClient: () => ({ from: table, storage: fakeStorage }),
  },
});

// ログインしているのは山田さん（本人）。管理者ではない
let WHO = { id: "u-1", email: "yamada@8grp.co.jp" };
let CTX = {
  tenantId: "t1", isAdmin: false, isHr: false, memberships: [], roles: [],
  employee: { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎" },
};
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => WHO, getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => CTX, canManageHr: () => CTX.isHr },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async () => {}, notifyMany: async () => {} },
});

const { default: pair } = await import(atRoot("api/devices/pair.js"));
const { default: enroll } = await import(atRoot("api/devices/enroll.js"));
const { default: me } = await import(atRoot("api/devices/me.js"));
const { sha256 } = await import(atRoot("lib/devices.js"));

// ---- 偽の req/res -----------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (fn, req) => { const r = res(); await fn(req, r); return r; };

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36";
const postTo = (url, body) => ({ method: "POST", url, body,
  headers: { authorization: "Bearer x", "user-agent": UA } });
const getTo = (url) => ({ method: "GET", url,
  headers: { authorization: "Bearer x", "user-agent": UA } });

let pass = 0, fail = 0;
const step = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

// EXE が作る札。32バイトの乱数を base64url にしたもの
const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo";
const DEVICE_UID = "AGENT-UID-0123456789";
const BROWSER_UID = "BROWSERUID0123456789";

db.rows = {
  gw_employees: [{ id: "emp-1", tenant_id: "t1", display_name: "山田 太郎",
                   status: "active", department: "営業" }],
  gw_device_policies: [{ tenant_id: "t1", work_start: "09:00", work_end: "18:00" }],
};

console.log("\n=== EXE を実行してから、台帳に出るまで ===\n");

// ---- ① EXE が札を預ける（認証なし）------------------------------------------
await step("① EXE がこのPCの札を預ける", async () => {
  const r = await call(pair, postTo("/api/devices/pair", {
    token: TOKEN, hostname: "8GRP-PC-01", os: "Windows 11 Pro",
    browsers: [{ browser: "chrome", installed: true }],
  }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  const row = db.rows.gw_device_pairings?.[0];
  assert.ok(row, "札の行ができている");
  assert.equal(row.hostname, "8GRP-PC-01");
  // 札そのものは保存しない。ハッシュだけ
  assert.equal(row.token_hash, sha256(TOKEN));
  assert.ok(!Object.values(row).includes(TOKEN), "札の生値を持たない");
});

// ---- ② 本人が画面で中身を見る ------------------------------------------------
await step("② 本人がブラウザで、何を登録するのか見る", async () => {
  const r = await call(pair, getTo(`/api/devices/pair?token=${TOKEN}`));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.pc?.hostname, "8GRP-PC-01");
});

// ---- ③ まだ押していない -------------------------------------------------------
await step("③ 押す前は、インストーラは空振りする", async () => {
  const r = await call(pair, getTo(`/api/devices/pair?token=${TOKEN}&code=1`));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ready, false);
  assert.ok(!r.body.enrollToken, "コードは出さない");
});

// ---- ④ 本人が押す -------------------------------------------------------------
await step("④ 本人が「このパソコンです」を押す", async () => {
  const r = await call(pair, postTo("/api/devices/pair", {
    token: TOKEN, claim: true, deviceUid: BROWSER_UID,
  }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const p = db.rows.gw_device_pairings[0];
  assert.ok(p.used_at, "使い切った印が付く");
  assert.ok(p.code_once, "登録コードが入る");
  assert.ok(p.enrollment_id, "どの登録に結びつくかが入る");
  assert.ok(db.rows.gw_device_enrollments?.length, "登録の行ができる");
});

// ---- ⑤ インストーラが引き取る（ここが止まっていた）-------------------------------
//
// SELECT に enrollment_id が無いと、ここが永久に ready:false になる。
// 画面には「時間内に終わりませんでした」としか出ないので、気づけない
let ENROLL_TOKEN = null;
await step("⑤ インストーラが登録コードを引き取る", async () => {
  const r = await call(pair, getTo(`/api/devices/pair?token=${TOKEN}&code=1`));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ready, true,
    "ready が false のままです。pair.js の SELECT に enrollment_id がありますか");
  assert.ok(r.body.enrollToken, "登録コードが返る");
  ENROLL_TOKEN = r.body.enrollToken;
});

// ---- ⑥ 引き取りは1回だけ --------------------------------------------------------
await step("⑥ 同じ札で2回目は取れない", async () => {
  const r = await call(pair, getTo(`/api/devices/pair?token=${TOKEN}&code=1`));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ready, false, "2回目は空振りする");
});

// ---- ⑦ エージェントが登録する ----------------------------------------------------
let DEVICE = null;
await step("⑦ エージェントが登録する", async () => {
  const r = await call(enroll, postTo("/api/devices/enroll", {
    enrollToken: ENROLL_TOKEN, deviceUid: DEVICE_UID,
    hostname: "8GRP-PC-01", os: "Windows 11 Pro", agentVersion: "0.3.1",
  }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.deviceId, "端末の id が返る");
  assert.ok(r.body.secret, "端末だけの合言葉が返る");
  assert.ok(r.body.linkUrl, "本人に見せる画面のURLが返る");
  DEVICE = r.body;

  const d = (db.rows.gw_devices || []).find((x) => x.device_uid === DEVICE_UID);
  assert.ok(d, "台帳に行ができる");
  assert.equal(d.employee_id, "emp-1", "押した本人のものになる");
  assert.equal(d.source, "agent");
  // 社員のアカウントはPCに置かない。端末だけの合言葉をハッシュで持つ
  assert.ok(d.secret_hash, "合言葉はハッシュで持つ");
  assert.ok(!Object.values(d).includes(r.body.secret), "合言葉の生値を持たない");
});

await step("⑦-2 同じ登録コードで2台目は作れない", async () => {
  const r = await call(enroll, postTo("/api/devices/enroll", {
    enrollToken: ENROLL_TOKEN, deviceUid: "ANOTHER-PC-UID-9999",
    hostname: "8GRP-PC-02", os: "Windows 11 Pro", agentVersion: "0.3.1",
  }));
  assert.equal(r.statusCode, 400, "使い切ったコードは通らない");
});

// ---- ⑧ 本人の画面に出る ----------------------------------------------------------
await step("⑧ マイページにそのPCが出る", async () => {
  const r = await call(me, getTo("/api/devices/me"));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const list = r.body.devices || [];
  const mine = list.find((d) => d.id === DEVICE.deviceId);
  assert.ok(mine, `台帳に出る（出たのは ${list.length} 件）`);
});

// ---- 再発防止：列の取り忘れを、その場で見つける -----------------------------------
console.log("\n=== 取り忘れたら落ちるか（わざと壊して確かめる）===\n");

await step("enrollment_id を取らなければ、⑤ が落ちる", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(atRoot("api/devices/pair.js"), "utf8");
  // read() の SELECT に enrollment_id が入っていること。
  // ここが無いまま配ると、実機で「時間内に終わりませんでした」になる
  const sel = src.match(/\.select\("id, kind, tenant_id, employee_id[\s\S]{0,200}?"\)/);
  assert.ok(sel, "read() の SELECT が見つからない");
  assert.ok(/enrollment_id/.test(sel[0]),
    "read() の SELECT に enrollment_id がありません（これが無いと ready:false のままになります）");
});


// ---- 止まったときに、どこで止まったか言えるか -------------------------------------
//
// 前は「ソフトが起動していない可能性があります」としか出せなかった。
// 実際にはソフトは動いていて、詰まっていたのはサーバ側だった。
// そう書いてあると、PC側ばかり疑うことになる
console.log("\n=== どこで止まったか言えるか ===\n");

const diagOf = async (over) => {
  db.rows.gw_device_pairings = [{
    id: "p-d", token_hash: sha256("D".repeat(40)), kind: "installer",
    tenant_id: "t1", employee_id: "emp-1", hostname: "8GRP-PC-09", os: "Windows 11",
    browsers: [], expires_at: new Date(Date.now() + 600000).toISOString(),
    used_at: null, code_once: null, enrollment_id: null, last_poll_at: null, ...over,
  }];
  const r = await call(pair, getTo(`/api/devices/pair?token=${"D".repeat(40)}&diag=1`));
  return r.body;
};

await step("まだ押していない", async () => {
  const d = await diagOf({});
  assert.equal(d.stage, "not_claimed");
});

await step("押したが、ソフトが取りに来ていない → PC側", async () => {
  const d = await diagOf({ used_at: "2026-09-14T00:00:00Z", code_once: "AAAA", last_poll_at: null });
  assert.equal(d.stage, "installer_silent");
  assert.equal(d.installerSeen, false);
  assert.ok(/EIGHT-Agent-Setup\.exe/.test(d.message), "本人には、やり直しを伝える");
});

// 実機で詰まったのは、ここ。
// ソフトは3秒おきに来ていたのに、コードが渡っていなかった
await step("取りに来ているのに渡っていない → サーバ側", async () => {
  const d = await diagOf({
    used_at: "2026-09-14T00:00:00Z", code_once: "AAAA",
    last_poll_at: "2026-09-14T00:01:00Z",
  });
  assert.equal(d.stage, "code_not_handed");
  assert.equal(d.installerSeen, true, "取りに来ていることが分かる");
  assert.ok(/サーバ側/.test(d.adminHint), "サーバ側だと書いてある");
  assert.ok(/enrollment_id/.test(d.adminHint), "どこを見ればよいか書いてある");
  // 本人に「ソフトが動いていない」と言わない。動いているのだから
  assert.ok(!/起動していない/.test(d.message), "PC を疑わせない");
});

await step("コードは渡ったが、登録が終わっていない → 経路", async () => {
  db.rows.gw_device_enrollments = [{ id: "e-9", used_at: null }];
  const d = await diagOf({
    used_at: "2026-09-14T00:00:00Z", code_once: null,
    enrollment_id: "e-9", last_poll_at: "2026-09-14T00:01:00Z",
  });
  assert.equal(d.stage, "enroll_failed");
  assert.ok(/プロキシ|ファイアウォール/.test(d.adminHint), "経路を疑う先が書いてある");
});

await step("登録は終わっている", async () => {
  db.rows.gw_device_enrollments = [{ id: "e-8", used_at: "2026-09-14T00:02:00Z" }];
  const d = await diagOf({
    used_at: "2026-09-14T00:00:00Z", code_once: null,
    enrollment_id: "e-8", last_poll_at: "2026-09-14T00:01:00Z",
  });
  assert.equal(d.stage, "enrolled_not_shown");
});

// 取りに来たことを残していないと、上の2つを見分けられない
await step("取りに来たら、その時刻を残す", async () => {
  db.rows.gw_device_pairings = [{
    id: "p-p", token_hash: sha256("P".repeat(40)), kind: "installer",
    expires_at: new Date(Date.now() + 600000).toISOString(),
    used_at: null, code_once: null, enrollment_id: null, last_poll_at: null,
  }];
  await call(pair, getTo(`/api/devices/pair?token=${"P".repeat(40)}&code=1`));
  assert.ok(db.rows.gw_device_pairings[0].last_poll_at, "last_poll_at が入る");
});


// 063 をまだ流していない環境で、設定そのものが止まらないこと。
// 無い列を SELECT すると、そのリクエストごと落ちる
await step("063 が未適用でも、引き取りは通る", async () => {
  NOCOL = true;
  db.rows.gw_device_pairings = [{
    id: "p-n", token_hash: sha256("N".repeat(40)), kind: "installer",
    tenant_id: "t1", employee_id: "emp-1",
    expires_at: new Date(Date.now() + 600000).toISOString(),
    used_at: "2026-09-14T00:00:00Z", code_once: "ZZZZ", enrollment_id: "e-1",
  }];
  const r = await call(pair, getTo(`/api/devices/pair?token=${"N".repeat(40)}&code=1`));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ready, true, "列が無くても、コードは渡る");
  NOCOL = false;
});

await step("063 が未適用なら、分からないと言う", async () => {
  NOCOL = true;
  db.rows.gw_device_pairings = [{
    id: "p-n2", token_hash: sha256("M".repeat(40)), kind: "installer",
    tenant_id: "t1", employee_id: "emp-1",
    expires_at: new Date(Date.now() + 600000).toISOString(),
    used_at: "2026-09-14T00:00:00Z", code_once: "ZZZZ", enrollment_id: null,
  }];
  const r = await call(pair, getTo(`/api/devices/pair?token=${"M".repeat(40)}&diag=1`));
  assert.equal(r.body.stage, "code_waiting");
  assert.ok(/063/.test(r.body.adminHint), "何を流せばよいか書いてある");
  NOCOL = false;
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) { console.log(`${fail} 件 NG`); process.exit(1); }
