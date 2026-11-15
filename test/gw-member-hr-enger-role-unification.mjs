import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const ui=readFileSync(new URL("../admin-members.html",import.meta.url),"utf8");
const agent=readFileSync(new URL("../js/enger-agent-users.js",import.meta.url),"utf8");
const employee=readFileSync(new URL("../api/employees/index.js",import.meta.url),"utf8");

test("member classification uses HR storage values, not ENGER as an employment category",()=>{
  assert.match(ui,/id="mb-category-tabs"/);
  assert.match(ui,/data-category="full"/);
  assert.match(ui,/data-category="fixed"/);
  assert.match(ui,/data-category="part"/);
  assert.match(ui,/data-category="outsourced"/);
  assert.match(ui,/data-category="spot"/);
  assert.match(ui,/full:\["正社員"\], fixed:\["契約社員"\], part:\["パート","アルバイト"\]/);
  assert.match(ui,/spot:\[\]/);
  assert.match(ui,/employmentLabel\(e\.employment_type\)/);
  assert.match(ui,/id="tab-agents"[^>]+setView\('agents'\)/);
  assert.match(ui,/id="tab-guests"[^>]+setView\('guests'\)/);
});

test("members use full width and existing checkbox selection with guarded bulk updates",()=>{
  assert.match(ui,/body > \.wrap \{ max-width:none; width:100%/);
  assert.match(ui,/id="sel-page"/);
  assert.match(ui,/data-select=/);
  assert.match(ui,/id="mb-update"/);
  assert.match(ui,/data-act="bulk-update"/);
  assert.match(ui,/selectedUpdateTargets\(/);
  assert.match(ui,/mb-update-agree/);
  assert.match(ui,/API\.updateEmployee\(\{id:e\.id,\[field\]:value\}\)/);
  assert.match(ui,/部署名で役割を表すことはできません/);
  const bulk=ui.split("async function runBulkUpdate")[1]?.split("// ---- 詳細の窓")[0] || "";
  assert.doesNotMatch(bulk,/API\.setEmployeeApp\(/);
});

test("agent role remains distinct from employment and can be accessed from matching member detail",()=>{
  assert.match(ui,/openAgentMember\('/);
  assert.match(ui,/canEdit&&e\.user_id\?`<button[^`]*openAgentMember\('\$\{id\}'\)">ENGER営業の役割/);
  assert.doesNotMatch(ui,/e\.department==="ENGERエージェント"/);
  assert.match(agent,/action:"grant_role",employeeId:id,confirm:true/);
  assert.match(agent,/openEmployee:async\(employeeId,person=/);
  assert.match(agent,/edit\(employeeId,\{employeeId,name:person\.name/);
  assert.match(ui,/id="ag-select-all"/);
  assert.match(ui,/id="ag-bulk-disable"/);
  assert.match(agent,/selectedIds:new Set\(/);
  assert.match(agent,/companyIds:\[\],contractConfirmed:false,ndaConfirmed:false/);
  assert.doesNotMatch(agent,/localStorage|sessionStorage/);
});

test("retirement closes ENGER permissions for anyone with a login and deletion refuses orphaning membership or sales history",()=>{
  const role=readFileSync(new URL("../lib/enger-agent-role.js",import.meta.url),"utf8");
  assert.match(role,/export async function revokeAgentAccess/);
  assert.match(employee,/if\(row\.value\.status==="left"&&before\?\.user_id\)\{\s*try \{ await revokeAgentAccess\(sbAdmin0,before\.user_id\); \}/);
  assert.doesNotMatch(employee,/AGENT_DEPT|department===/);
  assert.match(employee,/error:"enger_revoke_failed"/);
  assert.match(employee,/error:"enger_membership_exists"/);
  assert.match(employee,/table: "gw_sales_deals",\s+column: "owner_id"/);
  assert.match(employee,/table: "gw_sales_meetings",\s+column: "owner_id"/);
  assert.match(employee,/table: "gw_sales_approaches", column: "employee_id"/);
  assert.match(employee,/\(t\.server \? admin\(\) : sb\)/);
  assert.match(employee,/action:"employee\.profile_update"/);
});

test("client-side script parses without executing or mutating records",()=>{
  const scripts=[...ui.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean);
  for(const source of scripts)assert.doesNotThrow(()=>new Function(source));
  assert.doesNotThrow(()=>new Function(agent));
});
