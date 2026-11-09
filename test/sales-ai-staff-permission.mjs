import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const get=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const role=get('../lib/gw.js');
const scope=get('../lib/sales-enger-scope.js');
const single=get('../api/sales/company-ai-single.js');
const workflow=get('../api/sales/company-workflow-status.js');
const ui=get('../js/sales-company-portal-tabs.js');
const pilot=get('../api/sales/company-ai-pilot.js');
const meetings=get('../api/sales/meeting-session.js');
const publish=get('../api/sales/meeting-visible-publish.js');
const meetingScreen=get('../api/sales/company-meeting-screen.js');

test('Sales app access, not ownership, grants individual company AI analysis',()=>{
 assert.match(role,/export const canSell = canAccessSales;/);
 assert.match(role,/hasApp\(ctx, "sales"\)/);
 assert.match(single,/!ctx\.tenantId\|\|!canSell\(ctx\)\|\|!canAccessEightEngerDirectory\(ctx\)/);
 assert.doesNotMatch(single,/isOwner\(/);
 assert.match(single,/const payload=await readJson\(req\)/);
 assert.match(single,/companyInScope\(admin\(\),ctx\.tenantId,companyId\)/);
 assert.match(single,/runOne\(req,res,ctx,\{single:true,actorId:user\.id,payload\}\)/);
 assert.match(workflow,/eligible:readyForResearch,canRun:canSell\(ctx\)&&readyForResearch/);
 assert.match(ui,/AI実行にはSales権限が必要です/);
});

test('existing company verification, retry cap and one-company-only flow remain protected',()=>{
 assert.match(scope,/ctx\.tenantId === EIGHT_ENGER_SALES_TENANT/);
 assert.match(pilot,/ensureSalesCompanyLink\(sb/);
 assert.match(pilot,/actorId/);
 assert.match(pilot,/if \(current\.data\.status === 'completed'\)/);
 assert.match(pilot,/current\.data\.attempt_count >= 3/);
 assert.match(pilot,/if\(single\)/);
 assert.match(single,/methodNotAllowed\(res,\['POST'\]\)/);
 assert.match(pilot,/if \(!isOwner\(ctx\)\)/);
 assert.match(workflow,/canRun:isOwner\(ctx\)&&previewEnabled/);
});

test('Sales staff can continue from AI to company proposals and 30-minute meeting',()=>{
 assert.match(meetings,/!canSell\(ctx\)/);
 assert.match(meetings,/companyInScope\(db,ctx\.tenantId,companyId\)/);
 assert.match(publish,/!canSell\(ctx\)/);
 assert.match(meetingScreen,/canSell\(ctx\)/);
 assert.match(ui,/"\/api\/sales\/company-ai-single"/);
 assert.match(ui,/await loadProgress\(\)/);
 assert.match(ui,/select\("proposal"\)/);
});
