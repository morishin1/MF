import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const ctx=vm.createContext({Intl,Date});vm.runInContext(fs.readFileSync(new URL('../js/hr-applicant-compact.js',import.meta.url),'utf8'),ctx);
const describe=ctx.HRApplicantCompact.describe;
const base={applicant:{id:'one',stage:'applied',status:'todo',decision:null},pipeline:{stage:'screening'},guide:{key:'detail',label:'未対応',tab:'overview'},now:Date.parse('2026-11-26T00:00:00Z')};
assert.equal(describe(base).step,'screening');assert.equal(describe(base).action,'docs');
const hired={...base,applicant:{...base.applicant,decision:'hired',stage:'offer'},pipeline:{stage:'offer'},guide:{key:'sendOffer',label:'送付待ち'}};
const draft={id:'doc-one',kind:'offer',current:true,state:'draft'};
const ready={...hired,notice:{enabled:true,canManage:true,flow:{phase:'offer_preparing'},documents:[draft]}};
assert.equal(describe(ready).status,'内定通知の送付待ち');assert.equal(describe(ready).action,'notice');
for(const state of ['sending','unknown']){const m=describe({...ready,notice:{...ready.notice,documents:[{...draft,state,deliveryStatus:state}]}});assert.equal(m.status,'送信結果の確認が必要');assert.ok(!m.status.includes('送付済み'));}
const sent={...draft,state:'sent',sentAt:'2026-11-25T00:00:00Z',expiresAt:'2026-11-27T00:00:00Z'};
let m=describe({...ready,notice:{...ready.notice,documents:[sent]}});assert.equal(m.status,'内定通知送付済み・本人回答待ち');assert.equal(m.step,'offer','送付を承諾やOffice移動と混同しない');
m=describe({...ready,notice:{...ready.notice,documents:[{...sent,expiresAt:'2026-11-26T00:00:00Z'}]}});assert.equal(m.status,'内定通知の回答期限切れ');
m=describe({...ready,notice:{...ready.notice,flow:{phase:'onboarding',acceptedAt:'2026-11-25T00:00:00Z'}}});assert.equal(m.step,'office');assert.equal(m.status,'本人承諾済み');
m=describe({...hired,candidateDocuments:[{kind:'offer',status:'published'}]});assert.ok(m.title.includes('メール送付の記録がありません'),'公開を送付と見なさない');
m=describe({...ready,applicant:{...hired.applicant,pdfFlow:{phase:'offer_preparing'}},notice:null,pdfError:'取得できません'});assert.equal(m.action,'reload');assert.ok(m.title.includes('取得できません'));
for(const phase of ['closed','complete']){m=describe({...ready,pipeline:{stage:phase}});assert.equal(m.action,'activity');assert.ok(!m.cta.includes('送付'));}
m=describe({...ready,pipeline:{stage:'closed'},guide:{key:'contact',label:'見送り',cta:'本人へ連絡'}});assert.equal(m.action,'next');assert.ok(m.title.includes('本人連絡'));
m=describe({...hired,legacy:{acceptedAt:'2026-11-25T00:00:00Z',sentAt:'2026-11-24T00:00:00Z'}});assert.equal(m.status,'本人承諾済み');assert.equal(m.step,'office');
m=describe({...hired,applicant:{...hired.applicant,offerType:'training'},legacy:{acceptedAt:'2026-11-25T00:00:00Z'}});assert.notEqual(m.step,'office','育成枠をOfficeへ自動誘導しない');
m=describe({...ready,notice:{...ready.notice,canManage:false}});assert.ok(m.blocked);
for(const key of ['conduct','evaluate','checkInterviews']){const m=describe({...base,pipeline:{stage:'interview'},guide:{key,label:'面談の対応待ち',cta:'実施済みにする'}});assert.equal(m.action,'interviews');assert.equal(m.cta,'面談・評価を開く');}
assert.equal(JSON.stringify(base.applicant),JSON.stringify({id:'one',stage:'applied',status:'todo',decision:null}),'状態表示は応募者を変更しない');
console.log('PASS HR compact facts: current stage, unresolved/expired delivery, no fabricated send or acceptance, terminal and permission guards');
