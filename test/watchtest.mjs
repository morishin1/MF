// 社員ごとの見え方と、「要確認」の判定。
//
// ■ 何を守るテストか
//
//   1. 見る単位が人であること（端末が2行並ばない）
//   2. 正常な人が「要確認」に入らないこと
//      ここが緩いと、毎日 △ が並んで、誰も見なくなる
//   3. 決めた5つが、ちゃんと拾えること
//        ・勤務時間中に長時間無操作
//        ・業務外カテゴリのWEB利用が続いている
//        ・ブラウザ拡張が未接続
//        ・未登録PCからグループウェアへアクセス
//        ・勤怠とWeb利用時間の大きな乖離
//   4. 判定の数字を、外に出さないこと
//      「何分から」を返すと、避け方を配ることになる
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase ---------------------------------------------------------
const db = { rows: {} };
function table(name) {
  const f = [];
  const wrap = (v) => Promise.resolve(v);
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    in(k, v) { f.push([k, v]); return q; },
    is() { return q; }, not() { return q; },
    gte() { return q; }, lte() { return q; }, lt() { return q; },
    order() { return q; },
    limit(n) { q._limit = n; return q; },
    maybeSingle() { return wrap({ data: match(name, f)[0] || null, error: null }); },
    single() { return wrap({ data: match(name, f)[0] || null, error: null }); },
    then(fn) {
      let out = match(name, f);
      if (q._limit) out = out.slice(0, q._limit);
      return wrap({ data: out, error: null, count: out.length }).then(fn);
    },
  };
  return q;
}
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) =>
  (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-admin" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ({ tenantId: "t1", isAdmin: true, isHr: true, roles: ["owner"],
                              employee: { id: "emp-admin", display_name: "事務" } }),
    canManageHr: () => true,
    canWipeDevice: () => true,
  },
});

const { default: people } = await import(atRoot("api/devices/people.js"));
const W = await import(atRoot("lib/watch.js"));
const { jstDate } = await import(atRoot("lib/devices.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const get = async (qs = "") => {
  const r = res();
  await people({ method: "GET", url: `/api/devices/people${qs}`,
                 headers: { authorization: "Bearer x" } }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const TODAY = jstDate();
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

/**
 * ふつうに働いている人ひとり。
 * ここから1つずつ崩して、要確認に入るかを見る
 */
function setup(over = {}) {
  db.rows = {
    gw_employees: [{ id: "emp-1", tenant_id: "t1", display_name: "山田 太郎",
                     department: "営業", position: null, status: "active" }],
    gw_devices: [{
      id: "dev-1", tenant_id: "t1", employee_id: "emp-1", source: "browser",
      label: "Windows 11 の Chrome", hostname: null, browser: "Chrome",
      status: "active", notified_at: "2026-09-01T00:00:00Z",
      ownership: "company", last_seen_at: ago(2),
      secret_hash: "x", linked_device_id: null,
      ...(over.device || {}),
    }],
    gw_device_browsers: [{
      tenant_id: "t1", device_id: "dev-1", browser: "chrome",
      installed: true, linked: true, ext_version: "2.0.0", last_seen_at: ago(2),
      ...(over.browser || {}),
    }],
    gw_time_entries: [{
      tenant_id: "t1", employee_id: "emp-1", work_date: TODAY,
      status: "open", clock_in: ago(240), clock_out: null, breaks: [],
      ...(over.clock || {}),
    }],
    gw_device_web_visits: over.visits || [
      { tenant_id: "t1", employee_id: "emp-1", device_id: "dev-1", work_date: TODAY,
        category: "work", active_sec: 3600 * 3, in_work_hours: true, started_at: ago(10) },
    ],
  };
  if (over.noDevice) { db.rows.gw_devices = []; db.rows.gw_device_browsers = []; }
  if (over.noClock) db.rows.gw_time_entries = [];
}

const one = async () => {
  const r = await get();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  return (r.body.people[0] || r.body.check[0]);
};
const keys = async () => (await one()).issues.map((i) => i.key);

console.log("\n=== 社員ごとの見え方と、要確認 ===\n");

// ---------------------------------------------------------------------------
console.log("— 1行＝1人 —");

await ok("同じ人の端末が2つあっても、1行", async () => {
  setup();
  db.rows.gw_devices.push({
    id: "dev-2", tenant_id: "t1", employee_id: "emp-1", source: "agent",
    label: "USER-PC", hostname: "USER-PC", browser: null,
    status: "active", notified_at: "2026-09-01T00:00:00Z",
    ownership: "company", last_seen_at: ago(3), secret_hash: "y", linked_device_id: null,
  });
  const r = await get();
  assert.equal(r.body.people.length + r.body.check.length, 1, "行が増えています");
  assert.equal((r.body.people[0] || r.body.check[0]).devices.length, 2,
    "端末は行の中にまとめる");
});

await ok("一覧に出るのは、決めた5つ", async () => {
  setup();
  const p = await one();
  for (const k of ["work", "ext", "lastSeen", "web", "mark"]) {
    assert.ok(p[k] !== undefined, `${k} がありません`);
  }
  assert.equal(p.work.label, "操作中");
  assert.equal(p.ext.mark, "○");
  assert.equal(p.web.label, "3:00");
});

// ---------------------------------------------------------------------------
console.log("\n— ふつうに働いている人は、要確認に入らない —");

await ok("何も出ない", async () => {
  setup();
  const r = await get();
  assert.equal(r.body.check.length, 0,
    `要確認に入っています: ${JSON.stringify(r.body.check[0]?.issues)}`);
  assert.equal(r.body.people.length, 1);
  assert.equal(r.body.people[0].mark.m, "○");
});

await ok("勤務時間外は、静かでも要確認にしない", async () => {
  setup({ noClock: true, device: { last_seen_at: ago(600) } });
  const k = await keys();
  assert.ok(!k.includes("no_activity"), `${k.join(",")}`);
});

await ok("昼休みの動画は数えない（勤務時間の外）", async () => {
  setup({ visits: [
    { tenant_id: "t1", employee_id: "emp-1", device_id: "dev-1", work_date: TODAY,
      category: "video", active_sec: 3600 * 3, in_work_hours: false, started_at: ago(60) },
  ] });
  const k = await keys();
  assert.ok(!k.includes("off_topic"),
    "勤務時間外のぶんまで数えると、ただの私生活の記録になります");
});

// ---------------------------------------------------------------------------
console.log("\n— 決めた5つ —");

await ok("① 勤務時間中に長時間無操作", async () => {
  setup({ device: { last_seen_at: ago(180) }, visits: [] });
  const k = await keys();
  assert.ok(k.includes("no_activity"), k.join(","));
  const p = await one();
  const i = p.issues.find((x) => x.key === "no_activity");
  assert.ok(i.next, "次にどうするかが書いていません");
});

await ok("② 業務外カテゴリのWEB利用が続いている", async () => {
  setup({ visits: [
    { tenant_id: "t1", employee_id: "emp-1", device_id: "dev-1", work_date: TODAY,
      category: "sns", active_sec: 3600 * 2, in_work_hours: true, started_at: ago(30) },
  ] });
  const k = await keys();
  assert.ok(k.includes("off_topic"), k.join(","));
});

await ok("③ ブラウザ拡張が未接続", async () => {
  setup({ browser: { linked: false } });
  const k = await keys();
  assert.ok(k.includes("ext_off"), k.join(","));
  const p = await one();
  assert.equal(p.ext.mark, "△");
});

await ok("③ 資格情報が無ければ、つながっていない", async () => {
  // 拡張を消したあと、gw_device_browsers の行だけ残ることがある。
  // 片方だけ見ていると「つながっている」と誤って出る
  setup({ device: { secret_hash: null } });
  const k = await keys();
  assert.ok(k.includes("ext_off"), k.join(","));
});

await ok("④ 未登録PCからグループウェアへアクセス", async () => {
  setup({ device: { notified_at: null, ownership: "unknown" } });
  const k = await keys();
  assert.ok(k.includes("unknown_pc"), k.join(","));
  const p = await one();
  assert.equal(p.mark.m, "×", "未登録PCは、いちばん強く出す");
});

await ok("⑤ 勤怠とWeb利用時間の大きな乖離", async () => {
  // 8時間打刻して、動いていたのが30分
  setup({
    clock: { clock_in: ago(480) },
    visits: [{ tenant_id: "t1", employee_id: "emp-1", device_id: "dev-1", work_date: TODAY,
               category: "work", active_sec: 1800, in_work_hours: true, started_at: ago(5) }],
  });
  const k = await keys();
  assert.ok(k.includes("gap"), k.join(","));
});

await ok("⑤ 休憩は引いてから比べる", async () => {
  // 休憩を引かないと、全員が「打刻より短い」に見える
  setup({
    clock: { clock_in: ago(260), breaks: [{ start: ago(200), end: ago(140) }] },
    visits: [{ tenant_id: "t1", employee_id: "emp-1", device_id: "dev-1", work_date: TODAY,
               category: "work", active_sec: 3600 * 3, in_work_hours: true, started_at: ago(5) }],
  });
  const p = await one();
  assert.ok(p.clockMin < 240, `休憩が引かれていません（${p.clockMin}分）`);
});

// ---------------------------------------------------------------------------
console.log("\n— 判定のしかたは外に出さない —");

await ok("要確認の文に、数字を書かない", async () => {
  setup({ device: { last_seen_at: ago(180) }, visits: [] });
  const p = await one();
  for (const i of p.issues) {
    assert.ok(!/\d+\s*分|\d+\s*時間|\d+%/.test(i.what),
      `しきい値が漏れています: ${i.what}`);
  }
});

await ok("しきい値は lib/watch.js にだけ置く", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  // 画面に数字を直接書くと、一覧と詳細で違う、が起きる
  for (const f of readdirSync(ROOT).filter((x) => x.endsWith(".html"))) {
    const src = readFileSync(_join(ROOT, f), "utf8");
    assert.ok(!/noActivityMin|offTopicMin\s*[:=]\s*\d/.test(src),
      `${f} にしきい値が書いてあります`);
  }
});

// ---------------------------------------------------------------------------
console.log("\n— しばらく何も届いていない —");

await ok("1日以上あいたら、未通信として出す", async () => {
  setup({ noClock: true, device: { last_seen_at: ago(60 * 30) }, visits: [] });
  const k = await keys();
  assert.ok(k.includes("silent"), k.join(","));
  const p = await one();
  assert.equal(p.mark.m, "×");
});

await ok("端末が1台も無い人は、未通信にしない", async () => {
  // 入社前・拡張をこれから入れる人。まだ何も起きていないだけ
  setup({ noDevice: true, noClock: true, visits: [] });
  const k = await keys();
  assert.ok(!k.includes("silent"), k.join(","));
});

// ---------------------------------------------------------------------------
console.log("\n— まとめ —");

await ok("KPI が出る", async () => {
  setup();
  const r = await get();
  assert.equal(r.body.summary.total, 1);
  assert.equal(r.body.summary.working, 1);
  assert.equal(r.body.summary.check, 0);
  assert.equal(r.body.summary.extOff, 0);
});

await ok("EXE が1台も無くても、ちゃんと出る", async () => {
  setup();
  assert.ok(!db.rows.gw_devices.some((d) => d.source === "agent"));
  const p = await one();
  assert.equal(p.work.label, "操作中");
  assert.equal(p.web.label, "3:00");
  assert.equal(p.mark.m, "○");
});

// ---------------------------------------------------------------------------
console.log("\n— 登録したら、本人は外せない —");
//
//   台帳から外せるのは管理者だけ、と API で決めてある。
//   ただしブラウザから拡張を消すことまでは止められない。
//   止められないなら、せめて **黙って消えないようにする**

await ok("拡張を外したら、そう出る", async () => {
  // グループウェアは使っている（合図は来ている）のに、拡張からだけ届かない
  setup({
    device: { installed_at: "2026-09-01T00:00:00Z", last_seen_at: ago(2) },
    browser: { last_seen_at: ago(180) },
  });
  const k = await keys();
  assert.ok(k.includes("ext_removed"), k.join(","));
  const p = await one();
  assert.equal(p.ext.key, "removed");
  assert.equal(p.ext.mark, "×");
  assert.equal(p.mark.m, "×", "「未接続」より重く出す");
});

await ok("外したことを、本人の言い分で消せない", async () => {
  setup({
    device: { installed_at: "2026-09-01T00:00:00Z", last_seen_at: ago(2) },
    browser: { last_seen_at: ago(180) },
  });
  const p = await one();
  const i = p.issues.find((x) => x.key === "ext_removed");
  assert.ok(/管理者しかできません/.test(i.next), `文: ${i.next}`);
});

await ok("ブラウザを閉じているだけなら、外れたとは言わない", async () => {
  // 合図も拡張も、同じように止まっている。帰宅・休みはこれ
  setup({
    device: { installed_at: "2026-09-01T00:00:00Z", last_seen_at: ago(300) },
    browser: { last_seen_at: ago(300) },
    noClock: true, visits: [],
  });
  const k = await keys();
  assert.ok(!k.includes("ext_removed"), `閉じているだけで疑っています: ${k.join(",")}`);
});

await ok("まだ一度も登録していない人は、外れたとは言わない", async () => {
  setup({
    device: { installed_at: null, secret_hash: null, last_seen_at: ago(2) },
    browser: { linked: false, last_seen_at: null },
  });
  const k = await keys();
  assert.ok(!k.includes("ext_removed"), k.join(","));
  assert.ok(k.includes("ext_off"), "まだ入れていない、は別に出す");
});

await ok("外れている人の数を、まとめにも出す", async () => {
  setup({
    device: { installed_at: "2026-09-01T00:00:00Z", last_seen_at: ago(2) },
    browser: { last_seen_at: ago(180) },
  });
  const r = await get();
  assert.equal(r.body.summary.extRemoved, 1);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) { console.log(`${fail} 件 NG`); process.exit(1); }
