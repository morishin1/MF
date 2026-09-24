// メンバー → 管理サイド共通チャット（db/079・lib/messages-admin.js）を、
// 偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 「管理サイド」は canManageHr / gw_is_hr と同じ判定
//      （memberships が admin/staff、または gw_role_grants が hr/owner）
//   2. 退職者（status: left）は管理サイドに数えない
//   3. 開設すると、本人 + いまの管理サイドが参加者になる
//   4. 2回開いても、本人専用の窓口は1本のまま（作り直さない）
//   5. 開くたびに、いまの管理サイドで参加者を揃え直す
//      （後から管理側になった人も足される。抜けた人は自動では外さない）
//   6. ensureAdminContactInbox は、管理サイドの人を全部の窓口へ足す
//   7. 表示名は、本人には固定文言、管理サイドには「誰からの連絡か」
import assert from "node:assert/strict";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "neq") return r[k] !== v;
    if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
    return true;
  }));
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...r,
      }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn),
      };
      return r2;
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);
const sb = { from: table };

const {
  adminSideEmployeeIds, findAdminContactThread, openAdminContactThread,
  syncAdminContactMembers, ensureAdminContactInbox, adminContactDisplayName,
} = await import(atRoot("lib/messages-admin.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  db.rows = {
    memberships: [
      { user_id: "u-hr", tenant_id: "t1", role: "admin" },
      { user_id: "u-staff", tenant_id: "t1", role: "staff" },
    ],
    gw_employees: [
      { id: "emp-hr", user_id: "u-hr", tenant_id: "t1", status: "active" },
      { id: "emp-staff", user_id: "u-staff", tenant_id: "t1", status: "active" },
      { id: "emp-owner", user_id: "u-owner", tenant_id: "t1", status: "active" },
      { id: "emp-left-admin", user_id: "u-left", tenant_id: "t1", status: "left" },
      { id: "emp-member", user_id: "u-member", tenant_id: "t1", status: "active" },
    ],
    gw_role_grants: [
      { employee_id: "emp-owner", role: "owner" },
      { employee_id: "emp-member", role: "manager" }, // 管理サイドではない
    ],
    gw_threads: [],
    gw_thread_members: [],
  };
}

console.log("\n=== 管理サイドの判定（adminSideEmployeeIds） ===\n");

await ok("admin/staff（memberships）と hr/owner（role_grants）が入る", async () => {
  setup();
  const ids = await adminSideEmployeeIds(sb, "t1");
  assert.deepEqual(new Set(ids), new Set(["emp-hr", "emp-staff", "emp-owner"]));
});

await ok("退職者（status: left）は、admin membership があっても数えない", async () => {
  setup();
  db.rows.memberships.push({ user_id: "u-left", tenant_id: "t1", role: "admin" });
  const ids = await adminSideEmployeeIds(sb, "t1");
  assert.ok(!ids.includes("emp-left-admin"));
});

await ok("ただの manager ロールは管理サイドに入らない", async () => {
  setup();
  const ids = await adminSideEmployeeIds(sb, "t1");
  assert.ok(!ids.includes("emp-member"));
});

console.log("\n=== 開設する（openAdminContactThread） ===\n");

await ok("開設すると、本人 + いまの管理サイドが参加者になる", async () => {
  setup();
  const r = await openAdminContactThread(sb, "t1", { id: "emp-member", display_name: "現場 太郎" }, "u-member");
  assert.equal(r.existed, false);
  const members = db.rows.gw_thread_members.filter((m) => m.thread_id === r.threadId);
  assert.deepEqual(new Set(members.map((m) => m.employee_id)),
    new Set(["emp-member", "emp-hr", "emp-staff", "emp-owner"]));
});

await ok("スレッドは kind: admin_contact / contact_employee_id が本人", async () => {
  setup();
  const r = await openAdminContactThread(sb, "t1", { id: "emp-member", display_name: "現場 太郎" }, "u-member");
  const t = db.rows.gw_threads.find((x) => x.id === r.threadId);
  assert.equal(t.kind, "admin_contact");
  assert.equal(t.contact_employee_id, "emp-member");
});

await ok("2回開いても、本人専用の窓口は1本のまま", async () => {
  setup();
  const r1 = await openAdminContactThread(sb, "t1", { id: "emp-member", display_name: "現場 太郎" }, "u-member");
  const r2 = await openAdminContactThread(sb, "t1", { id: "emp-member", display_name: "現場 太郎" }, "u-member");
  assert.equal(r2.existed, true);
  assert.equal(r1.threadId, r2.threadId);
  assert.equal(db.rows.gw_threads.filter((t) => t.kind === "admin_contact").length, 1);
});

await ok("後から管理側になった人も、開くたびに足される", async () => {
  setup();
  const r = await openAdminContactThread(sb, "t1", { id: "emp-member", display_name: "現場 太郎" }, "u-member");
  // emp-left-admin が後から管理側になった、という想定
  db.rows.gw_role_grants.push({ employee_id: "emp-left-admin", role: "hr" });
  db.rows.gw_employees.find((e) => e.id === "emp-left-admin").status = "active";
  await syncAdminContactMembers(sb, "t1", r.threadId, "emp-member");
  const members = db.rows.gw_thread_members.filter((m) => m.thread_id === r.threadId);
  assert.ok(members.some((m) => m.employee_id === "emp-left-admin"));
});

await ok("抜けた人は自動では外さない", async () => {
  setup();
  const r = await openAdminContactThread(sb, "t1", { id: "emp-member", display_name: "現場 太郎" }, "u-member");
  db.rows.memberships = db.rows.memberships.filter((m) => m.user_id !== "u-staff");
  await syncAdminContactMembers(sb, "t1", r.threadId, "emp-member");
  const members = db.rows.gw_thread_members.filter((m) => m.thread_id === r.threadId);
  assert.ok(members.some((m) => m.employee_id === "emp-staff"), "残ったまま");
});

console.log("\n=== 見つける（findAdminContactThread） ===\n");

await ok("無ければ null", async () => {
  setup();
  const id = await findAdminContactThread(sb, "t1", "emp-member");
  assert.equal(id, null);
});

console.log("\n=== 共通受信箱に足す（ensureAdminContactInbox） ===\n");

await ok("管理サイドの人を、テナント内の窓口すべてへ足す", async () => {
  setup();
  const r1 = await openAdminContactThread(sb, "t1", { id: "emp-member", display_name: "現場 太郎" }, "u-member");
  db.rows.gw_thread_members = db.rows.gw_thread_members.filter((m) => m.employee_id !== "emp-hr");
  await ensureAdminContactInbox(sb, "t1", "emp-hr");
  const members = db.rows.gw_thread_members.filter((m) => m.thread_id === r1.threadId);
  assert.ok(members.some((m) => m.employee_id === "emp-hr"));
});

await ok("既に参加していれば、重複して足さない", async () => {
  setup();
  const r1 = await openAdminContactThread(sb, "t1", { id: "emp-member", display_name: "現場 太郎" }, "u-member");
  await ensureAdminContactInbox(sb, "t1", "emp-hr");
  const members = db.rows.gw_thread_members.filter((m) => m.thread_id === r1.threadId && m.employee_id === "emp-hr");
  assert.equal(members.length, 1);
});

console.log("\n=== 表示名（adminContactDisplayName） ===\n");

await ok("本人には固定文言", async () => {
  const name = adminContactDisplayName(
    { kind: "admin_contact", contact_employee_id: "emp-member" },
    { employee: { id: "emp-member" } }, []);
  assert.equal(name, "管理サイドへの連絡");
});

await ok("管理サイドには「誰からの連絡か」", async () => {
  const name = adminContactDisplayName(
    { kind: "admin_contact", contact_employee_id: "emp-member" },
    { employee: { id: "emp-hr" } },
    [{ id: "emp-member", display_name: "現場 太郎" }]);
  assert.equal(name, "現場 太郎 さんからの連絡");
});

await ok("dm/group では null（呼び出し側の通常ロジックに任せる）", async () => {
  const name = adminContactDisplayName(
    { kind: "group", contact_employee_id: null }, { employee: { id: "emp-hr" } }, []);
  assert.equal(name, null);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
