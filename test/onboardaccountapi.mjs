// 社員登録のプレビュー（api/employees/onboard.js。登録しない）で、既存のログインアカウント・無限道場の扱いを登録前に見せる。
//
// ■ 何を守るテストか（条件通知書PDFプレビュー → 本人承諾 → Office引き渡し → 入社アカウント準備 仕様 §8、決定事項 7）
//   既存の無限道場アカウントへ紐づけるとき、登録の前に次を明示する：
//   ・新しくは作らない・パスワードは変わらない
//   ・学習履歴・提出物・ロールはそのまま
//   ・氏名を名簿に合わせる（違うときだけ）
//   ・停止中・承認待ち・却下なら、利用できる状態に戻す
//   ・4000件より後ろのアカウントでも見つける（検索を打ち切らない）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);

const mem = createMemDb();
const users = [];
const authCalls = { create: 0, update: 0 };
const auth = {
  admin: {
    async listUsers({ page = 1, perPage = 50 } = {}) {
      const slice = users.slice((page - 1) * perPage, page * perPage);
      const last = Math.max(1, Math.ceil(users.length / perPage));
      return { data: { users: slice.map((u) => ({ ...u })), nextPage: page < last ? page + 1 : null }, error: null };
    },
    async createUser() { authCalls.create++; return { data: null, error: { message: "should not be called" } }; },
    async updateUserById() { authCalls.update++; return { data: {}, error: null }; },
  },
};
mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ ...mem.admin(), auth }), userClient: () => ({ ...mem.admin(), auth }) },
});
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-hr" }), getMemberships: async () => [] } });
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    ...REAL_GW,
    gwContext: async () => ({ tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], apps: ["hr", "office"], employee: { id: "e-hr", display_name: "人事 次郎" } }),
  },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });

const { default: onboard } = await import(atRoot("api/employees/onboard.js"));

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
}
async function call(body) {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  await onboard({ method: "POST", url: "/api/employees/onboard", headers: { authorization: "Bearer x" }, body }, r);
  return r;
}
const FORM = {
  name: "高木 沙綾", email: "saya.takagi@example.test", joinDate: "2026-11-01", contractType: "無期",
  trainingMonths: 3, weeklyHours: 40, jobFamilyCode: "SALES", initialRole: "メンバー", managerEmail: "boss@example.test",
  autonomyLevel: 1, accountType: "member",
};
function setup({ lms } = {}) {
  mem.reset();
  users.length = 0;
  for (let i = 0; i < 4500; i++) users.push({ id: `u-${i + 1}`, email: `user${i + 1}@example.test` });
  users[4321] = { id: "u-trial", email: "saya.takagi@example.test" };
  mem.rows.gw_employees = [{ id: "e-boss", tenant_id: "t1", display_name: "上長 一郎", email: "boss@example.test", user_id: "u-1", status: "active" }];
  mem.rows.profiles = lms ? [{ id: "u-trial", ...lms }] : [];
  authCalls.create = 0; authCalls.update = 0;
}

console.log("\n=== 社員登録のプレビュー：既存の無限道場アカウントに紐づけるときの説明 ===");

await ok("4000件より後ろの体験アカウントでも見つけ、「新しくは作らない・パスワードは変わらない・学習履歴・提出物・ロールはそのまま」", async () => {
  setup({ lms: { name: "高木 沙綾", role: "student", approval_status: "approved", suspended_at: null } });
  const r = await call({ form: FORM });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const acc = r.body.account;
  assert.equal(acc.kind, "existing");
  assert.deepEqual(acc.lms, { exists: true, name: "高木 沙綾", renames: false, reopens: false, stateLabel: null });
  assert.match(acc.message, /新しくは作らず/);
  assert.match(acc.message, /パスワードは変わりません/);
  assert.match(acc.message, /学習履歴・提出物・ロールはそのまま/);
  assert.doesNotMatch(acc.message, /合わせます|戻します/, "変わらないことは書かない");
  assert.deepEqual([authCalls.create, authCalls.update], [0, 0], "プレビューでは作らない・変えない");
});

await ok("氏名が違えば「名簿の氏名に合わせます」、停止中なら「利用できる状態に戻します」と登録前に出す", async () => {
  setup({ lms: { name: "さや（体験）", role: "student", approval_status: "approved", suspended_at: "2026-09-01T00:00:00Z" } });
  const acc = (await call({ form: FORM })).body.account;
  assert.deepEqual([acc.lms.renames, acc.lms.reopens, acc.lms.stateLabel], [true, true, "停止中"]);
  assert.match(acc.message, /無限道場の氏名「さや（体験）」は、名簿の「高木 沙綾」に合わせます/);
  assert.match(acc.message, /無限道場で停止中のため、利用できる状態に戻します/);
});

await ok("承認待ち・却下も「利用できる状態に戻します」", async () => {
  for (const [st, label] of [["pending", "承認待ち"], ["rejected", "利用を止めている（却下）"]]) {
    setup({ lms: { name: "高木 沙綾", role: "student", approval_status: st, suspended_at: null } });
    const acc = (await call({ form: FORM })).body.account;
    assert.equal(acc.lms.stateLabel, label);
    assert.ok(acc.message.includes(`無限道場で${label}のため、利用できる状態に戻します`), acc.message);
  }
});

await ok("無限道場の行が無ければ、学習履歴の説明は出さない（新しく受講者として入る）", async () => {
  setup();
  const acc = (await call({ form: FORM })).body.account;
  assert.deepEqual(acc.lms, { exists: false });
  assert.doesNotMatch(acc.message, /学習履歴/);
});

await ok("まだアカウントが無ければ new（作るのは登録のとき）", async () => {
  setup();
  const r = await call({ form: { ...FORM, email: "brand.new@example.test" } });
  assert.equal(r.body.account.kind, "new");
  assert.equal(authCalls.create, 0);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
