// ログインアカウント（auth.users）を、メールアドレスで探して再利用する（lib/accounts.js findUserByEmail・attachAccount）。
//
// ■ 何を守るテストか（条件通知書PDFプレビュー → 本人承諾 → Office引き渡し → 入社アカウント準備 仕様 §8・§15、決定事項 6・7）
//   ・既存ユーザーの検索を 4000件で打ち切らない（最後のページまで探す）。auth.users は無限道場と共有
//   ・サーバが perPage を小さく丸めても（nextPage を返さない実装でも）取りこぼさない
//   ・最後まで確かめられなかったら「無い」と言わない（新しく作ろうとしない）
//   ・同じメールの既存アカウントがあれば必ず再利用する。新しく作らない・パスワードを変えない
//   ・探したあとに同じメールのアカウントができていた（作成がメールの重複で断られた）ときも、作り直さずに紐づける
//   ・無限道場（profiles）の既存アカウント：学習履歴・提出物・ロールは触らない（氏名を名簿に合わせ、止まっていたら開ける）
import assert from "node:assert/strict";
import { createMemDb } from "./_memdb.mjs";
import { findUserByEmail, attachAccount, LIST_USERS_PER_PAGE } from "../lib/accounts.js";

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
}

/**
 * 偽の auth.admin。users は配列。capPerPage を渡すと、要求より少ない件数に丸める（nextPage も返さない）
 */
function fakeAuth(users, { capPerPage = null, nextPage = true, failOnPage = null } = {}) {
  const calls = { list: [], create: [], update: [] };
  const admin = {
    async listUsers({ page = 1, perPage = 50 } = {}) {
      calls.list.push({ page, perPage });
      if (failOnPage === page) return { data: null, error: { message: "boom" } };
      const per = capPerPage || perPage;
      const slice = users.slice((page - 1) * per, page * per);
      const data = { users: slice.map((u) => ({ ...u })), aud: "authenticated" };
      if (nextPage && !capPerPage) {
        const last = Math.max(1, Math.ceil(users.length / per));
        data.nextPage = page < last ? page + 1 : null;
        data.lastPage = last;
        data.total = users.length;
      }
      return { data, error: null };
    },
    async createUser(p) {
      calls.create.push(p);
      if (users.some((u) => (u.email || "").toLowerCase() === p.email.toLowerCase())) {
        return { data: { user: null }, error: { status: 422, code: "email_exists", message: "A user with this email address has already been registered" } };
      }
      const u = { id: `u-new-${users.length + 1}`, email: p.email };
      users.push(u);
      return { data: { user: { ...u } }, error: null };
    },
    async updateUserById(id, p) { calls.update.push({ id, p }); return { data: {}, error: null }; },
  };
  return { admin, calls };
}
const usersN = (n) => Array.from({ length: n }, (_, i) => ({ id: `u-${i + 1}`, email: `user${i + 1}@example.test` }));

console.log("\n=== 既存ユーザーの検索（最後のページまで） ===");

await ok(`4000件を超えても見つける（1ページ ${LIST_USERS_PER_PAGE}件・nextPage に従う）`, async () => {
  const users = usersN(4500);
  users[4300].email = "Trial.Learner@Example.test";
  const { admin, calls } = fakeAuth(users);
  const id = await findUserByEmail({ auth: { admin } }, "  trial.learner@example.TEST ");
  assert.equal(id, "u-4301", "大文字小文字・前後の空白は区別しない");
  assert.deepEqual(calls.list.map((c) => c.page), [1, 2, 3, 4, 5]);
  assert.ok(calls.list.every((c) => c.perPage === LIST_USERS_PER_PAGE));
});

await ok("無ければ、最後のページまで見てから null（nextPage が null で止まる）", async () => {
  const { admin, calls } = fakeAuth(usersN(2500));
  assert.equal(await findUserByEmail({ auth: { admin } }, "nobody@example.test"), null);
  assert.deepEqual(calls.list.map((c) => c.page), [1, 2, 3]);
});

await ok("サーバが件数を丸めて nextPage も返さなくても、空のページまで進んで取りこぼさない", async () => {
  const users = usersN(4500);
  const { admin, calls } = fakeAuth(users, { capPerPage: 50 });
  assert.equal(await findUserByEmail({ auth: { admin } }, "user4400@example.test"), "u-4400");
  assert.equal(calls.list.at(-1).page, 88, "50件ずつでも 4400件目まで進む");
  const r2 = fakeAuth(users, { capPerPage: 50 });
  assert.equal(await findUserByEmail({ auth: { admin: r2.admin } }, "nobody@example.test"), null);
  assert.equal(r2.calls.list.at(-1).page, 91, "空のページ（91）を見てから「無い」");
});

await ok("途中で失敗したら「無い」と言わずに投げる（新しく作ろうとしない）", async () => {
  const { admin } = fakeAuth(usersN(3000), { failOnPage: 2 });
  await assert.rejects(() => findUserByEmail({ auth: { admin } }, "user2900@example.test"), /listUsers/);
});

console.log("\n=== attachAccount：既存を必ず再利用・重複して作らない・パスワードを変えない ===");

function setupDb() {
  const mem = createMemDb();
  mem.rows.gw_employees = [
    { id: "e-new", tenant_id: "t1", display_name: "高木 沙綾", user_id: null, employment_type: "正社員" },
    { id: "e-other", tenant_id: "t1", display_name: "別の 社員", user_id: "u-9", employment_type: "正社員" },
  ];
  mem.rows.gw_role_grants = [];
  mem.rows.clients = [{ id: "c1", tenant_id: "t1", name: "エイト" }];
  mem.rows.memberships = [];
  mem.rows.tc_profiles = [];
  return mem;
}
const clientOf = (mem, admin) => ({ ...mem.admin(), auth: { admin } });

await ok("無限道場の体験アカウント（4000件より後ろ）に紐づける：新しく作らない・パスワードを変えない・学習の記録は触らない", async () => {
  const users = usersN(4500);
  users[4200] = { id: "u-trial", email: "saya.takagi@example.test" };
  const { admin, calls } = fakeAuth(users);
  const mem = setupDb();
  mem.rows.profiles = [{ id: "u-trial", name: "さや（体験）", role: "student", approval_status: "pending", suspended_at: "2026-09-01T00:00:00Z",
    progress: { lessons: 12 }, submissions: 3 }];
  const sb = clientOf(mem, admin);
  const emp = mem.rows.gw_employees[0];
  const r = await attachAccount(sb, { tenantId: "t1", employee: { ...emp }, email: "Saya.Takagi@example.test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.userId, "u-trial");
  assert.equal(r.madeNew, false);
  assert.equal(r.createdPassword, null, "既存のアカウントにはパスワードを出さない（作っていない）");
  assert.equal(calls.create.length, 0, "createUser を呼ばない");
  assert.equal(calls.update.length, 0, "パスワード・メールを変える updateUserById を呼ばない");
  assert.equal(mem.rows.gw_employees[0].user_id, "u-trial");
  const p = mem.rows.profiles[0];
  assert.deepEqual([p.role, p.progress, p.submissions], ["student", { lessons: 12 }, 3], "ロール・学習履歴・提出物はそのまま");
  assert.deepEqual([p.name, p.approval_status, p.suspended_at], ["高木 沙綾", "approved", null], "氏名は名簿に合わせ、止まっていたら利用可へ");
  assert.equal(users.length, 4500, "auth.users は増えない");
});

await ok("探したあとに同じメールのアカウントができていた（作成がメールの重複で断られた）：作り直さず、それに紐づける", async () => {
  const users = usersN(10);
  const { admin, calls } = fakeAuth(users);
  // 1回目の検索では見つからず、作成の直前に別の手続きが同じメールで作った
  const realList = admin.listUsers;
  let first = true;
  admin.listUsers = async (q) => {
    if (first) { first = false; const r = await realList(q); users.push({ id: "u-race", email: "race@example.test" }); return r; }
    return realList(q);
  };
  const mem = setupDb();
  mem.rows.profiles = [];
  const r = await attachAccount(clientOf(mem, admin), { tenantId: "t1", employee: { ...mem.rows.gw_employees[0] }, email: "race@example.test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.userId, "u-race");
  assert.equal(r.madeNew, false);
  assert.equal(r.createdPassword, null);
  assert.equal(calls.create.length, 1, "作ろうとしたが断られた（1回だけ）");
  assert.equal(users.filter((u) => u.email === "race@example.test").length, 1, "同じメールのアカウントは1つだけ");
  assert.equal(calls.update.length, 0);
});

await ok("別の社員に割り当て済みのアカウントには紐づけない", async () => {
  const users = usersN(10);
  const { admin } = fakeAuth(users);
  const mem = setupDb();
  const r = await attachAccount(clientOf(mem, admin), { tenantId: "t1", employee: { ...mem.rows.gw_employees[0] }, email: "user9@example.test" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "user_already_assigned");
  assert.equal(mem.rows.gw_employees[0].user_id, null);
});

await ok("無ければ1つだけ作る（2回目は already_linked で何もしない）", async () => {
  const users = usersN(5);
  const { admin, calls } = fakeAuth(users);
  const mem = setupDb();
  mem.rows.profiles = [];
  const sb = clientOf(mem, admin);
  const r = await attachAccount(sb, { tenantId: "t1", employee: { ...mem.rows.gw_employees[0] }, email: "brand.new@example.test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.madeNew, true);
  assert.equal(calls.create.length, 1);
  const again = await attachAccount(sb, { tenantId: "t1", employee: { ...mem.rows.gw_employees[0] }, email: "brand.new@example.test" });
  assert.equal(again.error, "already_linked");
  assert.equal(calls.create.length, 1, "2回目は作らない");
  assert.equal(users.filter((u) => u.email === "brand.new@example.test").length, 1);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
