import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const page=read("admin-members.html"), agent=read("api/enger/agent-users.js"), reset=read("api/employees/account.js");
const ui=read("js/enger-agent-users.js");
test("メンバー追加で業務委託・アルバイト・パートのENGER営業役割を選べる",()=>{
  assert.match(page,/id="e-type" onchange="syncAgentAddOption\(\)"/);
  assert.match(page,/id="e-agent-role" type="checkbox"/);
  assert.match(page,/function syncAgentAddOption\(\)/);
  assert.match(page,/\["業務委託","アルバイト","パート"\]\.includes\(el\("e-type"\)\.value\)/);
  assert.match(page,/el\("e-agent-role"\)\.checked=false/);
  assert.match(page,/!editingId&&\["業務委託","アルバイト","パート"\]/);
});
test("名簿追加の通常ルートは維持し、ENGER選択時のみ専用APIを呼ぶ",()=>{
  assert.match(page,/const agentRegistration = !editingId && el\("e-agent-role"\)\.checked/);
  assert.match(page,/else if\(agentRegistration\)/);
  assert.match(page,/API\.api\("\/api\/enger\/agent-users",\{/);
  assert.match(page,/method:"POST",body:/);
  assert.match(page,/position:fields\.position/);
  assert.match(page,/workLocation:fields\.work_location/);
  assert.match(page,/showAccountResult\(\{ok:true,createdPassword:res\.initialPassword/);
  assert.match(page,/API\.createEmployee\(\{ \.\.\.fields, status: "invited" \}\)/);
  assert.match(page,/if\(kindReady&&fields\.employee_kind==="bp"\)/);
});
test("エージェント専用フォームの追加ボタンは共通メンバー追加に戻る",()=>{
  assert.match(page,/window\.openAgentAdd=openAgentAdd/);
  assert.match(page,/function openAgentAdd\(\)/);
  assert.match(ui,/window\.openAgentAdd\(\)/);
  assert.match(ui,/refresh:\(\)=>load\(true\)/);
});
test("管理者が一覧から直接PW再設定へ進めるが経営者の保護は残す",()=>{
  assert.match(page,/data-role="row-password"/);
  assert.match(page,/canManage&&e\.user_id&&!lockedOwner/);
  assert.match(page,/onclick="openAccount\('/);
  assert.match(page,/if \(!e\|\|!canManage\|\|!e\.user_id/);
  assert.match(page,/id="ac-pw" type="password" autocomplete="new-password"/);
  assert.match(page,/API\.updateEmployeeAccount\(/);
  assert.match(reset,/requireMfa\(req, res, ctx, user\)/);
  assert.match(reset,/guardOwnerTarget\(sb, ctx, emp\.id/);
  assert.match(reset,/action: "account\.password_reset"/);
  assert.doesNotMatch(reset,/detail: \{[^}]*password: pw/);
});
test("共通フォームの他の欄もエージェント作成時に保存",()=>{
  assert.match(agent,/const position=clean\(body\?\.position,80\)\|\|null/);
  assert.match(agent,/const workLocation=clean\(body\?\.workLocation,100\)\|\|null/);
  assert.match(agent,/const joinedOn=clean\(body\?\.joinedOn,10\)\|\|null/);
  assert.match(agent,/department,position,work_location:workLocation,joined_on:joinedOn/);
  assert.match(agent,/app_metadata:\{apps:\["partner_sales"\]\}/);
  assert.match(agent,/status:"active"/);
  assert.match(agent,/initialPassword:password/);
  assert.match(agent,/grantRole\(sb,userId\)/);
});
test("inline scripts of unified member page can parse",()=>{
  for(const [,script] of page.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)){
    if(!script.trim())continue;
    assert.doesNotThrow(()=>new Function(script));
  }
});
