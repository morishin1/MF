// メンバーの一括登録（POST /api/employees/bulk）と、名簿からの削除（DELETE /api/employees・確認だけの GET ?deleteCheck=）。
//
// ■ 守るもの（2026-10-24 メンバー管理UI・一括登録/削除の改善）
//   一括登録
//   1. ログインアカウントは、createAccounts: true を明示したときだけ作る（省略・false では作らない）
//   2. 結果を分ける：追加（created／linked／failed／no_email／not_requested）・重複で飛ばした・失敗
//   3. 2回送っても増えない（同じ氏名・メールは飛ばす）。失敗した行だけ送り直しても二重にならない
//   4. いまの名簿を読めなかったら、取り込まない（「誰もいない」として全員を足さない）
//   5. メール・入社日（実在する日付）の形を、サーバでも確かめる
//   6. アカウントを作った・紐づけたことを、1人ずつ記録に残す
//   削除
//   7. 関連する記録を数えられなかった（表が読めない）ら、消さない（「記録なし」として消さない）。
//      表そのものが無い（未適用）だけなら、その表には記録が無いので続ける
//   8. 確認だけの GET は、DELETE と同じ判定（経営者・最後の経営者・自分・関連する記録）を返し、何も消さない
//   9. 止めた削除も記録に残す。見つからない（二重に押した・もう消えた）ときは 404 で、何も起きない
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {}, countError: {}, selectError: {} };
const logged = [];
const attachCalls = [];

function table(name) {
  const f = [];
  let isCount = false;
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => (op === "eq" ? r[k] === v : op === "in" ? v.includes(r[k]) : true)));
  const copy = (r) => (r ? { ...r } : null);
  const selErr = () => db.selectError[name] || null;
  const q = {
    select(_c, opts) { if (opts?.count) isCount = true; return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve(selErr() ? { data: null, error: selErr() } : { data: copy(rows()[0]), error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    then: (fn, rej) => {
      if (isCount && db.countError[name]) return Promise.resolve({ data: null, error: db.countError[name], count: null }).then(fn, rej);
      if (selErr()) return Promise.resolve({ data: null, error: selErr() }).then(fn, rej);
      return Promise.resolve({ data: isCount ? null : rows().map(copy), error: null, count: rows().length }).then(fn, rej);
    },
    insert(row) {
      const made = [].concat(row).map((r, n) => ({ id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, user_id: null, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = { select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }) };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        select: () => r2, single: () => apply(), maybeSingle: () => apply(),
        then: (fn) => apply().then(fn),
      };
      function apply() {
        const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]), error: null });
      }
      return r2;
    },
    delete() {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        then: (fn) => {
          db.rows[name] = (db.rows[name] || []).filter((x) => !g.every(([k, v]) => x[k] === v));
          return Promise.resolve({ error: null }).then(fn);
        },
      };
      return r2;
    },
  };
  return q;
}
const client = () => ({ from: table });
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-hr" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
// アカウント作成：メールで結果を変える（created / linked / failed）
mock.module(atRoot("lib/accounts.js"), { namedExports: {
  SYSTEMS: [], readAccounts: async () => new Map(),
  setAccountsActive: async () => ({ lms: { ok: true } }), removeAccountingAccess: async () => ({ ok: true }),
  attachAccount: async (_sb, { employee, email }) => {
    attachCalls.push({ id: employee.id, email });
    if (/fail/.test(email)) return { ok: false, error: "create_user_failed", detail: "boom" };
    if (/linked/.test(email)) return { ok: true, userId: `u-${employee.id}`, createdPassword: null, madeNew: false, systems: {} };
    return { ok: true, userId: `u-${employee.id}`, createdPassword: "pw-1", madeNew: true, systems: {} };
  },
  setSystemAccess: async () => ({ ok: true }), randomPassword: () => "pw", findUserByEmail: async () => null,
} });

const REAL_GW = await import(atRoot("lib/gw.js"));
let who;
mock.module(atRoot("lib/gw.js"), { namedExports: {
  gwContext: async () => who, canManageHr: REAL_GW.canManageHr, isOwner: REAL_GW.isOwner,
  memberAccessOf: REAL_GW.memberAccessOf, accessOf: REAL_GW.accessOf, isHrOf: REAL_GW.isHrOf,
} });
const { default: bulkApi } = await import(atRoot("api/employees/bulk.js"));
const { default: employeesApi } = await import(atRoot("api/employees/index.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (api, { method, url = "/api/employees", body }) => {
  const r = res();
  await api({ method, url, headers: {}, body, on() {} , [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); } }, r);
  return r;
};
const bulk = (body) => call(bulkApi, { method: "POST", url: "/api/employees/bulk", body });
const del = (id) => call(employeesApi, { method: "DELETE", url: `/api/employees?id=${id}` });
const check = (id) => call(employeesApi, { method: "GET", url: `/api/employees?deleteCheck=${id}` });

// 人事（Office ON・hr）。経営者ではない
const HR = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], apps: ["office"], employee: { id: "emp-hr" } };
const OWNER = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"], apps: [], employee: { id: "emp-own" } };
function setup() {
  db.rows = {
    gw_employees: [
      { id: "emp-own", tenant_id: "t1", display_name: "経営 太郎", email: "own@example.com", user_id: "u-own", status: "active" },
      { id: "emp-hr", tenant_id: "t1", display_name: "人事 花子", email: "hr@example.com", user_id: "u-hr", status: "active" },
      { id: "emp-new", tenant_id: "t1", display_name: "誤登録 一郎", email: "typo@example.com", user_id: null, status: "invited" },
      { id: "emp-rec", tenant_id: "t1", display_name: "記録 二郎", email: "rec@example.com", user_id: "u-rec", status: "active" },
      { id: "emp-x", tenant_id: "t2", display_name: "別会社", email: "x@example.com", user_id: null, status: "active" },
    ],
    gw_role_grants: [
      { id: "g1", tenant_id: "t1", employee_id: "emp-own", role: "owner" },
      { id: "g2", tenant_id: "t1", employee_id: "emp-hr", role: "hr" },
    ],
    gw_requests: [{ id: "r1", tenant_id: "t1", employee_id: "emp-rec" }],
  };
  db.countError = {}; db.selectError = {};
  logged.length = 0; attachCalls.length = 0;
  who = HR;
}
const has = (id) => db.rows.gw_employees.some((e) => e.id === id);

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("NG:", name, "\n   ", e.message); }
}

console.log("=== 一括登録 ===");
await ok("createAccounts を省いたら、アカウントは作らない（名簿だけ）", async () => {
  setup();
  const r = await bulk({ rows: [{ display_name: "新規 A", email: "a@example.com" }] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.withAccounts, false);
  assert.equal(attachCalls.length, 0);
  assert.equal(r.body.added[0].account, "not_requested");
  assert.equal(db.rows.gw_employees.find((e) => e.display_name === "新規 A").status, "invited", "名簿には「入社準備」で入る");
});
await ok("createAccounts: false でも作らない", async () => {
  setup();
  const r = await bulk({ rows: [{ display_name: "新規 A", email: "a@example.com" }], createAccounts: false });
  assert.equal(attachCalls.length, 0);
  assert.equal(r.body.added[0].account, "not_requested");
});
await ok("createAccounts: true を明示したときだけ作る。created／linked／failed／no_email を分ける", async () => {
  setup();
  const r = await bulk({ createAccounts: true, rows: [
    { display_name: "作る A", email: "a@example.com" },
    { display_name: "紐づけ B", email: "linked@example.com" },
    { display_name: "失敗 C", email: "fail@example.com" },
    { display_name: "メールなし D" },
  ] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.added.map((a) => [a.name, a.account]), [["作る A", "created"], ["紐づけ B", "linked"], ["失敗 C", "failed"], ["メールなし D", "no_email"]]);
  assert.equal(r.body.added[0].password, "pw-1", "新しく作ったときだけ初回パスワード");
  assert.equal(r.body.added[1].password, null);
  assert.match(r.body.added[2].accountError, /boom/);
  assert.ok(has(r.body.added[2].id), "アカウントが作れなくても、名簿には入っている");
  const acts = logged.filter((l) => l.action.startsWith("account."));
  assert.deepEqual(acts.map((l) => [l.action, l.detail.name]), [["account.create", "作る A"], ["account.link", "紐づけ B"]]);
  const sum = logged.find((l) => l.action === "employee.bulk_create");
  assert.deepEqual(sum.detail.accounts, { created: 1, linked: 1, failed: 1, no_email: 1 });
  assert.equal(sum.detail.withAccounts, true);
});
await ok("重複は飛ばす（名簿の氏名・メール、同じ送信の中）。2回送っても増えない", async () => {
  setup();
  const rows = [
    { display_name: "人事 花子", email: "other@example.com" },      // 名簿の氏名
    { display_name: "別の人", email: "HR@example.com" },            // 名簿のメール（大文字小文字は同じ）
    { display_name: "新規 E", email: "e@example.com" },
    { display_name: "新規 E", email: "e2@example.com" },            // 同じ送信の中の氏名
  ];
  const r1 = await bulk({ rows });
  assert.deepEqual(r1.body.added.map((a) => a.name), ["新規 E"]);
  assert.deepEqual(r1.body.skipped.map((s) => [s.line, s.kind]), [[1, "duplicate_name"], [2, "duplicate_email"], [4, "duplicate_name"]]);
  const before = db.rows.gw_employees.length;
  const r2 = await bulk({ rows });
  assert.equal(r2.body.added.length, 0, "もう一度送っても増えない");
  assert.equal(db.rows.gw_employees.length, before);
});
await ok("失敗した行だけ直して送り直す：成功した人は増えず、直した人だけ入る", async () => {
  setup();
  const r1 = await bulk({ rows: [{ display_name: "成功 F", email: "f@example.com" }, { display_name: "失敗 G", email: "bad-email" }] });
  assert.deepEqual(r1.body.failed.map((x) => [x.line, x.reason]), [[2, "メールアドレスの形が正しくありません"]]);
  const r2 = await bulk({ rows: [{ display_name: "成功 F", email: "f@example.com" }, { display_name: "失敗 G", email: "g@example.com" }] });
  assert.deepEqual(r2.body.added.map((a) => a.name), ["失敗 G"]);
  assert.deepEqual(r2.body.skipped.map((a) => a.name), ["成功 F"]);
  assert.equal(db.rows.gw_employees.filter((e) => e.display_name === "成功 F").length, 1);
});
await ok("入社日は実在する日付だけ（2026-02-30 は理由つきで失敗）", async () => {
  setup();
  const r = await bulk({ rows: [{ display_name: "日付 H", joined_on: "2026-02-30" }, { display_name: "日付 I", joined_on: "2026-04-01" }] });
  assert.match(r.body.failed[0].reason, /実在する日付/);
  assert.deepEqual(r.body.added.map((a) => a.name), ["日付 I"]);
});
await ok("いまの名簿を読めなかったら、取り込まない（重複を確かめられない）", async () => {
  setup();
  db.selectError.gw_employees = { code: "XX000", message: "boom" };
  const before = db.rows.gw_employees.length;
  const r = await bulk({ rows: [{ display_name: "新規 J" }] });
  db.selectError = {};
  assert.equal(r.statusCode, 500);
  assert.match(r.body.hint, /取り込んでいません/);
  assert.equal(db.rows.gw_employees.length, before);
});
await ok("201行は断る（何も足さない）", async () => {
  setup();
  const r = await bulk({ rows: Array.from({ length: 201 }, (_, i) => ({ display_name: `人${i}` })) });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "too_many_rows");
});

console.log("\n=== 削除の確認（GET ?deleteCheck=）と削除（DELETE）===");
await ok("記録の無い誤登録は、確認で「消せる」。確認だけでは消えない", async () => {
  setup();
  const r = await check("emp-new");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.deletable, true);
  assert.equal(r.body.hasLogin, false);
  assert.ok(has("emp-new"), "確認しただけでは消えない");
  assert.equal(logged.length, 0, "確認は記録に残さない（何もしていない）");
});
await ok("記録がある人は、確認で「消せない」（件数と、退職の案内）", async () => {
  setup();
  const r = await check("emp-rec");
  assert.equal(r.body.deletable, false);
  assert.equal(r.body.reason.error, "employee_has_records");
  assert.deepEqual(r.body.reason.blockers, [{ label: "有給・稟議", count: 1 }]);
  assert.match(r.body.reason.hint, /退職/);
});
await ok("自分自身・経営者（人事から）・最後の経営者（経営者から）は、確認で「消せない」", async () => {
  setup();
  assert.equal((await check("emp-hr")).body.reason.error, "cannot_delete_self");
  assert.equal((await check("emp-own")).body.reason.error, "owner_only");
  who = { ...OWNER, employee: { id: "emp-hr" } };     // 別の経営者の画面から、最後の経営者を
  db.rows.gw_role_grants.push({ id: "g9", tenant_id: "t1", employee_id: "emp-hr", role: "owner" });
  db.rows.gw_employees.find((e) => e.id === "emp-hr").status = "left";   // 2人目は退職済み → 在籍の経営者は1人
  assert.equal((await check("emp-own")).body.reason.error, "last_owner");
});
await ok("関連する記録を数えられなかったら、確認は「消せない」・DELETE も消さない（503・理由つき）", async () => {
  setup();
  db.countError.gw_expense_reports = { code: "XX000", message: "timeout" };
  const c = await check("emp-new");
  assert.equal(c.body.deletable, false);
  assert.equal(c.body.reason.error, "related_lookup_failed");
  assert.deepEqual(c.body.reason.failed, ["経費申請"]);
  const r = await del("emp-new");
  assert.equal(r.statusCode, 503, JSON.stringify(r.body));
  assert.equal(r.body.error, "related_lookup_failed");
  assert.match(r.body.hint, /削除していません/);
  assert.ok(has("emp-new"), "消えていない");
  assert.ok(logged.some((l) => l.action === "employee.delete_blocked" && l.detail.reason === "related_lookup_failed"), "止めたことを記録に残す");
});
await ok("列が無い（42703）も「読めなかった」に入れる（表が無い扱いにしない）", async () => {
  setup();
  db.countError.gw_messages = { code: "42703", message: "column gw_messages.sender_id does not exist" };
  const r = await del("emp-new");
  assert.equal(r.statusCode, 503);
  assert.ok(has("emp-new"));
});
await ok("表そのものが無い（未適用：PGRST205・42P01）だけなら、その表には記録が無いので消せる", async () => {
  setup();
  db.countError.gw_bookings = { code: "PGRST205", message: "Could not find the table 'public.gw_bookings' in the schema cache" };
  db.countError.gw_procedures = { code: "42P01", message: 'relation "gw_procedures" does not exist' };
  assert.equal((await check("emp-new")).body.deletable, true);
  const r = await del("emp-new");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(!has("emp-new"));
});
await ok("消せる人は消える。ログインは残し、社内システムを止めたことを返す・記録に残す", async () => {
  setup();
  db.rows.gw_employees.find((e) => e.id === "emp-new").user_id = "u-new";
  const r = await del("emp-new");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.authUserKept, true);
  assert.ok(r.body.systems && r.body.systems.accounting, "会計の権限を外した結果を返す");
  assert.ok(logged.some((l) => l.action === "employee.delete" && l.detail.had_login === true));
});
await ok("もう一度押しても（二重送信・再送）、2回目は 404 で何も起きない", async () => {
  setup();
  assert.equal((await del("emp-new")).statusCode, 200);
  const r = await del("emp-new");
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, "employee_not_found");
  assert.match(r.body.hint, /すでに削除/);
  assert.equal(logged.filter((l) => l.action === "employee.delete").length, 1, "削除の記録は1回だけ");
  assert.ok(!logged.some((l) => l.action === "employee.delete_blocked"), "見つからないものは「止めた」記録にしない");
});
await ok("別の会社（テナント）の人は、確認も削除も 404（存在を言わない）", async () => {
  setup();
  assert.equal((await check("emp-x")).statusCode, 404);
  assert.equal((await del("emp-x")).statusCode, 404);
  assert.ok(has("emp-x"));
});
await ok("名簿を読めなかったら「いない」とせず 500（確認も削除も）", async () => {
  setup();
  db.selectError.gw_employees = { code: "XX000", message: "boom" };
  assert.equal((await check("emp-new")).statusCode, 500);
  assert.equal((await del("emp-new")).statusCode, 500);
  db.selectError = {};
  assert.ok(has("emp-new"));
});
await ok("人事権限が無い人は、確認も削除もできない", async () => {
  setup();
  who = { tenantId: "t1", isAdmin: false, isHr: false, roles: [], apps: ["sales"], employee: { id: "emp-rec" } };
  assert.equal((await check("emp-new")).statusCode, 403);
  assert.equal((await del("emp-new")).statusCode, 403);
  assert.equal((await bulk({ rows: [{ display_name: "x" }] })).statusCode, 403);
  assert.ok(has("emp-new"));
});

console.log(`\n${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
