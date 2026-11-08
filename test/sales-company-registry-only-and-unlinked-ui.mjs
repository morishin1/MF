import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const status=read('../api/sales/company-workflow-status.js');
const tabs=read('../js/sales-company-portal-tabs.js');
const list=read('../js/sales-company-segments.js');
const css=read('../css/sales-company-stepper.css');
const link=read('../lib/sales-company-ai-link.js');
const batch=read('../api/sales/company-ai-batch.js');
const pilot=read('../api/sales/company-ai-pilot.js');
const summarizer=read('../lib/sales-company-ai-pilot.js');

test('corporate number or official website enables AI navigation',()=>{
 assert.match(status,/const basic=hasNumber\|\|hasWebsite/);
 assert.match(status,/const readyForResearch=hasNumber\|\|hasWebsite/);
 assert.match(tabs,/法人番号または公式HPを登録すると進めます/);
});
test('unlinked Sales companies use the same workbench structure without automatic company merging',()=>{
 assert.match(list,/lc-workbench lc-sales-only-workbench/);
 assert.match(list,/lc-info-pane/);
 assert.match(list,/lc-action-pane/);
 assert.match(list,/lc-history-pane/);
 assert.match(css,/\.lc-sales-only-workbench/);
 assert.match(list,/ENGER未連携/);
});
test('registry-only company research requires verified corporate identity',()=>{
 assert.match(link,/official_registry_verification_required/);
 assert.match(link,/possible_sales_company_review_required/);
 assert.match(batch,/fetchGbizCompany/);
 assert.match(batch,/sameCompanyName\(registry\.name,c\.name\)/);
 assert.match(pilot,/registry_link_review_required/);
 assert.match(pilot,/registry_evidence_unavailable/);
 assert.match(summarizer,/const registryOnly=pages\.length===0/);
 assert.match(summarizer,/technology:registryOnly\?\[\]/);
});
