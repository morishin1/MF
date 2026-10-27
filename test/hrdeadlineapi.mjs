// HR: 明示的な現在処理完了・期限引継ぎ。実データ/外部送信なし、APIとDBはメモリモック。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);

const db = { rows: {} };
const logged = [];
let notifications = 0, authenticated = true, beforeWrite = null;
const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
const test1 = (x, [op, k, v]) => (op === "eq" ? x[k] === v : op === "neq" ? x[k] !== v
  : op === "in" ? v.includes(x[k]) : op === "is" ? (x[k] ?? null) === v : true);
function table(name) {
  const f = [];
  let lim = null;
  const rows = () => { const o = (db.rows[name] || []).filter((x) => f.every((c) => test1(x, c))); return lim ? o.slice(0, lim) : o; };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order() { return q; },
    limit(n) { lim = n; return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({ id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: new Date().toISOString(), ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = { select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn) };
      return r2;
    },
    update(patch) {
      const g = [];
      const apply = () => {
        if (beforeWrite) { const fn = beforeWrite; beforeWrite = null; fn(); }
        const hit = (db.rows[name] || []).filter((x) => g.every((c) => test1(x, c)));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]) || null, error: null });
      };
      const r2 = { eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        is: (k, v) => { g.push(["is", k, v]); return r2; }, select: () => r2,
        single: apply, maybeSingle: apply, then: (fn) => apply().then(fn) };
      return r2;
    },
  };
  return q;
}
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => { notifications += rows.length; return { created: rows.length }; } } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async (_req, res) => { if (authenticated) return { id: who.userId }; res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized" })); return null; }, getMemberships: async () => [] } });
const REAL_GW = await import(atRoot("lib/gw.js"));
const RECRUITER = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["recruiter"], employee: { id: "e-hr" } };
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, roles: ["owner"], employee: { id: "e-owner" } };
let who = RECRUITER;
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));

const res = () => { const r = { statusCode: 0, body: null }; r.setHeader = () => {}; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const H = { authorization: "Bearer x" };
const call = async (fn, req) => { const r = res(); await fn({ headers: H, ...req }, r); return r; };
const patchDetail = (body) => call(detailApi, { method: "PATCH", url: "/api/hr/applicants/detail", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};


function setup() {
  who = RECRUITER; authenticated = true; beforeWrite = null; notifications = 0; logged.length = 0;
  db.rows = { gw_hr_applicants: [{ id: "a1", tenant_id: "t1", name: "架空候補者", stage: "casual_interview",
    status: "scheduling", decision_due_on: "2020-01-01", note: "社内メモ", recruiter_id: "e1", employee_id: null }],
    gw_hr_interviews: [], gw_hr_timeline: [] };
}
const app = () => db.rows.gw_hr_applicants[0];
const complete = (extra = {}) => ({ id: "a1", action: "setStatus", status: "interview_scheduled", acknowledgeWarnings: true,
  completeCurrentAction: true, expectedStatus: "scheduling", expectedDecisionDueOn: "2020-01-01", nextDecisionDueOn: null, ...extra });
const noWrite = (before) => { assert.deepEqual(db.rows, before); assert.equal(logged.length, 0); assert.equal(notifications, 0); };

await ok("明示完了で旧期限を解除し、状態以外の情報・面談・担当・メモは維持", async () => {
  setup(); const r = await patchDetail(complete());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.applicant.overdue, false);
  assert.equal(app().decision_due_on, null); assert.equal(app().note, "社内メモ"); assert.equal(app().recruiter_id, "e1");
  assert.equal(app().stage, "casual_interview"); assert.equal(db.rows.gw_hr_interviews.length, 0);
  assert.match(db.rows.gw_hr_timeline[0].detail, /2020-01-01 → 未設定/);
  assert.equal(logged[0].detail.completeCurrentAction, true); assert.equal(notifications, 0);
});
for (const [due, over] of [["2099-01-01", false], ["2020-02-01", true]]) await ok(`新期限 ${due} の期限超過は ${over}`, async () => {
  setup(); const r = await patchDetail(complete({ nextDecisionDueOn: due }));
  assert.equal(r.statusCode, 200); assert.equal(r.body.applicant.overdue, over); assert.equal(app().decision_due_on, due);
});
for (const flag of [undefined, false]) await ok(`完了 ${flag} の通常状態変更は旧期限維持`, async () => {
  setup(); const r = await patchDetail({ id: "a1", action: "setStatus", status: "eval_pending", acknowledgeWarnings: true, completeCurrentAction: flag });
  assert.equal(r.statusCode, 200); assert.equal(r.body.applicant.overdue, true); assert.equal(app().decision_due_on, "2020-01-01");
});
await ok("dryRun は期限変更も書込も送信もしない", async () => {
  setup(); const before = copy(db.rows); const r = await patchDetail(complete({ dryRun: true }));
  assert.equal(r.statusCode, 200); assert.equal(r.body.dryRun, true); assert.ok(r.body.warnings.length); noWrite(before);
});
await ok("警告未承認は完了操作でも409", async () => {
  setup(); const before = copy(db.rows); const r = await patchDetail(complete({ acknowledgeWarnings: false }));
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "status_change_warning"); noWrite(before);
});
for (const extra of [{expectedStatus:"todo"}, {expectedDecisionDueOn:"2020-02-01"}]) await ok(`期待値違い ${JSON.stringify(extra)} は stale`, async () => {
  setup(); const before = copy(db.rows); const r = await patchDetail(complete(extra));
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "stale"); noWrite(before);
});
for (const mutation of [{status:"todo"}, {decision_due_on:"2020-02-01"}, {employee_id:"employee-new"}]) await ok(`読取後競合 ${JSON.stringify(mutation)} は原子的に拒否`, async () => {
  setup(); beforeWrite = () => Object.assign(app(), mutation); const r = await patchDetail(complete());
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "stale");
  assert.equal(app().status, mutation.status || "scheduling"); assert.equal(app().decision_due_on, mutation.decision_due_on || "2020-01-01");
  assert.equal(logged.length, 0); assert.equal(db.rows.gw_hr_timeline.length, 0); assert.equal(notifications, 0);
});
await ok("現在期限nullにも is-null 比較で対応", async () => {
  setup(); app().decision_due_on = null; const r = await patchDetail(complete({expectedDecisionDueOn:null,nextDecisionDueOn:"2028-02-29"}));
  assert.equal(r.statusCode, 200); assert.equal(app().decision_due_on, "2028-02-29");
});
for (const due of ["2026-02-29", "2026-13-01", "2026-1-01", "0000-01-01", "2026-01-01T00:00:00Z", "", 123, undefined]) await ok(`不正次期限 ${JSON.stringify(due)} を拒否`, async () => {
  setup(); const before = copy(db.rows); const r = await patchDetail(complete({nextDecisionDueOn:due}));
  assert.equal(r.statusCode, 400); noWrite(before);
});
await ok("完了falseで期限を消そうとすると400", async () => {
  setup(); const before = copy(db.rows); const r = await patchDetail(complete({completeCurrentAction:false})); assert.equal(r.statusCode, 400); noWrite(before);
});
for (const state of ["accepted", "done"]) await ok(`${state} から完了操作は不可`, async () => {
  setup(); app().status=state; const before = copy(db.rows); const r = await patchDetail(complete({expectedStatus:state})); assert.equal(r.statusCode,409); noWrite(before);
});
await ok("社員登録済みは不可", async () => { setup(); app().employee_id="e2"; const before=copy(db.rows); const r=await patchDetail(complete()); assert.equal(r.statusCode,409); noWrite(before); });
await ok("別tenant対象は404で一切変更なし", async () => { setup(); app().tenant_id="t2"; const before=copy(db.rows); const r=await patchDetail(complete()); assert.equal(r.statusCode,404); noWrite(before); });
await ok("未認証は401で一切変更なし", async () => { setup(); authenticated=false; const before=copy(db.rows); const r=await patchDetail(complete()); assert.equal(r.statusCode,401); noWrite(before); });
await ok("採用権限なしは403", async () => { setup(); who={userId:"u-x",tenantId:"t1",roles:[],isAdmin:false}; const before=copy(db.rows); const r=await patchDetail(complete()); assert.equal(r.statusCode,403); noWrite(before); });
await ok("社長判断に進める既存権限検査を維持", async () => { setup(); const before=copy(db.rows); const r=await patchDetail(complete({status:"ceo_decision_pending"})); assert.equal(r.statusCode,403); noWrite(before); });
for (const extra of [{status:"accepted"},{status:"done"},{completeCurrentAction:"true"},{expectedDecisionDueOn:"2026-02-30"},{expectedStatus:undefined}]) await ok(`追加入力/進行制限 ${JSON.stringify(extra)}`, async () => {
  setup(); const before=copy(db.rows); const r=await patchDetail(complete(extra)); assert.ok([400,409].includes(r.statusCode)); noWrite(before);
});
await ok("dryRun でも期待期限不一致を拒否", async () => { setup(); const before=copy(db.rows); const r=await patchDetail(complete({dryRun:true,expectedDecisionDueOn:null})); assert.equal(r.statusCode,409); noWrite(before); });
await ok("null期限読取後の同時更新も拒否", async () => {
  setup(); app().decision_due_on=null; beforeWrite=()=>{app().decision_due_on="2028-01-01";};
  const r=await patchDetail(complete({expectedDecisionDueOn:null})); assert.equal(r.statusCode,409); assert.equal(app().decision_due_on,"2028-01-01"); assert.equal(app().status,"scheduling"); assert.equal(logged.length,0);
});
console.log(`期限完了 ${pass + fail} 件中 ${pass} 件 通過`);
process.exitCode = fail ? 1 : 0;
