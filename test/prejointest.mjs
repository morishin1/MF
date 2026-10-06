// 契約（労働条件の署名）前の人を、通常社員として扱わない。
//
// 「本採用へ進める」は既存の社員登録（api/employees/onboard.js）を使うので、
// 署名前でも gw_employees の行はできる（status = invited・入社準備）。
// その人が次のどれにもならないことを、実際の API で確かめる。
//
//   ① 在籍（active）にならない     … 入社日が来ても、署名が済むまで（api/me.js・api/cron/escalate.js）
//   ② 通常業務メニューが開かない   … 入社準備の画面だけ（lib/stages.js）。提出がそろっていても署名前は開けない
//   ③ 入社情報・必要書類を登録できない … api/onboarding/me.js・submit.js・upload.js（lib/onboard-gate.js）
//   ④ 勤怠・日報・申請・経費の対象にならない … 書き込みの入口で止める（lib/stages.js isPreJoin）
//
// 署名が済んだら ①〜③ は開く（止めっぱなしにしない）。入社手続きの無い以前からの社員は止めない。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の DB（入れ子の列 "gw_procedures.employee_id" も引ける） -----------------------
const db = { rows: {} };
let seq = 0;
const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
const pick = (r, k) => String(k).split(".").reduce((o, x) => (o == null ? o : o[x]), r);
const test1 = (r, [op, k, v]) => {
  const x = pick(r, k);
  if (op === "eq") return x === v;
  if (op === "neq") return x !== v;
  if (op === "in") return v.includes(x);
  if (op === "lte") return x != null && x <= v;
  if (op === "gte") return x != null && x >= v;
  if (op === "notnull") return x != null;
  return true;
};
function table(name) {
  const f = [];
  let lim = null;
  const rows = () => {
    const out = (db.rows[name] || []).filter((r) => f.every((c) => test1(r, c)));
    return lim ? out.slice(0, lim) : out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    lte(k, v) { f.push(["lte", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    lt() { return q; }, gt() { return q; }, is() { return q; }, or() { return q; }, ilike() { return q; },
    not(k, op, v) { if (op === "is" && v === null) f.push(["notnull", k]); return q; },
    order() { return q; },
    range() { return q; },
    limit(n) { lim = n; return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn, rej) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn, rej),
    insert(row) {
      const made = [].concat(row).map((r) => ({ id: r.id || `id-${++seq}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = { select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        maybeSingle: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn, rej) => Promise.resolve({ data: made.map(copy), error: null }).then(fn, rej) };
      return r2;
    },
    upsert(row) { return q.insert(row); },
    update(patch) {
      const g = [];
      const apply = () => {
        const hit = (db.rows[name] || []).filter((r) => g.every((c) => test1(r, c)));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: hit.map(copy), error: null });
      };
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        in: (k, v) => { g.push(["in", k, v]); return r2; },
        select: () => r2,
        maybeSingle: () => apply().then((x) => ({ ...x, data: x.data[0] || null })),
        single: () => apply().then((x) => ({ ...x, data: x.data[0] || null })),
        then: (fn, rej) => apply().then(fn, rej),
      };
      return r2;
    },
    delete() { const r2 = { eq: () => r2, then: (fn) => Promise.resolve({ error: null }).then(fn) }; return r2; },
  };
  return q;
}
const storage = { from: () => ({
  createSignedUploadUrl: async () => ({ data: { signedUrl: "https://x/upload", token: "t" }, error: null }),
  createSignedUrl: async () => ({ data: { signedUrl: "https://x/view" }, error: null }),
  remove: async () => ({ error: null }),
}) };
const client = () => ({ from: table, storage, rpc: async () => ({ data: null, error: null }) });

mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
let who = null;       // gwContext の結果
let user = null;      // requireUser の結果
mock.module(atRoot("lib/auth.js"), {
  // api/me.js は、退職者も通す入口（requireUserAllowLeft）と退職者の判定（leftStateOf）を使う。この画面は在籍中の人だけを見る
  namedExports: { requireUser: async () => user, requireUserAllowLeft: async () => user, leftStateOf: async () => ({ left: false }), getMemberships: async () => [] },
});
const REAL_MFA = await import(atRoot("lib/mfa.js"));
mock.module(atRoot("lib/mfa.js"), { namedExports: { ...REAL_MFA, requireMfa: async () => true } });
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async () => ({ created: 0 }) } });

const { default: meApi } = await import(atRoot("api/me.js"));
const { openJoiners } = await import(atRoot("api/cron/escalate.js"));
const { default: onbMe } = await import(atRoot("api/onboarding/me.js"));
const { default: onbSubmit } = await import(atRoot("api/onboarding/submit.js"));
const { default: onbUpload } = await import(atRoot("api/onboarding/upload.js"));
const { default: timecardMe } = await import(atRoot("api/timecard/me.js"));
const { default: nippoApi } = await import(atRoot("api/nippo/index.js"));
const { default: requestsApi } = await import(atRoot("api/requests/index.js"));
const { default: expensesApi } = await import(atRoot("api/expenses/index.js"));
const { SCREENS } = await import(atRoot("lib/stages.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => {
  const r = res();
  await h({ headers: { authorization: "Bearer x" }, url: "/", ...req }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack?.split("\n").slice(0, 3).join("\n      ")); }
};

const jst = (n = 0) => new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
const NEW = { id: "e-new", tenant_id: "t1", user_id: "u-new", display_name: "テスト 入社予定", status: "invited",
  joined_on: jst(-1), email: "new@example.test" };
const OLD = { id: "e-old", tenant_id: "t1", user_id: "u-old", display_name: "既存 社員", status: "invited",
  joined_on: jst(-1), email: "old@example.test" };
const consentAll = () => ["pledge", "privacy", "rules"].map((k) => ({ employee_id: "e-new", kind: k, version: "1.0", agreed_at: "2026-09-10" }));
const PROC = { id: "p-new", tenant_id: "t1", employee_id: "e-new", kind: "onboarding", status: "in_progress", target_on: jst(-1), created_at: "2026-09-01" };
const itemRow = (id, owner, key) => ({ id, tenant_id: "t1", procedure_id: "p-new", owner, item_key: key, required: true, status: "todo",
  gw_procedures: { ...PROC } });

function setup({ signed = false } = {}) {
  db.rows = {
    gw_employees: [{ ...NEW }, { ...OLD }],
    gw_procedures: [{ ...PROC }],
    gw_procedure_items: [itemRow("i-id", "employee", "doc_id"), itemRow("i-bank", "employee", "doc_bank"), itemRow("i-ins", "admin", "insurance")],
    gw_doc_orders: [{ id: "o1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: signed ? "signed" : "sent", updated_at: "x" }],
    gw_sign_requests: [{ id: "s1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: signed ? "signed" : "sent", sent_at: "x" }],
    gw_onboard_consents: signed ? consentAll() : [],
    gw_onboard_profiles: [], gw_consent_docs: [], gw_role_grants: [], gw_contracts: [],
  };
}
const asNew = () => {
  const e = db.rows.gw_employees.find((x) => x.id === "e-new");
  user = { id: "u-new", email: "new@example.test" };
  who = { userId: "u-new", tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: { ...e } };
};
const status = (id) => db.rows.gw_employees.find((x) => x.id === id).status;

console.log("— ① 署名前は、入社日が来ても在籍（active）にならない —");

await ok("api/me：入社日を過ぎても、署名前なら入社準備のまま", async () => {
  setup();
  asNew();
  const r = await call(meApi, { method: "GET" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(status("e-new"), "invited");
  assert.equal(r.body.gw.stage.key, "preparing");
});

await ok("cron：署名前の人は切り替えない。手続きの無い以前からの社員は切り替える", async () => {
  setup();
  const out = await openJoiners(client());
  assert.equal(status("e-new"), "invited");
  assert.equal(status("e-old"), "active");
  assert.deepEqual(out.held, ["テスト 入社予定"]);
});

await ok("署名と誓約書がそろえば、入社日で在籍になる（止めっぱなしにしない）", async () => {
  setup({ signed: true });
  await openJoiners(client());
  assert.equal(status("e-new"), "active");
  setup({ signed: true });
  asNew();
  const r = await call(meApi, { method: "GET" });
  assert.equal(r.body.gw.stage.key, "member");
});

console.log("\n— ② 署名前は、通常業務のメニューが開かない —");

await ok("入社準備の画面だけ（勤怠・日報・申請・経費・キャリアは出ない）", async () => {
  setup();
  db.rows.gw_employees[0].joined_on = jst(30);
  asNew();
  const r = await call(meApi, { method: "GET" });
  const allowed = r.body.gw.stage.allowed;
  for (const k of ["timecard", "nippo", "requests", "expenses", "workflow", "career"]) {
    assert.equal(allowed.includes(k), false, `${k} が開いている`);
  }
  assert.ok(allowed.includes("onboarding") && allowed.includes("contracts"), "入社手続きと契約書（署名）は開いている");
});

await ok("本人の書類が（人事の操作で）そろっていても、署名前は画面を開けない", async () => {
  setup();
  db.rows.gw_employees[0].joined_on = jst(30);
  db.rows.gw_procedure_items.forEach((i) => { i.status = "done"; });
  asNew();
  let r = await call(meApi, { method: "GET" });
  assert.equal(r.body.gw.stage.unlocked, false);
  assert.equal(r.body.gw.stage.allowed.length < SCREENS.length, true);
  // 署名済みなら、これまでどおり入社日前でも開く
  setup({ signed: true });
  db.rows.gw_employees[0].joined_on = jst(30);
  db.rows.gw_procedure_items.forEach((i) => { i.status = "done"; });
  asNew();
  r = await call(meApi, { method: "GET" });
  assert.equal(r.body.gw.stage.unlocked, true);
  assert.equal(status("e-new"), "invited", "開くのは画面だけ。在籍は入社日まで変えない");
});

console.log("\n— ③ 署名前は、入社情報・必要書類を API から登録できない —");

await ok("入社情報（api/onboarding/me）・書類の提出（submit）・アップロード（upload）は 409", async () => {
  setup();
  asNew();
  const p = await call(onbMe, { method: "POST", body: { profile: { address: "東京都" } } });
  assert.equal(p.statusCode, 409, JSON.stringify(p.body));
  assert.equal(p.body.error, "contract_not_signed");
  assert.equal((db.rows.gw_onboard_profiles || []).length, 0, "何も保存していない");
  const s = await call(onbSubmit, { method: "POST", body: { itemId: "i-id" } });
  assert.equal(s.statusCode, 409);
  assert.equal(db.rows.gw_procedure_items[0].status, "todo");
  const u = await call(onbUpload, { method: "POST",
    body: { itemId: "i-id", filename: "id.pdf", mimeType: "application/pdf", sizeBytes: 1000 } });
  assert.equal(u.statusCode, 409, JSON.stringify(u.body));
  assert.equal((db.rows.gw_procedure_files || []).length, 0);
});

await ok("誓約書・同意の確認は署名前でもできる（締結の一部）", async () => {
  setup();
  asNew();
  const r = await call(onbMe, { method: "POST", body: { consents: [] } });
  assert.notEqual(r.body?.error, "contract_not_signed");
});

await ok("署名後は、入社情報・書類の提出ができる", async () => {
  setup({ signed: true });
  asNew();
  const s = await call(onbSubmit, { method: "POST", body: { itemId: "i-id" } });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  assert.equal(db.rows.gw_procedure_items[0].status, "submitted");
  const u = await call(onbUpload, { method: "POST",
    body: { itemId: "i-bank", filename: "bank.pdf", mimeType: "application/pdf", sizeBytes: 1000 } });
  assert.notEqual(u.body?.error, "contract_not_signed");
});

console.log("\n— ④ 入社前は、勤怠・日報・申請・経費の対象にならない —");

for (const [label, h, body] of [
  ["打刻（api/timecard/me）", timecardMe, { action: "in" }],
  ["日報（api/nippo）", nippoApi, { date: jst(0), body: "テスト" }],
  ["申請（api/requests）", requestsApi, { type: "leave", title: "休暇" }],
  ["経費（api/expenses）", expensesApi, { title: "交通費", amount: 100 }],
]) {
  await ok(`${label}：入社準備中は 403 not_joined、在籍なら止めない`, async () => {
    setup({ signed: true });
    asNew();
    const r = await call(h, { method: "POST", body });
    assert.equal(r.statusCode, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "not_joined");
    who.employee.status = "active";
    const r2 = await call(h, { method: "POST", body });
    assert.notEqual(r2.body?.error, "not_joined");
  });
}

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
