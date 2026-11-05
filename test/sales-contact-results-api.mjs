import assert from 'node:assert/strict';
import {mock} from 'node:test';
const at=p=>new URL('../'+p,import.meta.url).href;
let signedIn=true,tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac',sell=true,readError=false,calls=[];
const db={schema(){return this;},from(table){calls.push({table,ops:[]});const log=calls.at(-1);const q={then(resolve){return Promise.resolve({data:[],count:0,error:readError?{message:'failed'}:null}).then(resolve);}};for(const method of ['select','not','gte','lt','order','limit','is','in','eq'])q[method]=(...args)=>{log.ops.push([method,...args]);return q;};return q;}};
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(req,res)=>{if(!signedIn){res.statusCode=401;res.end('{}');return null;}return {id:'u1'};}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>({tenantId:tenant}),canSell:()=>sell}});
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>db}});
mock.module(at('lib/sales-period.js'),{namedExports:{resolvePeriod:(key)=>key==='invalid'?{error:'bad_range'}:{sinceIso:'2026-11-04T15:00:00Z',untilIso:'2026-11-05T15:00:00Z'}}});
const {default:handler}=await import('../api/sales/contact-results.js');
async function run(query='',method='GET'){calls=[];const res={setHeader(){},end(v){this.body=JSON.parse(v);}};await handler({method,url:'/api/sales/contact-results?'+query},res);return res;}
for(const mode of ['unsigned','foreign','no_sales']){
 signedIn=mode!=='unsigned';tenant=mode==='foreign'?'other':'4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac';sell=mode!=='no_sales';
 const r=await run();assert([401,403].includes(r.statusCode));assert.equal(calls.length,0);
}
signedIn=true;tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac';sell=true;
assert.equal((await run('kind=invalid')).statusCode,400);assert.equal(calls.length,0);
assert.equal((await run('period=invalid')).statusCode,400);assert.equal(calls.length,0);
assert.equal((await run('','POST')).statusCode,405);assert.equal(calls.length,0);
let r=await run();assert.equal(r.statusCode,200);assert.equal(r.body.total,0);assert.equal(calls[0].table,'company_touchpoints');assert(calls[0].ops.some(([m,k])=>m==='gte'&&k==='occurred_at'));
r=await run('kind=proposal_ng');assert.equal(r.statusCode,200);assert(calls[0].ops.some(([m,k,v])=>m==='in'&&k==='stage'&&v.includes('見送り')));
r=await run('kind=company_ng');assert.equal(r.statusCode,200);assert(!calls[0].ops.some(([m])=>m==='gte'),'Current NG list includes old and undated entries');
assert.equal((await run('kind=company_ng&period=invalid')).statusCode,200);
readError=true;r=await run();assert.equal(r.statusCode,503);assert.equal(r.body.total,undefined,'Error is never zero activity');
console.log('PASS contact API: auth/tenant/sales access, bad inputs, source separation, date bounds, active NG, error is not zero');
