import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = p => readFileSync(new URL('../'+p,import.meta.url),'utf8');
const analytics = read('sales/analytics.html'), proposals = read('sales/proposals.html');
assert.ok(!proposals.includes('id="pp-tab-kpi"') && !proposals.includes('id="kpi-sec"'));
assert.ok(!proposals.includes('SalesProposalJourney') && !proposals.includes('function renderKpi'));
assert.ok(analytics.includes('id="proposal-journey"') && analytics.includes('SalesAnalyticsHub.init'));
for(const k of ['matching','attack','proposal']) assert.equal(analytics.split(`id="ah-panel-${k}"`).length,2);
for(const view of ['composition','skills','quality']) assert.ok(analytics.includes(`https://dx.enger.jp/report?view=${view}`));
assert.match(analytics,/未接続/); assert.match(analytics,/会計上の売上/); assert.match(analytics,/現在状態による前段の推定/);
// グラフ：部品を先に読み、マッチングは「未接続」のグラフ枠（棒・0件を出さない）
assert.ok(analytics.indexOf('sales-analytics-charts.js') > 0 && analytics.indexOf('sales-analytics-charts.js') < analytics.indexOf('sales-proposal-journey.js'));
const matching = analytics.slice(analytics.indexOf('id="ah-panel-matching"'), analytics.indexOf('id="ah-panel-proposal"'));
assert.match(matching,/data-state="not-connected"/); assert.match(matching,/グラフ：未接続/); assert.doesNotMatch(matching,/data-chart-key|<svg/);
// 専門用語を画面に出さない（コホート→期間内に送信した提案、母数→集計対象）
for (const f of ['sales/analytics.html','js/sales-analytics-hub.js','js/sales-proposal-journey.js']) assert.doesNotMatch(read(f),/コホート|母数/, f);
assert.match(read('js/sales-analytics-hub.js'),/集計対象/);
const make = () => ({children:[],handlers:{},attrs:{},hidden:false,value:'',textContent:'',
  replaceChildren(...xs){this.children=xs;},append(x){this.children.push(x);},
  setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,v){this.handlers[k]=v;},focus(){this.focused=true;}});
const elements = new Map();
for(const k of ['matching','attack','proposal']) for(const type of ['tab','panel'])elements.set(`ah-${type}-${k}`,make());
for(const id of ['ah-question','ah-plan'])elements.set(id,make());
const events={}, location={hash:'#proposal',pathname:'/sales/analytics.html',search:'?rp=last_week'};
let attacks=0, journeys=0, writes=0;
const window={addEventListener:(k,v)=>events[k]=v,SalesProposalJourney:{show(){journeys++;}}};
const history={pushState(a,b,url){writes++; location.hash=url.slice(url.indexOf('#')); assert.ok(url.includes('?rp=last_week'));}};
vm.runInNewContext(read('js/sales-analytics-hub.js'),{window,document:{getElementById:id=>elements.get(id),createElement:make},location,history,Number,String});
window.SalesAnalyticsHub.init({loadAttack(){attacks++;}});
assert.equal(journeys,1);assert.equal(attacks,0,'proposal deep link does not fetch attack');
assert.equal(elements.get('ah-panel-proposal').hidden,false);
elements.get('ah-tab-proposal').handlers.click();assert.equal(journeys,1,'repeated tab click does not refetch');
assert.equal(elements.get('ah-tab-proposal').attrs['aria-selected'],'true');
window.SalesAnalyticsHub.init({loadAttack(){throw Error('double init');}});assert.equal(journeys,1);
elements.get('ah-tab-matching').handlers.click();assert.equal(journeys,1);assert.equal(attacks,0);
assert.match(elements.get('ah-plan').children[0].children[1].textContent,/仮説例（未検証）/);
elements.get('ah-question').handlers.change({target:{value:'1'}});assert.equal(elements.get('ah-question').value,'1');
elements.get('ah-tab-attack').handlers.click();assert.equal(attacks,1);
elements.get('ah-tab-attack').handlers.click();assert.equal(attacks,1,'attack initializes once');
location.hash='#matching';events.popstate();assert.equal(elements.get('ah-question').value,'1','selection retained in memory only');
let prevented=false;elements.get('ah-tab-matching').handlers.keydown({key:'End',preventDefault(){prevented=true;}});
assert.ok(prevented && elements.get('ah-tab-proposal').focused);assert.equal(location.hash,'#proposal');
location.hash='#bad';events.hashchange();assert.equal(elements.get('ah-panel-attack').hidden,false);
assert.ok(writes>0);assert.ok(!read('js/sales-analytics-hub.js').includes('localStorage'));
console.log('PASS sales analytics hub: one analysis entry, matching limits, lazy tabs, deep links/history, keyboard and non-persistent hypothesis prompts');
