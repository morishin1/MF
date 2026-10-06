// 退職者（left）を、サーバー側で止める（A0）。lib/left-gate.js・lib/auth.js・lib/gw.js・api/me.js
//
// ■ 何を守るテストか
//   1. 退職者の判定（left／退職日を過ぎた leaving）。退職日の当日までは通常どおり
//   2. 権限の行（内部ロール・アプリ利用権限・会計のメンバーシップ）が残っていても、退職者は
//        ・HR・Sales・Office・経営・社員名簿・日報/タスク・契約書などの API を直接呼んでも 403 account_left
//        ・gwContext が「権限なし・テナントなし」を返す
//   3. 在籍中の人（active・退職日前の leaving）は、これまでどおり通る
//   4. /api/me は退職者でも通るが、権限・名簿・メンバーシップは返さない（本人の名前と退職日だけ）
//   5. 在籍状態を確かめられないとき（読み取りの失敗）は通さない（503）。名簿の表が無い環境は、これまでどおり通す
//   6. 退職者を通せる入口（requireUserAllowLeft）を使う API は、決めた数本だけ（ほかが増えたら落ちる）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join, relative } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const ymdOffset = (days) => new Date(Date.now() + 9 * 3600000 + days * 86400000).toISOString().slice(0, 10);
const TODAY = ymdOffset(0), YESTERDAY = ymdOffset(-1), TOMORROW = ymdOffset(1);

const db = { rows: {}, absent: new Set(), broken: new Set() };
let current = { userId: "u-none" };
const ABSENT = { code: "PGRST205", message: "Could not find the table in the schema cache" };
const BROKEN = { code: "XX000", message: "boom" };

function table(name) {
  const f = [];
  const fail = () => (db.absent.has(name) ? ABSENT : db.broken.has(name) ? BROKEN : null);
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => (op === "eq" ? r[k] === v : Array.isArray(v) && v.includes(r[k]))));
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    neq() { return q; }, order() { return q; }, limit() { return q; }, gte() { return q; }, lte() { return q; }, is() { return q; },
    maybeSingle: () => Promise.resolve(fail() ? { data: null, error: fail() } : { data: rows()[0] ? { ...rows()[0] } : null, error: null }),
    single: () => Promise.resolve(fail() ? { data: null, error: fail() } : { data: rows()[0] ? { ...rows()[0] } : null, error: null }),
    then: (fn, rej) => Promise.resolve(fail() ? { data: null, error: fail() } : { data: rows().map((r) => ({ ...r })), error: null }).then(fn, rej),
    insert() { return Promise.resolve({ data: null, error: null }); },
    update() { return q; }, upsert() { return Promise.resolve({ data: null, error: null }); }, delete() { return q; },
  };
  return q;
}
const authOk = () => ({ getUser: async () => (current.userId ? { data: { user: { id: current.userId, email: "x@example.com" } }, error: null } : { data: null, error: { message: "no" } }) });
mock.module(atRoot("lib/supabase.js"), { namedExports: {
  admin: () => ({ from: table, storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "n/a" } }) }) } }),
  userClient: () => ({ from: table, auth: authOk() }),
} });

const { isLeftEmployee, leftSelf } = await import(atRoot("lib/left-gate.js"));
const { requireUser, requireUserAllowLeft, leftStateOf, resetLeftCache } = await import(atRoot("lib/auth.js"));
const { gwContext, accessOf } = await import(atRoot("lib/gw.js"));
const { default: meApi } = await import(atRoot("api/me.js"));

const res = () => { const r = { statusCode: 0, body: null, headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const call = async (h, req = {}) => { const r = res(); await h({ method: "GET", url: "/api/x", headers: { authorization: "Bearer x" }, query: {}, ...req }, r); return r; };

let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); } };

// 登場人物。権限は全員、盛れるだけ盛る（権限の行が残っていても止まることを見る）
const person = (id, status, left_on = null, tenant = "t1") => ({ id: `e-${id}`, tenant_id: tenant, user_id: `u-${id}`, display_name: `名前${id}`, email: `${id}@x`, department: "開発", position: "社員", employment_type: "正社員", joined_on: "2025-04-01", status, left_on });
function setup() {
  resetLeftCache();
  db.absent = new Set(); db.broken = new Set();
  const people = [
    person("active", "active"), person("left", "left", YESTERDAY),
    person("leaving-future", "leaving", TOMORROW), person("leaving-today", "leaving", TODAY),
    person("leaving-past", "leaving", YESTERDAY), person("leaving-nodate", "leaving"),
  ];
  const roles = ["owner", "hr", "manager", "finance", "sales", "recruiter"];
  db.rows = {
    gw_employees: people,
    gw_role_grants: people.flatMap((p) => roles.map((r) => ({ id: `${p.id}-${r}`, tenant_id: "t1", employee_id: p.id, role: r }))),
    gw_app_grants: people.flatMap((p) => ["hr", "sales", "office"].map((k) => ({ tenant_id: "t1", employee_id: p.id, app_key: k }))),
    memberships: people.map((p) => ({ id: `m-${p.id}`, user_id: p.user_id, tenant_id: "t1", role: "staff", client_id: null })),
  };
}
const as = (id) => { current = { userId: `u-${id}` }; };
const gateBody = (r) => r.body?.error;

console.log("[1] 退職者の判定");
await ok("left は退職者", () => assert.equal(isLeftEmployee({ status: "left" }, TODAY), true));
await ok("退職日を過ぎた leaving は退職者（翌日から）", () => assert.equal(isLeftEmployee({ status: "leaving", left_on: YESTERDAY }, TODAY), true));
await ok("退職日の当日の leaving は通常どおり", () => assert.equal(isLeftEmployee({ status: "leaving", left_on: TODAY }, TODAY), false));
await ok("退職日前の leaving は通常どおり", () => assert.equal(isLeftEmployee({ status: "leaving", left_on: TOMORROW }, TODAY), false));
await ok("退職日が無い leaving は通常どおり（勝手に止めない）", () => assert.equal(isLeftEmployee({ status: "leaving", left_on: null }, TODAY), false));
await ok("active・invited・行なし は退職者ではない", () => {
  assert.equal(isLeftEmployee({ status: "active", left_on: YESTERDAY }, TODAY), false);
  assert.equal(isLeftEmployee({ status: "invited" }, TODAY), false);
  assert.equal(isLeftEmployee(null, TODAY), false);
});
await ok("退職日が日時の形（2026-10-01T00:00:00）でも判定できる", () => assert.equal(isLeftEmployee({ status: "leaving", left_on: `${YESTERDAY}T00:00:00` }, TODAY), true));
await ok("退職者に見せる本人の情報は最小（メール・部署・雇用区分を含めない）", () => {
  const s = leftSelf(person("left", "left", YESTERDAY));
  assert.deepEqual(Object.keys(s).sort(), ["display_name", "id", "left_on", "status"]);
});

console.log("[2] requireUser（ほぼ全部の API の入口）");
setup();
await ok("退職者（left）は 403 account_left。権限の行が残っていても", async () => {
  as("left"); const r = res(); const u = await requireUser({ headers: {} }, r);
  assert.equal(u, null); assert.equal(r.statusCode, 403); assert.equal(r.body.error, "account_left");
});
await ok("退職日を過ぎた leaving も 403", async () => { as("leaving-past"); const r = res(); assert.equal(await requireUser({ headers: {} }, r), null); assert.equal(r.statusCode, 403); });
for (const id of ["active", "leaving-future", "leaving-today", "leaving-nodate"]) {
  await ok(`${id} は通る`, async () => { as(id); const r = res(); const u = await requireUser({ headers: {} }, r); assert.equal(u?.id, `u-${id}`); });
}
await ok("名簿に行が無い人（顧問先など）は通る", async () => { as("nobody"); const r = res(); assert.ok(await requireUser({ headers: {} }, r)); });
await ok("名簿の表が無い環境は、これまでどおり通る", async () => {
  resetLeftCache(); db.absent.add("gw_employees"); as("left"); const r = res(); assert.ok(await requireUser({ headers: {} }, r)); db.absent.clear();
});
await ok("在籍状態を読めなかったときは通さない（503）", async () => {
  resetLeftCache(); db.broken.add("gw_employees"); as("active"); const r = res();
  assert.equal(await requireUser({ headers: {} }, r), null); assert.equal(r.statusCode, 503); assert.equal(r.body.error, "status_unavailable"); db.broken.clear();
});
await ok("ログインしていなければ 401（退職者の判定より先）", async () => { current = { userId: null }; const r = res(); assert.equal(await requireUser({ headers: {} }, r), null); assert.equal(r.statusCode, 401); });
await ok("requireUserAllowLeft は退職者も通す（退職者ポータルと /api/me だけが使う）", async () => { as("left"); const r = res(); assert.equal((await requireUserAllowLeft({ headers: {} }, r))?.id, "u-left"); });
await ok("判定は短い間だけ覚える（在籍→退職にしても、覚えている間は前のまま。リセットすれば反映）", async () => {
  setup(); as("active"); assert.equal((await leftStateOf("u-active")).left, false);
  db.rows.gw_employees.find((p) => p.id === "e-active").status = "left";
  assert.equal((await leftStateOf("u-active")).left, false);
  resetLeftCache(); assert.equal((await leftStateOf("u-active")).left, true);
});

console.log("[3] gwContext（権限の判定の土台）");
setup();
await ok("退職者は、権限の行が残っていても、権限なし・テナントなし", async () => {
  const c = await gwContext("u-left");
  assert.equal(c.left, true); assert.equal(c.tenantId, null); assert.equal(c.isAdmin, false); assert.equal(c.isHr, false);
  assert.deepEqual(c.roles, []); assert.deepEqual(c.apps, []); assert.deepEqual(c.memberships, []); assert.equal(c.employee, null);
  const a = accessOf({ isAdmin: c.isAdmin, isHr: c.isHr, roles: c.roles, apps: c.apps });
  for (const [k, v] of Object.entries(a)) assert.ok(v === false || v === undefined || v === null || (typeof v === "object"), `access.${k} は開かない（${v}）`);
  assert.equal(a.recruit, false); assert.equal(a.sell, false); assert.equal(a.office, false); assert.equal(a.keiei, false);
});
await ok("退職者の leftEmployee は最小の情報だけ", async () => {
  const c = await gwContext("u-left");
  assert.deepEqual(Object.keys(c.leftEmployee).sort(), ["display_name", "id", "left_on", "status", "tenant_id"]);
});
await ok("退職日を過ぎた leaving も退職者", async () => { assert.equal((await gwContext("u-leaving-past")).left, true); });
await ok("active の owner は、これまでどおり権限あり", async () => {
  const c = await gwContext("u-active");
  assert.equal(c.left, undefined); assert.equal(c.tenantId, "t1"); assert.ok(c.roles.includes("owner")); assert.equal(c.isAdmin, true);
});
await ok("退職日前の leaving は、これまでどおり権限あり", async () => {
  const c = await gwContext("u-leaving-future"); assert.equal(c.tenantId, "t1"); assert.ok(c.roles.includes("hr"));
});

console.log("[4] 退職者が API を直接呼んでも、通常業務のデータを取れない");
// 本物のハンドラを、本物の lib/auth.js ごと呼ぶ。権限は全部盛り（owner・hr・manager・finance・sales・recruiter・会計の管理者）
const TARGETS = [
  ["HR 一覧", "api/hr/index.js"], ["HR 応募者", "api/hr/applicants/index.js"], ["HR CEO REVIEW", "api/hr/ceo-review.js"],
  ["Sales 企業", "api/sales/companies/index.js"], ["Sales 案件", "api/sales/deals/index.js"],
  ["Office 月次", "api/office/index.js"], ["Office 契約条件", "api/office/terms.js"], ["Office 請求", "api/office/payables.js"],
  ["経営", "api/keiei/index.js"], ["経営 給与", "api/keiei/pay.js"], ["経営 入社準備", "api/keiei/onboarding.js"],
  ["社員名簿", "api/employees/index.js"], ["権限変更", "api/employees/roles.js"], ["4ボタン", "api/employees/apps.js"],
  ["契約書（本人）", "api/sign/me.js"], ["契約書の取得", "api/sign/file.js"], ["雛形", "api/sign/templates.js"], ["印鑑", "api/sign/seals.js"],
  ["タスク", "api/tasks/index.js"], ["日報", "api/nippo/index.js"], ["お知らせ", "api/notices/index.js"], ["社内文書", "api/library/index.js"],
  ["会計 書類", "api/documents/index.js"], ["キャリア", "api/career/index.js"],
];
setup();
// ハンドラによっては、メソッドの確認が認証より先（405）。405 は何も返していないので問題ない。
// 受け付けるメソッドでは、必ず 403 account_left で止まること
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];
async function sweep(file, who) {
  const mod = await import(atRoot(file));
  as(who);
  const out = [];
  for (const m of METHODS) {
    const r = await call(mod.default, { method: m, url: "/api/x", body: {} });
    out.push({ m, status: r.statusCode, error: gateBody(r) });
  }
  return out;
}
for (const [label, file] of TARGETS) {
  for (const who of ["left", "leaving-past"]) {
    await ok(`${who === "left" ? "退職者" : "退職日を過ぎた leaving"} は ${label}（${file}）に、どのメソッドでも入れない`, async () => {
      const out = await sweep(file, who);
      const served = out.filter((o) => o.status !== 405);
      assert.ok(served.length > 0, "どのメソッドも 405（受け付けるメソッドが無い）");
      for (const o of served) {
        assert.equal(o.status, 403, `${o.m}: status=${o.status} error=${o.error}`);
        assert.equal(o.error, "account_left", `${o.m}: error=${o.error}`);
      }
    });
  }
}
await ok("対照：active の人は、入口（account_left）では止まらない", async () => {
  const mod = await import(atRoot("api/employees/index.js"));
  as("active");
  const r = await call(mod.default, { method: "GET", url: "/api/employees" });
  assert.notEqual(gateBody(r), "account_left");
});
await ok("対照：退職日前の leaving も、入口では止まらない", async () => {
  const mod = await import(atRoot("api/hr/index.js"));
  as("leaving-future");
  const r = await call(mod.default, { method: "GET", url: "/api/hr" });
  assert.notEqual(gateBody(r), "account_left");
});

console.log("[5] /api/me");
await ok("退職者でも /api/me は通る。ただし権限・名簿・メンバーシップは返さない", async () => {
  setup(); as("left");
  const r = await call(meApi, { method: "GET", url: "/api/me" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.isAdmin, false); assert.deepEqual(r.body.roles, []); assert.deepEqual(r.body.memberships, []);
  assert.equal(r.body.appRole, "member");
  assert.equal(r.body.gw.left, true); assert.equal(r.body.gw.stage.key, "left");
  assert.deepEqual(r.body.gw.roles, []); assert.deepEqual(r.body.gw.apps, []); assert.equal(r.body.gw.isHr, false); assert.equal(r.body.gw.isOwner, false);
  assert.equal(r.body.access.recruit, false); assert.equal(r.body.access.sell, false); assert.equal(r.body.access.office, false); assert.equal(r.body.access.keiei, false);
  assert.deepEqual(Object.keys(r.body.gw.employee).sort(), ["display_name", "id", "left_on", "status"]);
});
await ok("退職日を過ぎた leaving も同じ", async () => {
  as("leaving-past"); const r = await call(meApi, { method: "GET", url: "/api/me" });
  assert.equal(r.statusCode, 200); assert.equal(r.body.gw.left, true); assert.equal(r.body.isAdmin, false);
});
await ok("在籍中の owner は、これまでどおり", async () => {
  as("active"); const r = await call(meApi, { method: "GET", url: "/api/me" });
  assert.equal(r.statusCode, 200); assert.equal(r.body.appRole, "owner"); assert.equal(r.body.access.keiei, true); assert.equal(r.body.gw.left, undefined);
});

console.log("[6] 退職者を通せる入口を使う API は、決めたものだけ");
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = _join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : []; });
await ok("退職者を通せる入口（requireUserAllowLeft）を使うのは、api/me.js と lib/retiree-gate.js だけ", () => {
  const ALLOWED = new Set(["api/me.js", "lib/retiree-gate.js", "lib/auth.js"]);
  const users = [...walk(atRoot("api")), ...walk(atRoot("lib"))].filter((p) => /requireUserAllowLeft/.test(readFileSync(p, "utf8"))).map((p) => relative(ROOT, p));
  for (const u of users) assert.ok(ALLOWED.has(u), `${u} は退職者を通す入口を使っています。退職者向けの入口として決めたものだけにしてください`);
});
await ok("退職者ポータルの API（api/retiree/*）は、必ず requireRetiree を通る", () => {
  const files = walk(atRoot("api/retiree"));
  assert.ok(files.length >= 2);
  for (const f of files) assert.ok(/requireRetiree\(/.test(readFileSync(f, "utf8")), `${relative(ROOT, f)} が requireRetiree を呼んでいません`);
});
await ok("API は、ログインの確認を lib/auth.js の requireUser 以外でしていない（auth.getUser を直接呼ばない）", () => {
  const bad = [...walk(atRoot("api")), ...walk(atRoot("lib"))].filter((p) => !p.endsWith("lib/auth.js") && /auth\.getUser\(/.test(readFileSync(p, "utf8"))).map((p) => relative(ROOT, p));
  assert.deepEqual(bad, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
