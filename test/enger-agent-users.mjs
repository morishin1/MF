import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const api=readFileSync(new URL('../api/enger/agent-users.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../admin-members.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../js/enger-agent-users.js',import.meta.url),'utf8');
const role=readFileSync(new URL('../lib/enger-agent-role.js',import.meta.url),'utf8');

test('agent management is under existing GW members, not a duplicate administration screen',()=>{
  assert.match(ui,/id="tab-agents"[^>]+setView\('agents'\)/);
  assert.match(ui,/id="view-agents" class="hidden"/);
  assert.match(ui,/id="ag-create-form" hidden/);
  assert.match(ui,/id="ag-detail" hidden/);
  assert.match(ui,/js\/enger-agent-users\.js/);
  assert.match(ui,/window\.EngerAgentUsers\?\.load\(\)/);
  assert.match(ui,/id="ag-company-query"/);
});

test('new users are created with one-time credentials and no implicit access',()=>{
  assert.match(api,/auth\.admin\.createUser\(/);
  assert.match(api,/email_confirm:true/);
  assert.match(api,/app_metadata:\{apps:\["partner_sales"\]\}/);
  assert.doesNotMatch(api,/app_metadata:\{apps:\["business"\]\}/);
  assert.match(api,/initialPassword:password/);
  assert.match(api,/membership_type:"external",role:"member",status:"inactive"/);
  assert.match(api,/department,position,work_location:workLocation,joined_on:joinedOn,\s*employment_type:body\.employmentType,status:"active"/);
  assert.doesNotMatch(api,/department:DEPT/);
  assert.match(api,/["']partner_sales["']/);
  assert.doesNotMatch(api,/product:\s*["']sales["']/);
  assert.doesNotMatch(api,/user_metadata.*can_view/);
  assert.doesNotMatch(api,/console\.(?:log|info|error)\([^)]*password/i);
  assert.match(api,/Cache-Control","private, no-store"/);
});

test('only MFA-verified HR managers can create, assign or disable agent scope',()=>{
  assert.match(api,/requireUser\(req,res\)/);
  assert.match(api,/canManageHr\(ctx\)/);
  assert.match(api,/requireMfa\(req,res,ctx,user\)/);
  assert.match(api,/tenant_id",ctx\.tenantId/);
  assert.match(api,/UUID\.test\(employeeId/);
  assert.match(api,/isAgentMembership\(member\)/);
  assert.match(role,/m\.membership_type === "external" && m\.role === "member"/);
  assert.match(role,/!m\.organization_id && !m\.partner_organization_id/);
  assert.match(api,/contractConfirmed!==true\|\|body\?\.ndaConfirmed!==true/);
});

test('company permission is explicit, tenant scoped and closed before reassignments',()=>{
  assert.match(api,/MAX_COMPANIES=20/);
  assert.match(api,/new Set\(x\)\.size===x\.length/);
  assert.match(api,/dx2_sales_company_directory_for_tenant/);
  assert.match(api,/needs_contact_review\|\|x\.directory_hidden_at/);
  assert.match(api,/scope_type:"company",scope_id:id/);
  assert.match(api,/\.eq\("membership_id",member\.id\)\.eq\("scope_type","company"\)/);
  assert.match(role,/can_view: false, can_create: false, can_edit: false,\s*can_approve: false, can_export: false, can_manage: false/);
  assert.match(api,/update\(\{\.\.\.CLOSED_ACCESS\}\)/);
  assert.match(api,/if\(enable\)\{/);
  assert.match(api,/\.update\(\{can_view:true\}\)/);
});

test('agent profile updates and company search use the same secured API',()=>{
  assert.match(js,/API\.api\(/);
  assert.match(js,/\/api\/enger\/agent-users\?companyQuery=/);
  assert.match(js,/"POST"/);
  assert.match(js,/"PATCH"/);
  assert.match(js,/id=\"ag-create-email\"|el\("ag-create-email"\)/);
  assert.match(js,/contractConfirmed:enabled&&el\("ag-contract-confirm"\)\.checked/);
  assert.match(js,/ndaConfirmed:enabled&&el\("ag-nda-confirm"\)\.checked/);
  assert.match(js,/companyIds:\[\.\.\.state\.companyIds\]/);
  assert.match(js,/id="ag-first-password"|el\("ag-first-password"\)/);
  assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML\s*=/);
});

test('company names are restored for existing assignments, without exposing other tenant data',()=>{
  assert.match(api,/companyNames=Object\.fromEntries/);
  assert.match(api,/\.eq\("tenant_id",ctx\.tenantId\)/);
  assert.match(api,/companyNames,loginStatus:LOGIN_STATUS,agents:agents\.map/);
  assert.match(js,/state\.names=data\.companyNames\|\|\{\}/);
});

test('agent script parses',()=>{
  assert.doesNotThrow(()=>new Function(js));
});

test('agent display name can be updated without changing the auth email or other business roles',()=>{
  assert.match(ui,/id="ag-edit-name"/);
  assert.match(js,/const displayName=el\("ag-edit-name"\)\.value\.trim\(\)/);
  assert.match(js,/action:"update_name",employeeId:state\.selected\.employeeId,displayName/);
  assert.match(api,/\.update\(\{display_name:displayName\}\)/);
  assert.match(api,/\.eq\("tenant_id",ctx\.tenantId\)\.eq\("id",employeeId\)/);
  assert.doesNotMatch(api,/auth\.admin\.updateUserById\(emp\.user_id,\{email/);
});

test('incomplete agent provisioning can be repaired by re-granting the role without upgrading internal users',()=>{
  assert.match(api,/async function grantRole\(sb,userId\)/);
  assert.match(api,/if\(member&&!isAgentMembership\(member\)\)return \{ok:false,error:"membership_conflict"\}/);
  assert.match(api,/membership_type:"external",role:"member",status:"inactive"/);
  assert.match(api,/ignoreDuplicates:true/);
  assert.match(api,/action:"enger\.agent_create_partial"/);
  assert.match(api,/if\(disable\.error\)return dbError/);
});

test('profile-only name update preserves ENGER assignment and avoids grant modifications',()=>{
  assert.match(ui,/id="ag-name-save"/);
  assert.match(js,/action:"update_name",employeeId:state\.selected\.employeeId,displayName/);
  assert.match(api,/if\(body\?\.action==="update_name"\)/);
  assert.match(api,/action:"enger\.agent_profile_update"/);
  assert.match(api,/return json\(res,200,\{ok:true,employeeId,displayName\}\)/);
});

test('revocation works for a departed agent or a newly blocked company',()=>{
  assert.match(api,/if\(enable&&\(emp\.status!=="active"\|\|emp\.left_on\)\)/);
  assert.match(api,/const dir=await safeDirectory/);
  assert.match(api,/const assignedCompanyIds=enable\?ids:\[\]/);
  assert.match(api,/companyIds:assignedCompanyIds/);
  assert.match(api,/\.\.\.CLOSED_ACCESS/);
});

test('password reissue uses the single shared GW login, never a second agent-only reset',()=>{
  assert.match(ui,/id="ag-password-reset"/);
  assert.match(ui,/function openAgentAccount\(employeeId\)/);
  assert.match(js,/window\.openAgentAccount\(id\)/);
  assert.doesNotMatch(js,/action:"reset_password"/);
  assert.match(api,/if\(body\?\.action==="reset_password"\)\s*return fail\(res,410,"use_member_account"/);
  // 既存Authへの partner_sales マーカー同期は必要。ここではPW再発行だけを禁止する。
  assert.match(api,/updateUserById\(emp\.user_id,\{\s*app_metadata:/);
  assert.doesNotMatch(api,/updateUserById\([^,]+,\s*\{\s*password:/);
  assert.doesNotMatch(api,/detail:\{password/);
  assert.doesNotMatch(js,/enger\.jp\/business\/login/);
});
