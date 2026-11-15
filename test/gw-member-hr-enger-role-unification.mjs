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
  assert.match(ui,/ENGERエージェント.*?個別の利用設定/s);
  assert.doesNotMatch(ui,/runBulkUpdate[\s\S]*?API\.setEmployeeApp\(/);
});

test("agent role remains distinct from employment and can be accessed from matching member detail",()=>{
  assert.match(ui,/openAgentMember\('/);
  assert.match(ui,/e\.department==="ENGERエージェント"&&canEdit/);
  assert.match(agent,/openEmployee:async employeeId/);
  assert.match(agent,/if\(!state\.agents\.some\(/);
  assert.match(ui,/id="ag-select-all"/);
  assert.match(ui,/id="ag-bulk-disable"/);
  assert.match(agent,/state\.selectedIds=new Set\(/);
  assert.match(agent,/companyIds:\[\],contractConfirmed:false,ndaConfirmed:false/);
  assert.doesNotMatch(agent,/localStorage|sessionStorage/);
});

test("retirement closes ENGER permissions before modifying the employee and deletion refuses orphaning membership",()=>{
  assert.match(employee,/async function revokeAgentBeforeExit/);
  assert.match(employee,/can_view:false,can_create:false,can_edit:false,can_approve:false,can_export:false,can_manage:false/);
  assert.match(employee,/scope_type","company"/);
  assert.match(employee,/status:"inactive"/);
  assert.match(employee,/if\(row\.value\.status==="left"&&before\?\.department===AGENT_DEPT/);
  assert.match(employee,/error:"enger_revoke_failed"/);
  assert.match(employee,/error:"enger_membership_exists"/);
  assert.match(employee,/action:"employee\.profile_update"/);
});

test("client-side script parses without executing or mutating records",()=>{
  const scripts=[...ui.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean);
  for(const source of scripts)assert.doesNotThrow(()=>new Function(source));
  assert.doesNotThrow(()=>new Function(agent));
});
