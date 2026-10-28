import assert from 'node:assert/strict';
import {assertLegacyPdfFlowAbsent,readPdfFlowSummaries,isPdfFlowStateMutation} from '../lib/hr-pdf-flow-guard.js';
let calls=0,result={data:[],error:null};const sb={from(){calls++;const q={select(){return q;},eq(){return q;},in(){return q;},limit(){return q;},then(fn){return Promise.resolve(result).then(fn);}};return q;}};
let n=0;async function t(name,fn){await fn();n++;console.log('ok',name);}
await t('flag OFF no query',async()=>{process.env.HR_PDF_FLOW='0';assert.equal((await assertLegacyPdfFlowAbsent(sb,'t',['a'])).ok,true);await readPdfFlowSummaries(sb,'t',['a']);assert.equal(calls,0);});
process.env.HR_PDF_FLOW='1';
await t('new flow absent preserves old path',async()=>assert.equal((await assertLegacyPdfFlowAbsent(sb,'t',['a'])).ok,true));
await t('all owned phases block legacy',async()=>{result={data:[{applicant_id:'a',phase:'declined'}]};assert.equal((await assertLegacyPdfFlowAbsent(sb,'t','a')).status,409);});
await t('lookup error fail closed',async()=>{result={error:{}};assert.equal((await assertLegacyPdfFlowAbsent(sb,'t','a')).status,503);});
await t('missing scope fail closed',async()=>assert.equal((await assertLegacyPdfFlowAbsent(sb,null,'a')).status,503));
await t('summary missing schema marked not ready',async()=>assert.equal((await readPdfFlowSummaries(sb,'t',['a'])).ready,false));
await t('summary whitelists safe fields',async()=>{result={data:[{id:'f',applicant_id:'a',phase:'ready',version:1,accepted_at:'x',token_hash:'secret',salary:123}]};const r=await readPdfFlowSummaries(sb,'t',['a']);assert.equal(r.byApplicant.get('a').phase,'ready');assert.equal(r.byApplicant.get('a').token_hash,undefined);});
await t('PR210 note save remains permitted',()=>assert.equal(isPdfFlowStateMutation({action:'saveNote',id:'a',note:'internal',expectedNote:'old'}),false));
await t('status and action transitions blocked',()=>{for(const action of ['setStatus','completeCurrentAction','advance','delete'])assert.equal(isPdfFlowStateMutation({action}),true);});
await t('deadline pay recipient edits blocked',()=>{for(const k of ['action_due_at','deadline','pay','email','offer_type'])assert.equal(isPdfFlowStateMutation({[k]:'x'}),true);});
console.log(`${n}/${n} PASS`);
