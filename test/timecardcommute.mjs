// node --experimental-test-module-mocks test/timecardcommute.mjs
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { canOfficeHr, isLaborAdvisor, isTaxAdvisor } from "../lib/gw.js";
import { claimValid } from "../lib/timecard-commute.js";

const moduleAt = p => fileURLToPath(new URL("../lib/" + p + ".js", import.meta.url));
const id = n => "00000000-0000-4000-8000-" + String(n).padStart(12,"0");
const base = { tenantId: id(1), roles: [], apps: [], employee: { id: id(2), status: "active" } };
let ctx = base, made = [], result = {}, databaseError = null, mfa = true;
mock.module(moduleAt("gw"), { namedExports: { gwContext: async () => ctx, canOfficeHr, isLaborAdvisor, isTaxAdvisor } });
mock.module(moduleAt("auth"), { namedExports: { requireUser: async () => ({ id: id(3) }) } });
mock.module(moduleAt("supabase"), { namedExports: { admin: () => ({
  rpc: async (name, args) => { made.push({ name, args }); return { data: result, error: databaseError }; },
}) } });
mock.module(moduleAt("mfa"), { namedExports: { requireMfa: async (_req,res) => {
  if (!mfa) { res.statusCode=403; res.end("{}"); } return mfa;
} } });
mock.module(moduleAt("gw-audit"), { namedExports: { gwLog: async () => {} } });
let audit = [];
mock.module(moduleAt("sensitive-log"), { namedExports: { logSensitiveMany: async (_, ids) => { audit = ids; } } });
const { default: handler } = await import("../api/timecard/commute.js");
async function call(scope, opts = {}) {
  const req = { url: "/api/timecard/commute?" + new URLSearchParams({ scope, month: opts.month ?? "2024-02",
    ...(opts.csv ? { format: "csv" } : {}) }), method: opts.body ? "PATCH" : "GET", body: opts.body, headers: {} };
  const res = { statusCode: 200, headers: {}, setHeader(k,v) { this.headers[k]=v; }, end(s) { this.text=s; } };
  made=[];
  await handler(req,res);
  return res;
}
const claim = { method:"actual", route:"A駅 → B駅", rate:600, dates:["2024-02-29"], version:"a".repeat(32) };
assert(claimValid(claim,"2024-02"));
for (const patch of [{ rate:-1 }, { rate:0 }, { rate:1.1 }, { method:"pass" }, { dates:["2024-02-30"] },
  { dates:["2024-02-29","2024-02-29"] }, { dates:["2024-03-01"] }, { version:"" }]) {
  assert(!claimValid({ ...claim, ...patch },"2024-02"));
}
assert.equal((await call("me")).statusCode,200);
assert.equal(made[0].args.p_employee,base.employee.id);
assert.equal((await call("me",{body:{ ...claim,employeeId:id(9) }})).statusCode,403);
assert.equal((await call("office")).statusCode,403);
assert.equal((await call("me",{csv:true})).statusCode,403);
assert.equal((await call("me",{body:{ ...claim,advisorId:id(15),reviewed:true }})).statusCode,200);
assert.equal(made[0].args.p_review,false); assert.equal(made[0].args.p_advisor,null);
assert.equal((await call("me",{month:"2024-13"})).statusCode,400);
ctx={ ...base, roles:["hr"],apps:["office"] };
assert.equal((await call("office",{body:{ ...claim,employeeId:id(4),advisorId:id(5) }})).statusCode,200);
assert.equal(made[0].args.p_review,true); assert.equal(made[0].args.p_tenant,id(1));
databaseError={ message:"commute_stale" };
assert.equal((await call("office",{body:{ ...claim,employeeId:id(4) }})).statusCode,409);
databaseError=null;
ctx={ ...base,roles:["labor_advisor"] };
assert.equal((await call("advisor")).statusCode,403);
assert.equal((await call("office")).statusCode,403);
assert.equal((await call("advisor",{body:claim,csv:true})).statusCode,403);
result=null;
assert.equal((await call("advisor",{csv:true})).statusCode,409);
result=[{ employee_id:id(4), code:"A01", name:"=架空", workDays:1, workMinutes:480,
  method:"none", commuteDays:0, amount:0, route:"個人の経路" }];
const exported=await call("advisor",{csv:true});
assert.equal(exported.statusCode,200); assert.equal(made[0].args.p_advisor,ctx.employee.id);
assert.match(exported.text,/8:00/); assert.match(exported.text,/"'=架空"/); assert.match(exported.text,/"0","0"/);
assert(!exported.text.includes("個人の経路")); assert.deepEqual(audit,[id(4)]);
mfa=false;
assert.equal((await call("advisor",{csv:true})).statusCode,403); assert.equal(made.length,0);
ctx={ ...base, roles:["tax_advisor"],isAdmin:true }; mfa=true;
assert.equal((await call("advisor",{csv:true})).statusCode,403);
assert.equal((await call("office",{csv:true})).statusCode,403);
console.log("通勤費API：入力、本人・Office・社労士の権限、競合、確定CSVを確認");
