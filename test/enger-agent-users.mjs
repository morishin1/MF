import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const api=readFileSync(new URL('../api/enger/agent-users.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../admin-members.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../js/enger-agent-users.js',import.meta.url),'utf8');

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
  assert.match(api,/department:DEPT,employment_type:body\.employmentType,status:"active"/);
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
  assert.match(api,/member\.membership_type!=="external"/);
  assert.match(api,/organization_id\|\|member\.partner_organization_id/);
  assert.match(api,/contractConfirmed!==true\|\|body\?\.ndaConfirmed!==true/);
});

test('company permission is explicit, tenant scoped and closed before reassignments',()=>{
  assert.match(api,/MAX_COMPANIES=20/);
  assert.match(api,/new Set\(x\)\.size===x\.length/);
  assert.match(api,/dx2_sales_company_directory_for_tenant/);
  assert.match(api,/needs_contact_review\|\|x\.directory_hidden_at/);
  assert.match(api,/scope_type:"company",scope_id:id/);
  assert.match(api,/\.eq\("membership_id",member\.id\)\.eq\("scope_type","company"\)/);
  assert.match(api,/can_view:false,can_create:false,can_edit:false,can_approve:false,can_export:false,can_manage:false/);
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
  assert.match(api,/companyNames,agents:employees\.map/);
  assert.match(js,/state\.names=data\.companyNames\|\|\{\}/);
});

test('agent script parses',()=>{
  assert.doesNotThrow(()=>new Function(js));
});
