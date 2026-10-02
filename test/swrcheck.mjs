// 画面データの短期キャッシュ（js/api-client.js の API.swr / API.warm）の約束。
//
// ■ 何を守りたいのか（表示速度の要件 §6〜9・§31・§40）
//   ・キャッシュなし … いつもどおり取って描く（1回）
//   ・キャッシュあり … 前回の内容をすぐ描き、裏で取り直す。中身が同じなら描き直さない。違えば、もう一度描く
//   ・期限切れ     … 覚えていないのと同じ（取って描く）
//   ・別のユーザー … 前の人のぶんは使わない（鍵に誰のものかが入っている）
//   ・ログアウト後 … 覚えている画面データ・身元を全部消す
//   ・更新のあと   … GET 以外が終わったら全部捨てる。更新の前に取りにいっていたものを、あとから覚え直さない
//   ・API が失敗   … 前回の内容があれば消さない。無ければ、いつもどおり失敗を返す
//   ・先に取りにいく（warm）のは、覚えている身元で入れる人のときだけ
//
// ブラウザは使わない。js/api-client.js を、偽の fetch・localStorage・sessionStorage の上で動かす
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(join(ROOT, "js/api-client.js"), "utf8");

let failed = 0;
let n = 0;
async function ok(name, fn) {
  n++;
  try { await fn(); console.log(`  ok ${name}`); }
  catch (e) { failed++; console.log(`NG ${name}\n   ${e.message}`); }
}

class Store {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  keys() { return [...this.m.keys()]; }
}

const jwt = (sub) => `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * api-client.js を1つ立ち上げる。
 * routes: { "GET /api/x": () => body | Promise<body> | throws }
 */
function boot({ user = "u1", email = "a@8grp.co.jp", routes = {}, local, session } = {}) {
  const localStorage = local || new Store();
  const sessionStorage = session || new Store();
  localStorage.setItem("kp_session", JSON.stringify({
    access_token: jwt(user), email, expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  const calls = [];
  const fetch = async (url, opt = {}) => {
    const key = `${opt.method || "GET"} ${String(url).split("?")[0]}`;
    calls.push({ key, url: String(url) });
    const h = routes[key];
    if (!h) return { ok: true, status: 200, json: async () => ({}) };
    try {
      const body = await h(url, opt);
      return { ok: true, status: 200, json: async () => body };
    } catch (e) {
      return { ok: false, status: e.status || 500, json: async () => ({ error: "db_query_failed", message: e.message }) };
    }
  };
  const sandbox = { window: {}, localStorage, sessionStorage, location: { href: "", pathname: "/", search: "" },
    fetch, console, setTimeout, clearTimeout, atob: (s) => Buffer.from(s, "base64").toString("binary"),
    navigator: {}, performance: { mark() {}, getEntriesByName: () => [] } };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "js/api-client.js" });
  return { API: sandbox.window.API, calls, localStorage, sessionStorage, sandbox };
}
const swrKeys = (s) => s.keys().filter((k) => k.startsWith("kp_swr:"));
// 画面の取りにいく関数（例：応募者一覧）
const listOf = (API) => () => API.api("/api/hr/applicants");

console.log("\n— キャッシュなし・あり・期限切れ —");

await ok("キャッシュなし：取って描く（1回）。描いたものを覚える", async () => {
  const { API, calls, sessionStorage } = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [{ id: "a1" }] }) } });
  const seen = [];
  const r = await API.swr("hr:applicants", listOf(API), (d, m) => seen.push([d.applicants.length, m.cached]));
  assert.deepEqual(seen, [[1, false]]);
  assert.equal(r.applicants[0].id, "a1");
  assert.equal(calls.length, 1);
  assert.equal(swrKeys(sessionStorage).length, 1, "sessionStorage に覚える");
  assert.match(swrKeys(sessionStorage)[0], /^kp_swr:u1:hr:applicants$/, "鍵に誰のものか（ユーザーID）が入る");
});

await ok("キャッシュあり：前回の内容をすぐ描き、裏で取り直す。中身が同じなら描き直さない", async () => {
  let release;
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [{ id: "a1" }] }) } });
  await env.API.swr("hr:applicants", listOf(env.API), () => {});
  // 2回目：API を待たせる
  const slow = boot({ local: env.localStorage, session: env.sessionStorage, routes: {
    "GET /api/hr/applicants": () => new Promise((r) => { release = () => r({ applicants: [{ id: "a1" }] }); }) } });
  const seen = [];
  await slow.API.swr("hr:applicants", listOf(slow.API), (d, m) => seen.push(m.cached));
  assert.deepEqual(seen, [true], "API の返事を待たずに、前回の内容で描く");
  assert.equal(slow.calls.length, 1, "裏では取り直している");
  release();
  await tick(); await tick();
  assert.deepEqual(seen, [true], "中身が同じなら、描き直さない（点滅させない）");
});

await ok("キャッシュあり：裏で取り直した中身が違えば、もう一度描く（updated）", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [{ id: "a1" }] }) } });
  await env.API.swr("hr:applicants", listOf(env.API), () => {});
  const next = boot({ local: env.localStorage, session: env.sessionStorage, routes: {
    "GET /api/hr/applicants": () => ({ applicants: [{ id: "a1" }, { id: "a2" }] }) } });
  const seen = [];
  await next.API.swr("hr:applicants", listOf(next.API), (d, m) => seen.push([d.applicants.length, m.cached, Boolean(m.updated)]));
  await tick(); await tick();
  assert.deepEqual(seen, [[1, true, false], [2, false, true]]);
  // 次に開くときは、新しいほうが出る
  const third = boot({ local: env.localStorage, session: env.sessionStorage, routes: {
    "GET /api/hr/applicants": () => new Promise(() => {}) } });
  const got = [];
  await third.API.swr("hr:applicants", listOf(third.API), (d) => got.push(d.applicants.length));
  assert.deepEqual(got, [2]);
});

await ok("期限切れ：覚えていないのと同じ（待って取る）。既定は120秒", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [] }) } });
  await env.API.swr("hr:applicants", listOf(env.API), () => {});
  const k = swrKeys(env.sessionStorage)[0];
  const body = env.sessionStorage.getItem(k).split("|").slice(1).join("|");
  env.sessionStorage.setItem(k, `${Date.now() - 121000}|${body}`);
  const again = boot({ local: env.localStorage, session: env.sessionStorage, routes: {
    "GET /api/hr/applicants": () => ({ applicants: [{ id: "new" }] }) } });
  const seen = [];
  await again.API.swr("hr:applicants", listOf(again.API), (d, m) => seen.push([d.applicants.length, m.cached]));
  assert.deepEqual(seen, [[1, false]], "古いものは出さない");
  // 119秒前なら使う
  env.sessionStorage.setItem(k, `${Date.now() - 119000}|${body}`);
  const fresh = boot({ local: env.localStorage, session: env.sessionStorage, routes: {
    "GET /api/hr/applicants": () => new Promise(() => {}) } });
  const s2 = [];
  await fresh.API.swr("hr:applicants", listOf(fresh.API), (d, m) => s2.push(m.cached));
  assert.deepEqual(s2, [true]);
});

await ok("fresh：これより新しければ、裏でも取り直さない（通知60秒・バッジ45秒）", async () => {
  const env = boot({ routes: { "GET /api/notifications": () => ({ notifications: [], unread: 0 }) } });
  await env.API.swr("notifications", () => env.API.listNotifications(), () => {}, { ttl: 600, fresh: 60, quiet: true });
  const again = boot({ local: env.localStorage, session: env.sessionStorage, routes: {
    "GET /api/notifications": () => ({ notifications: [], unread: 3 }) } });
  await again.API.swr("notifications", () => again.API.listNotifications(), () => {}, { ttl: 600, fresh: 60, quiet: true });
  assert.equal(again.calls.length, 0, "60秒以内は、通知を取りにいかない");
});

console.log("\n— 人のあいだで混ざらない —");

await ok("別のユーザー：前の人のぶんは使わない（鍵が違う）", async () => {
  const env = boot({ user: "u1", routes: { "GET /api/hr/applicants": () => ({ applicants: [{ id: "secret" }] }) } });
  await env.API.swr("hr:applicants", listOf(env.API), () => {});
  // 同じタブに別の人（u2）が入る（ログアウトせずにセッションが切れた、など）
  const other = boot({ user: "u2", email: "b@8grp.co.jp", local: env.localStorage, session: env.sessionStorage, routes: {
    "GET /api/hr/applicants": () => ({ applicants: [] }) } });
  const seen = [];
  await other.API.swr("hr:applicants", listOf(other.API), (d, m) => seen.push([d.applicants.length, m.cached]));
  assert.deepEqual(seen, [[0, false]], "前の人の応募者を、次の人に出さない");
});

await ok("ログアウト後：覚えている画面データ・身元・メニューの枠を全部消す（誰のものでも）", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [{ id: "a1" }] }) } });
  await env.API.swr("hr:applicants", listOf(env.API), () => {});
  env.sessionStorage.setItem("kp_swr:someone-else:x", "1|{}");
  env.localStorage.setItem("kp_me", JSON.stringify({ at: Date.now(), email: "a@8grp.co.jp", me: { email: "a@8grp.co.jp" } }));
  env.localStorage.setItem("kp_layout", "{}");
  env.API.logout();
  assert.equal(swrKeys(env.sessionStorage).length, 0);
  assert.equal(env.localStorage.getItem("kp_me"), null);
  assert.equal(env.localStorage.getItem("kp_layout"), null);
  assert.equal(env.localStorage.getItem("kp_session"), null);
});

await ok("ログイン：前にこのタブを使っていた人の画面データを消す", async () => {
  const env = boot({ routes: {
    "GET /api/hr/applicants": () => ({ applicants: [{ id: "a1" }] }),
  } });
  await env.API.swr("hr:applicants", listOf(env.API), () => {});
  env.sandbox.fetch = async (url) => {
    if (/public-config/.test(url)) return { ok: true, status: 200, json: async () => ({ supabaseUrl: "https://x", supabaseAnonKey: "k" }) };
    return { ok: true, status: 200, json: async () => ({ access_token: jwt("u9"), refresh_token: "r", expires_in: 3600 }) };
  };
  // vm の中の fetch を差し替える
  vm.runInContext("fetch = this.fetch", env.sandbox);
  await env.API.login("c@8grp.co.jp", "pw");
  assert.equal(swrKeys(env.sessionStorage).length, 0);
});

console.log("\n— 更新したら捨てる —");

await ok("GET 以外（POST・PATCH・DELETE）が終わったら、覚えている画面データを全部捨てる", async () => {
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [] }), [`${method} /api/hr/applicants`]: () => ({ ok: true }) } });
    await env.API.swr("hr:applicants", listOf(env.API), () => {});
    await env.API.swr("sales:dashboard", () => env.API.api("/api/hr/applicants"), () => {});
    assert.equal(swrKeys(env.sessionStorage).length, 2);
    await env.API.api("/api/hr/applicants", { method, body: {} });
    assert.equal(swrKeys(env.sessionStorage).length, 0, `${method} のあと`);
  }
});

await ok("失敗した更新のあとも捨てる（途中まで書けていることがある）", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [] }),
    "POST /api/hr/applicants": () => { throw Object.assign(new Error("x"), { status: 500 }); } } });
  await env.API.swr("hr:applicants", listOf(env.API), () => {});
  await assert.rejects(env.API.api("/api/hr/applicants", { method: "POST", body: {} }));
  assert.equal(swrKeys(env.sessionStorage).length, 0);
});

await ok("更新の前に取りにいっていたものは、更新のあとに返ってきても覚えない", async () => {
  let release;
  const env = boot({ routes: {
    "GET /api/hr/applicants": () => new Promise((r) => { release = () => r({ applicants: [{ id: "before" }] }); }),
    "PATCH /api/hr/applicants": () => ({ ok: true }) } });
  const p = env.API.swr("hr:applicants", listOf(env.API), () => {});
  await tick();
  await env.API.api("/api/hr/applicants", { method: "PATCH", body: {} });
  release();
  await p;
  assert.equal(swrKeys(env.sessionStorage).length, 0, "更新の前の中身を覚え直さない");
});

await ok("通知の既読・端末の合図は、画面データを捨てない（既読は通知とバッジだけ捨てる）", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [] }), "GET /api/notifications": () => ({ notifications: [] }),
    "GET /api/badges": () => ({ badges: {} }), "PATCH /api/notifications": () => ({ ok: true }), "POST /api/devices/me": () => ({ ok: true }) } });
  await env.API.swr("hr:applicants", listOf(env.API), () => {});
  await env.API.swr("notifications", () => env.API.listNotifications(), () => {});
  await env.API.swr("badges", () => env.API.badges(), () => {});
  await env.API.deviceBeat({ deviceUid: "d" });
  assert.equal(swrKeys(env.sessionStorage).length, 3, "端末の合図では何も捨てない");
  await env.API.markNotificationRead("n1");
  assert.deepEqual(swrKeys(env.sessionStorage).map((k) => k.split(":").pop()), ["applicants"]);
});

console.log("\n— API が失敗したとき —");

await ok("前回の内容があれば消さない。裏の取り直しの失敗は onError に渡す", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [{ id: "a1" }] }) } });
  await env.API.swr("hr:applicants", listOf(env.API), () => {});
  const bad = boot({ local: env.localStorage, session: env.sessionStorage, routes: {
    "GET /api/hr/applicants": () => { throw Object.assign(new Error("down"), { status: 503 }); } } });
  const seen = [];
  let err = null;
  const r = await bad.API.swr("hr:applicants", listOf(bad.API), (d) => seen.push(d.applicants.length), { onError: (e) => { err = e; } });
  await tick(); await tick();
  assert.equal(r.applicants.length, 1);
  assert.deepEqual(seen, [1], "前回の内容は出したまま");
  assert.ok(err, "失敗は onError に渡る");
  assert.equal(swrKeys(bad.sessionStorage).length, 1, "前回の内容は捨てない");
});

await ok("前回の内容が無ければ、いつもどおり失敗を返す（画面は今までのエラー表示）", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => { throw Object.assign(new Error("down"), { status: 503 }); } } });
  await assert.rejects(env.API.swr("hr:applicants", listOf(env.API), () => { throw new Error("描かない"); }));
  assert.equal(swrKeys(env.sessionStorage).length, 0);
});

console.log("\n— 先に取りにいく（warm） —");

await ok("覚えている身元が無ければ、先に取りにいかない（その画面の API を呼ばない）", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [] }) } });
  env.API.warm("hr:applicants", listOf(env.API));
  await tick(); await tick();
  assert.equal(env.calls.length, 0);
});

await ok("覚えている身元で入れない画面なら、先に取りにいかない", async () => {
  const env = boot({ routes: { "GET /api/keiei": () => ({}) } });
  env.localStorage.setItem("kp_me", JSON.stringify({ at: Date.now(), email: "a@8grp.co.jp", me: { access: { keiei: false } } }));
  env.API.warm("keiei:hub", () => env.API.api("/api/keiei?view=hub"), (me) => Boolean(me.access?.keiei));
  await tick(); await tick();
  assert.equal(env.calls.length, 0);
});

await ok("前の人の身元なら、先に取りにいかない（いまの人のものではない）", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [] }) } });
  env.localStorage.setItem("kp_me", JSON.stringify({ at: Date.now(), email: "mae@8grp.co.jp", me: { access: { recruit: true } } }));
  env.API.warm("hr:applicants", listOf(env.API));
  await tick(); await tick();
  assert.equal(env.calls.length, 0);
});

await ok("入れる人なら先に取りにいき、あとの swr はそれを待つ（2本出さない）", async () => {
  const env = boot({ routes: { "GET /api/hr/applicants": () => ({ applicants: [{ id: "a1" }] }) } });
  env.localStorage.setItem("kp_me", JSON.stringify({ at: Date.now(), email: "a@8grp.co.jp", me: { access: { recruit: true } } }));
  env.API.warm("hr:applicants", listOf(env.API), (me) => me.access.recruit);
  await tick(); await tick();
  assert.equal(env.calls.length, 1);
  const seen = [];
  await env.API.swr("hr:applicants", listOf(env.API), (d) => seen.push(d.applicants.length));
  assert.equal(env.calls.length, 1, "同じ鍵は、取りにいっている最中のものを待つ");
  assert.deepEqual(seen, [1]);
});

console.log("\n— 大きすぎるもの —");

await ok("大きすぎる応答は覚えない（sessionStorage の上限に当てない）", async () => {
  const big = { rows: "x".repeat(1600000) };
  const env = boot({ routes: { "GET /api/x": () => big } });
  await env.API.swr("big", () => env.API.api("/api/x"), () => {});
  assert.equal(swrKeys(env.sessionStorage).length, 0);
});

console.log(failed ? `\n${failed} 件 NG（${n} 件中）` : `\n合計 ${n} 件中 ${n} 件 通過`);
process.exit(failed ? 1 : 0);
