// 休暇が「Office承認待ち → KEIEI承認待ち → 承認済み」を通るための回帰テスト。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);
const read = (p) => readFileSync(atRoot(p),"utf8");

const rows = [
  { days:1, status:"approved",leave_type:"paid" },
  { days:1, status:"pending",leave_type:"paid" },
  { days:0.5, status:"pending_owner",leave_type:"am" },
  { days:2, status:"rejected",leave_type:"paid" },
  { days:2, status:"approved",leave_type:"absence" },
];
function sbTable(table) {
  const q = {
    select(){return q;},eq(){return q;},in(){return q;},gte(){return q;},lte(){return q;},
    maybeSingle(){return Promise.resolve({data: table === "gw_leave_grants" ? {granted_days:10,carried_days:1} : null});},
    then(ok,err){return Promise.resolve({data:table === "gw_requests" ? rows : []}).then(ok,err);},
  };
  return q;
}
mock.module(atRoot("lib/supabase.js"),{namedExports:{admin:()=>({from:sbTable})}});
const { nextStatusFor, leaveBalance } = await import(atRoot("lib/requests.js"));

assert.equal(nextStatusFor("leave"),"pending_owner","休暇のOffice一次承認は最終承認待ちへ");
assert.equal(nextStatusFor("ringi"),"pending_owner","稟議も2段階のまま");
const balance = await leaveBalance("employee-1",2026);
assert.equal(balance.granted,11);
assert.equal(balance.taken,1,"最終承認済みだけ取得済みに数える");
assert.equal(balance.pending,1.5,"OfficeとKEIEIの承認待ち両方を集計");
assert.equal(balance.remaining,8.5,"最終承認待ちの間も残日数を確保");

const index = read("api/requests/index.js");
assert.match(index,/\.in\("status", \["pending", "pending_owner", "approved"\]\)/,"二重申請防止も2段階に対応");
assert.match(index,/twoStage: true/);
const office = read("admin-requests.html");
assert.match(office,/status === "pending"\);/,"Officeが一次承認だけ扱う");
assert.ok(!office.includes('alert("申請は処理しましたが、カレンダーへの反映に失敗しました。'),"内部のGoogleエラーでアラートを出さない");
const member = read("requests.html");
assert.match(member,/Officeの一次承認/);
const keiei = read("keiei/index.html");
assert.match(keiei,/view === "requests"/);
const menu = read("js/layout.js");
assert.match(menu,/view: "requests", label: "休暇・稟議の最終承認"/);
const finalPage = read("keiei/requests.js");
assert.match(finalPage,/data-action="approve"/);
assert.match(finalPage,/data-action="retry"/);
console.log("有給二段階の残日数・重複防止・申請/Office/KEIEI導線：通過");
