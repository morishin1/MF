import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';

const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const nav=read('js/sales-layout.js'),html=read('sales/index.html');
const board=read('js/sales-decision-board.js'),api=read('api/sales/decision-brief.js');
const company=read('js/sales-company-reference.js');
const stars=read('api/sales/company-stars.js'),sql=read('db/157_sales_company_stars.sql');
const tabs=read('js/sales-dashboard-tabs.js');

const order=['dashboard','proposals','companies','leads','analytics'];
const positions=order.map(key=>nav.indexOf('key: "'+key+'"'));
assert.ok(positions.every((x,i)=>x>0&&(i===0||x>positions[i-1])),'Five company-led Sales menu items must be in the requested order');
assert.doesNotMatch(nav,/key: "attack"/,'Attack is entered from a company, not a separate menu');
assert.doesNotMatch(nav,/key: "enger"/,'ENGER is not a seventh primary menu item');
assert.match(html,/id="db-merged-rankings"/);
assert.doesNotMatch(html,/id="db-tab-rankings"/);
assert.match(html,/matching\?tab=job/);
assert.match(html,/matching\?tab=talent/);
assert.match(tabs,/const VIEWS = \["today", "company", "analysis"\]/);

assert.match(api,/resolvePeriod\(key/);
assert.match(api,/gte\('updated_at',period\.sinceIso\)/);
assert.match(api,/lt\('updated_at',period\.untilIso\)/);
assert.match(api,/queryFor\(METRIC\[metric\]\)/);
assert.match(api,/countFor\(METRIC\.proposalToVerify\)/);
assert.match(board,/data-metric-page/);
assert.match(board,/data-metric="/);
assert.match(read('js/sales-dashboard-report.js'),/SalesDecisionBoard\?\.periodChanged/);

assert.match(company,/data-company-index/);
assert.match(company,/sales-company-reference-modal/);
assert.match(company,/api\/sales\/companies\/detail/);
assert.match(company,/api\/sales\/company-stars/);
assert.match(company,/企業IDが未照合/);
assert.match(stars,/userClient\(req\)/);
assert.match(stars,/tenant_id:ctx\.tenantId/);
assert.match(stars,/Number\.isSafeInteger\(stars\)/);
assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
assert.match(sql,/REFERENCES public\.gw_sales_companies/);

for (const source of [nav,tabs,board,company]) assert.doesNotThrow(()=>new Script(source));
console.log('PASS: Sales navigation, period-backed metric drilldown, focus entrypoints, verified company detail and star review');
