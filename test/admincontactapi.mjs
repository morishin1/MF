// メンバー → 管理サイド共通チャット（api/messages/admin-contact.js・
// api/messages/index.js の list への統合）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. ［管理サイドへ連絡］を開くと、本人 + いまの管理サイドが参加者になる
//   2. 2回押しても、本人専用の窓口は1本のまま（existed: true で返す）
//   3. 監査ログ（gwLog）は、新規に開いたときだけ残る
//   4. 一覧（GET /api/messages）で、本人には固定の表示名、
//      管理サイドの人には「誰からの連絡か」が出る
//   5. 一覧を開くと、管理サイドの人はテナント内の窓口すべてへ参加者として足される
//      （後から管理側になった人も、次に開けば過去ごと見える）
//   6. 社員名簿に無い（社員として登録されていない）人は使えない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };
const logged = [];

function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
      if (op === "neq") return r[k] !== v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? 1 : -1));
    // gw_thread_members の embed（employee:gw_employees(...)）を、手で解決しておく
    if (name === "gw_thread_members") {
      out = out.map((r) => (r.employee ? r : {
        ...r, employee: (db.rows.gw_employees || []).find((e) => e.id === r.employee_id) || null,
      }));
    }
    return out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    order(col) { order = col; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: r.created_at || new Date().toISOString(), ...r,
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

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: whoUserId }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});

const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false,
  employee: { id: "emp-member", display_name: "現場 太郎" } };
const HR = { tenantId: "t1", isAdmin: false, isHr: true,
  employee: { id: "emp-hr", display_name: "事務 花子" } };
let who = MEMBER;
let whoUserId = "u-member";
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr) },
});

const { default: adminContact } = await import(atRoot("api/messages/admin-contact.js"));
const { default: messages } = await import(atRoot("api/messages/index.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const openContact = () => call(adminContact, { method: "POST", url: "/api/messages/admin-contact" });
const getList = () => call(messages, { method: "GET", url: "/api/messages" });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = MEMBER; whoUserId = "u-member";
  logged.length = 0;
  db.rows = {
    memberships: [{ user_id: "u-hr", tenant_id: "t1", role: "admin" }],
    gw_employees: [
      { id: "emp-member", user_id: "u-member", tenant_id: "t1", status: "active", display_name: "現場 太郎" },
      { id: "emp-hr", user_id: "u-hr", tenant_id: "t1", status: "active", display_name: "事務 花子" },
    ],
    gw_role_grants: [],
    gw_threads: [],
    gw_thread_members: [],
    gw_messages: [],
  };
}

console.log("\n=== ［管理サイドへ連絡］を開く（api/messages/admin-contact.js） ===\n");

await ok("開くと、本人 + いまの管理サイドが参加者になる", async () => {
  setup();
  const r = await openContact();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.existed, false);
  const members = db.rows.gw_thread_members.filter((m) => m.thread_id === r.body.threadId);
  assert.deepEqual(new Set(members.map((m) => m.employee_id)), new Set(["emp-member", "emp-hr"]));
});

await ok("スレッドの持ち主（contact_employee_id）は本人", async () => {
  setup();
  const r = await openContact();
  const t = db.rows.gw_threads.find((x) => x.id === r.body.threadId);
  assert.equal(t.kind, "admin_contact");
  assert.equal(t.contact_employee_id, "emp-member");
});

await ok("2回押しても、本人専用の窓口は1本のまま", async () => {
  setup();
  const r1 = await openContact();
  const r2 = await openContact();
  assert.equal(r2.body.existed, true);
  assert.equal(r1.body.threadId, r2.body.threadId);
  assert.equal(db.rows.gw_threads.filter((t) => t.kind === "admin_contact").length, 1);
});

await ok("監査ログは、新規に開いたときだけ残る", async () => {
  setup();
  await openContact();
  await openContact();
  const opens = logged.filter((l) => l.action === "message.admin_contact_open");
  assert.equal(opens.length, 1);
  assert.equal(opens[0].actorId, "u-member");
});

await ok("社員名簿に無いと使えない", async () => {
  setup();
  db.rows.gw_employees = db.rows.gw_employees.filter((e) => e.id !== "emp-member");
  who = { tenantId: "t1", isAdmin: false, isHr: false, employee: null };
  const r = await openContact();
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "not_enrolled");
});

console.log("\n=== 一覧に出る表示名・共通受信箱への参加（api/messages/index.js） ===\n");

await ok("本人の一覧には固定の表示名", async () => {
  setup();
  const opened = await openContact();
  who = MEMBER; whoUserId = "u-member";
  const r = await getList();
  const t = r.body.threads.find((x) => x.id === opened.body.threadId);
  assert.equal(t.displayName, "管理サイドへの連絡");
});

await ok("管理サイドの一覧には「誰からの連絡か」", async () => {
  setup();
  const opened = await openContact();
  who = HR; whoUserId = "u-hr";
  const r = await getList();
  const t = r.body.threads.find((x) => x.id === opened.body.threadId);
  assert.equal(t.displayName, "現場 太郎 さんからの連絡");
});

await ok("後から管理側になった人も、一覧を開けば過去ごと見える", async () => {
  setup();
  const opened = await openContact();

  // 後から人事ロールを持つ人が増えた、という想定
  db.rows.gw_employees.push({ id: "emp-newhr", user_id: "u-newhr", tenant_id: "t1", status: "active" });
  db.rows.gw_role_grants.push({ employee_id: "emp-newhr", role: "hr" });
  const NEWHR = { tenantId: "t1", isAdmin: false, isHr: true, employee: { id: "emp-newhr", display_name: "新人 事務" } };
  who = NEWHR; whoUserId = "u-newhr";

  const r = await getList();
  assert.ok(r.body.threads.some((t) => t.id === opened.body.threadId), "一覧に出る");
  const members = db.rows.gw_thread_members.filter((m) => m.thread_id === opened.body.threadId);
  assert.ok(members.some((m) => m.employee_id === "emp-newhr"), "参加者にも足される");
});

await ok("一般メンバーの一覧を開いても、管理サイドの参加者は増えない", async () => {
  setup();
  const opened = await openContact();
  const before = db.rows.gw_thread_members.filter((m) => m.thread_id === opened.body.threadId).length;
  who = MEMBER; whoUserId = "u-member";
  await getList();
  const after = db.rows.gw_thread_members.filter((m) => m.thread_id === opened.body.threadId).length;
  assert.equal(before, after);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
