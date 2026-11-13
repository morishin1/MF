import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const get=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const proposal=get('../js/sales-company-compact-proposal.js');
const credentials=get('../js/sales-company-meeting-credentials.js');
const portal=get('../api/sales/company-portal.js');
const meeting=get('../api/sales/meeting-session.js');
const publish=get('../api/sales/meeting-visible-publish.js');
test('staff meeting starts with no company contact, external account or password',()=>{
  assert.match(proposal,/begin\.disabled=go\.disabled;/);
  assert.match(proposal,/const companyLoginReady=Boolean\(credentialPanel\?\.state\(\)\?\.active\?\.length\)/);
  assert.doesNotMatch(proposal,/begin\.disabled=go\.disabled\|\|/);
  assert.doesNotMatch(proposal,/if\(!\(credentialPanel\?\.state\(\)\?\.active\?\.length>0\)\)\{\s*preMessage\.textContent="企業用ログインが未発行/);
  assert.match(proposal,/await calendar\?\.saveIfFilled\(\)/);
  assert.match(proposal,/const prepared=await prepareSession\(\)/);
  assert.match(proposal,/staffUrl\.searchParams\.set\("sessionId",sessionId\)/);
});
test('company-ID login works without contact after confirmation; preview accounts stay isolated',()=>{
  assert.match(portal,/contactReady: !inviteInput/);
  assert.match(portal,/previewDemoAllowed: meetingPreviewDemoAllowed/);
  assert.match(credentials,/if\(data\.contactReady===false&&!data\.previewDemoAllowed\)/);
  assert.match(credentials,/if\(data\?\.portal\?\.loginUrl&&status\)/);
  assert.match(credentials,/担当者名・メールが未登録でも社内商談を開始できます/);
  assert.match(portal,/body\.action==="ensure_meeting_account"/);
  assert.match(portal,/body\.confirmed!==true/);
  assert.match(portal,/companyIdOnlyEmail\(company\.id\)/);
  assert.match(portal,/company_login_only:true/);
  assert.match(portal,/apps:\["business_preview"\]/);
});
test('contactless meeting remains tenant scoped and exposes only approved items',()=>{
  assert.match(meeting,/requireUser\(req,res\)/);
  assert.match(meeting,/companyInScope\(db,ctx\.tenantId,companyId\)/);
  assert.match(publish,/canSell\(ctx\)/);
  assert.match(publish,/filter\(isPublicTalent\)/);
  assert.match(publish,/filter\(jobAvailable\)/);
  assert.match(publish,/body\.confirmed!==true/);
});
