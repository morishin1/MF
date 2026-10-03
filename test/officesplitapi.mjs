// Office の担当分け（人事・労務 officeHr ／ 経理・事務 officeFinance）を、本物の API ハンドラで確かめる。
//
//   人事担当（hr）   → 経理・事務の API … 403
//   経理担当（finance）→ 人事・労務の API … 403
//   管理者・経営者     → どちらも通る（403 にならない）
//   責任者（manager）  → どちらも 403（月末月初 /office だけ）
//
// 判定関数（lib/gw.js の canOfficeHr / canOfficeFinance・canManageHr）は本物。DB は空の偽物（test/_memdb.mjs）。
// 403 かどうかだけを見る（通った先で DB が空なら 200／404／500 などになるが、それは「入れた」の意味で数える）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const mem = createMemDb({ schema: {}, rls: () => true, fks: {} });
const ctl = { who: null };
mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => mem.admin(), userClient: () => mem.userClient(ctl.who) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1", factors: [] }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => ctl.who } });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const P = (roles, extra = {}) => ({ tenantId: "t1", isAdmin: false, isHr: roles.includes("hr"), roles, employee: { id: "e-me", display_name: "テスト" }, ...extra });
const PEOPLE = {
  "人事（hr）": P(["hr"]),
  "経理（finance）": P(["finance"]),
  "責任者（manager）": P(["manager"]),
  "経営者（owner）": P(["owner"], { isHr: true }),
  "管理者（admin）": P([], { isAdmin: true, isHr: true }),
};

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (handler, url, method = "GET", body) => {
  const r = res();
  const raw = body === undefined ? undefined : JSON.stringify(body);
  await handler({
    method, url, headers: { authorization: "Bearer x.eyJhYWwiOiJhYWwyIn0.y", "content-type": "application/json" }, body,
    async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); },
  }, r);
  return r;
};

// [ファイル, URL, メソッド, 本文]。どれも、権限の判定が DB より先にある入口
const FINANCE_APIS = [
  ["api/closing/index.js", "/api/closing?month=2026-09", "GET"],
  ["api/billing-submission/index.js", "/api/billing-submission?month=2026-09", "GET"],
  ["api/expenses/settings.js", "/api/expenses/settings", "PATCH", { ownerThreshold: 50000 }],   // GET は全員（申請に使う）
  ["api/templates/index.js", "/api/templates", "POST", { title: "x", body: "x" }],
  ["api/library/index.js", "/api/library", "POST", { title: "x" }],
];
const HR_APIS = [
  ["api/employees/index.js", "/api/employees", "POST", { displayName: "x" }],
  ["api/probation/index.js", "/api/probation", "GET"],
  ["api/sign/orders.js", "/api/sign/orders", "GET"],
];
const load = async (list) => Promise.all(list.map(async ([f, ...rest]) => [f, (await import(atRoot(f))).default, ...rest]));
const fin = await load(FINANCE_APIS);
const hr = await load(HR_APIS);

const statusOf = async (who, [, handler, url, method, body]) => {
  ctl.who = who; mem.reset();
  try { return (await call(handler, url, method, body)).statusCode; }
  catch { return 500; }                                   // 判定を通ったあと、空の DB で落ちた（＝入れた）
};

console.log("— 人事担当 → 経理・事務の API は 403 ／ 経理担当 → 人事・労務の API は 403 —");

await ok("人事（hr）は、経理・事務の API に入れない（403）", async () => {
  for (const a of fin) assert.equal(await statusOf(PEOPLE["人事（hr）"], a), 403, a[0]);
});
await ok("経理（finance）は、人事・労務の API に入れない（403）", async () => {
  for (const a of hr) assert.equal(await statusOf(PEOPLE["経理（finance）"], a), 403, a[0]);
});
await ok("経理（finance）は、経理・事務の API に入れる（403 にならない）", async () => {
  for (const a of fin) assert.notEqual(await statusOf(PEOPLE["経理（finance）"], a), 403, a[0]);
});
await ok("人事（hr）は、人事・労務の API に入れる（403 にならない）", async () => {
  for (const a of hr) assert.notEqual(await statusOf(PEOPLE["人事（hr）"], a), 403, a[0]);
});
await ok("経営者・管理者は、どちらにも入れる", async () => {
  for (const who of ["経営者（owner）", "管理者（admin）"]) {
    for (const a of [...fin, ...hr]) assert.notEqual(await statusOf(PEOPLE[who], a), 403, `${who} ${a[0]}`);
  }
});
await ok("責任者（manager）は、どちらにも入れない（月末月初 /office だけ。権限を広げない）", async () => {
  for (const a of [...fin, ...hr]) assert.equal(await statusOf(PEOPLE["責任者（manager）"], a), 403, a[0]);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
