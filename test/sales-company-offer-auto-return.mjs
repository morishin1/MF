import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {confirmedCompanyOffers,countPublishedCompanyOffers} from '../lib/sales-company-offer-bridge.js';

const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const api=read('../api/sales/meeting-session.js');
const nav=read('../js/sales-meeting-five-stage.js');
const page=read('../sales/company-meeting.html');
const popup=read('../js/sales-meeting-company-handoff.js');
const uuid=i=>('00000000-0000-4000-8000-'+String(i).padStart(12,'0'));
const tenant=uuid(1),company=uuid(2),foreign=uuid(3),start='2026-11-11T01:00:00Z';
const idA=uuid(101),idB=uuid(102),idC=uuid(103),idD=uuid(104);
const offers=[
 {id:uuid(501),tenant_id:tenant,company_id:company,shortlist_id:idA,item_type:'talent',created_at:'2026-11-11T01:01:00Z'},
 {id:uuid(502),tenant_id:tenant,company_id:company,shortlist_id:idB,item_type:'job',created_at:'2026-11-11T00:59:00Z'}, // old
 {id:uuid(503),tenant_id:tenant,company_id:foreign,shortlist_id:idC,item_type:'job',created_at:'2026-11-11T01:02:00Z'},
 {id:uuid(504),tenant_id:foreign,company_id:company,shortlist_id:idC,item_type:'job',created_at:'2026-11-11T01:03:00Z'},
 {id:uuid(505),tenant_id:tenant,company_id:company,shortlist_id:idD,item_type:'job',created_at:'2026-11-11T01:04:00Z'} // not published
];
const shortlist=[
 {id:idA,tenant_id:tenant,company_id:company,item_type:'talent',status:'published'},
 {id:idB,tenant_id:tenant,company_id:company,item_type:'job',status:'published'},
 {id:idC,tenant_id:tenant,company_id:company,item_type:'job',status:'published'},
 {id:idD,tenant_id:tenant,company_id:company,item_type:'job',status:'draft'}
];

function fakeDb(){
 const tables={
  dx2_company_portal_offers:offers,
  dx2_company_sales_shortlist:shortlist
 };
 const visited=[];
 const db={schema(schema){
  assert.equal(schema,'enger');
  return {from(name){
   const filters=[];
   const query={
    select(){return query;},
    eq(k,v){filters.push(row=>row[k]===v);return query;},
    gte(k,v){filters.push(row=>row[k]>=v);return query;},
    in(k,v){filters.push(row=>v.includes(row[k]));return query;},
    order(){return query;},
    limit(n){visited.push({name,filters:filters.length});
     return Promise.resolve({data:tables[name].filter(row=>filters.every(fn=>fn(row))).slice(0,n),error:null});
    }
   };
   return query;
  }};
 }};
 return {db,visited};
}

test('offer receipt counts only this tenant, company, meeting start and currently published shortlist',async()=>{
 const {db,visited}=fakeDb();
 const r=await confirmedCompanyOffers(db,{tenantId:tenant},{company_id:company,started_at:start});
 assert.deepEqual(r,{count:1,jobCount:0,talentCount:1});
 assert.equal(visited.length,2);
 const now=await confirmedCompanyOffers(db,{tenantId:tenant},{company_id:company,started_at:'2026-11-11T02:00:00Z'});
 assert.equal(now.count,0);
 assert.equal(countPublishedCompanyOffers([{shortlist_id:idA,item_type:'job'}],[{id:idA,item_type:'talent'}]).count,0);
});

test('Sales auto advance is staff-only, atomic, and requires a DB-confirmed offer',()=>{
 assert.match(api,/requireUser\(req,res\)/);
 assert.match(api,/canSell\(ctx\)/);
 assert.match(api,/companyInScope\(db/);
 assert.match(api,/body\.action==="accept_company_offer"/);
 assert.match(api,/if\(current\.stage!==3\)/);
 assert.match(api,/if\(!offers\.count\)/);
 assert.match(api,/step_checks:stepChecks/);
 assert.match(api,/\.eq\("stage",3\)\.eq\("status","active"\)/);
 assert.match(api,/\.eq\("version",current\.version\)/);
 assert.match(api,/return json\(res,200,\{session:view\(got\.row\),companyOfferCount:offers\.count/);
 assert.match(nav,/async function autoAdvanceOffer\(\)/);
 assert.match(nav,/action:"accept_company_offer"/);
 assert.match(nav,/companyOfferCount>0/);
 assert.match(nav,/window\.addEventListener\("focus"/);
 assert.doesNotMatch(nav,/postMessage\(/);
});

test('STEP 4 opens a closable enterprise window, STEP 5 confirms result, STEP 6 sends email',()=>{
 assert.match(popup,/window\.open\(portalUrl,"enger_business_"/);
 assert.match(nav,/handoff\.hidden=viewed!==3/);
 assert.match(nav,/offerPanel\.hidden=viewed<4\|\|viewed>5/);
 assert.match(nav,/panel\.hidden=viewed>=3/);
 for(const id of ['meeting-company-open','meeting-offer-result','meeting-company-offer-count',
   'meeting-step5-outcome','meeting-outcome-label','meeting-closeout','meeting-send'])
   assert.ok(page.includes('id="'+id+'"'),id);
 assert.match(nav,/noOffer&&!confirm\(/);
 assert.match(nav,/skipReason:"企業が該当候補を選択しなかった/);
 assert.match(nav,/nextAction\.value=defaults\[selected\]/);
 assert.match(nav,/next\.hidden=s\.stage===5/);
 assert.match(page,/案内メールを送信して完了/);
 assert.ok(page.indexOf('id="meeting-step5-outcome"')>page.indexOf('id="meeting-closeout"'),'proposal outcome remains inside the shared STEP 5–6 panel');
 assert.match(nav,/closing\.hidden=viewed<4\|\|viewed>5/);
 assert.match(nav,/s\.stage!==5/,'the internal stage-six guard still protects email sending');
});
