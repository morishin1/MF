import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const get=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const page=get('../js/sales-company-portal-tabs.js');
const status=get('../api/sales/company-workflow-status.js');
const route=get('../api/sales/company-ai-single.js');
const pilot=get('../api/sales/company-ai-pilot.js');
const research=get('../lib/sales-company-ai-pilot.js');
const link=get('../lib/sales-company-ai-link.js');

test('one company can start AI without ten-company trial batch flag',()=>{
  assert.match(page,/\/api\/sales\/company-ai-single/);
  assert.match(page,/body:\{companyId:id\}/);
  assert.match(page,/progress\?\.single\?\.canRun/);
  assert.doesNotMatch(page,/api\/sales\/company-ai-batch/);
  assert.match(status,/const single=\{/);
  assert.match(status,/eligible:readyForResearch,canRun:canSell\(ctx\)&&readyForResearch/);
  assert.match(route,/canSell\(ctx\)/);
  assert.doesNotMatch(route,/isOwner\(ctx\)/);
  assert.match(route,/companyInScope\(admin\(\),ctx\.tenantId,companyId\)/);
  assert.match(route,/canAccessEightEngerDirectory\(ctx\)/);
  assert.match(route,/runOne\(req,res,ctx,\{single:true,actorId:user\.id,payload\}\)/);
  assert.match(pilot,/payload:validatedPayload=null/);
  assert.doesNotMatch(route,/ENGER_COMPANY_AI_PILOT/);
});

test('only the selected company is linked with tenant scope and facts',()=>{
  assert.match(pilot,/ensureSalesCompanyLink\(sb,\{/);
  assert.match(pilot,/tenantId:ctx\.tenantId,engerCompanyId:payload\.companyId,actorId/);
  assert.match(pilot,/const allowed=await sb\.from\('gw_sales_company_ai_pilot_batches'\)/);
  assert.match(pilot,/if\(single\)/);
  assert.match(link,/companyInScope\(db,tenantId,engerCompanyId\)/);
  assert.match(link,/possible_sales_company_review_required/);
  assert.match(pilot,/if \(current\.data\.status === 'completed'\)/);
  assert.match(pilot,/current\.data\.attempt_count >= 3/);
});

test('official HTTPS requests use pinned public IP with SNI and Host validation',()=>{
  assert.match(research,/dns\.some\(x => !isPublicIpv4\(x\.address\)\)/);
  assert.match(research,/hostname: selected/);
  assert.match(research,/servername: u\.hostname/);
  assert.match(research,/'Host':u\.host/);
  assert.doesNotMatch(research,/lookup: \(hostname, options, cb\)/);
  assert.match(research,/redirect_outside_official_domain/);
});

test('if official website fails, only verified registry permits limited summary',()=>{
  assert.match(pilot,/if\(pageAttempt\.error&&!registry\)/);
  assert.match(pilot,/sameCompanyName\(company\.name,official\.name\)/);
  assert.match(pilot,/const pages=pageAttempt\.pages\|\|\[\]/);
  assert.match(research,/const registryOnly=pages\.length===0/);
  assert.match(research,/technology:registryOnly\?\[\]/);
});
