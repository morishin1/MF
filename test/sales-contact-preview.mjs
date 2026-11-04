import assert from 'node:assert/strict';
import {DEFAULT_TEMPLATES,fillTemplate,safeWebsite,phoneLink,validEmail,previewProblem,mergeHistory} from '../lib/sales-contact-preview.js';
for(const t of DEFAULT_TEMPLATES){const r=fillTemplate(t,{company:'検証企業',contact:'ご担当者様',sender:'テスト担当'});assert(r.body.includes('検証企業'));assert(r.body.includes('テスト担当'));assert(!r.body.includes('{{'));}
assert.equal(fillTemplate({subject:'{{company}}',body:'{{unknown}}'},{company:'<b>会社</b>'}).body,'{{unknown}}','unknown tokens remain detectable');
assert.equal(safeWebsite('javascript:alert(1)'),null);assert.equal(safeWebsite('https://user:pass@example.test'),null);assert.equal(safeWebsite('https://example.test/contact'),'https://example.test/contact');
assert.equal(phoneLink('03-1234-5678'),'tel:0312345678');assert.equal(phoneLink('+81 (3) 1234-5678'),'tel:+81312345678');assert.equal(phoneLink('12345;call=x'),null);assert.equal(phoneLink('javascript:1'),null);
assert(validEmail('sales@example.test'));assert(!validEmail('one@example.test,two@example.test'));assert(!validEmail('sales@example.test\nBcc: bad@example.test'));
const email={channel:'email',to:'sales@example.test',sender:'担当',subject:'ご相談',body:'こんにちは',identified:true};
assert.equal(previewProblem(email),'');assert.match(previewProblem({...email,blocked:true}),/連絡停止/);assert.match(previewProblem({...email,identified:false}),/企業ID/);assert.match(previewProblem({...email,subject:'件名\nBcc: bad'}),/1行/);assert.match(previewProblem({...email,body:'{{unknown}}'}),/差し込み/);assert.match(previewProblem({...email,sender:''}),/名前/);
assert.match(previewProblem({...email,channel:'phone',result:''}),/結果/);assert.equal(previewProblem({...email,channel:'phone',result:'不在'}),'');assert.equal(previewProblem({...email,channel:'memo',result:'確認',blocked:true}),'');
const h=mergeHistory([{id:'t1',occurredAt:'2026-01-01',summary:'過去接点',createdBy:'user1'}],[{at:'2026-11-01',label:'電話'},{at:'2026-12-01',label:'次回',planned:true}],[{at:'2026-11-05',label:'試行',detail:'未送信'}]);
assert.deepEqual(h.map(x=>x.source),['確認用・未保存','Sales','ENGER']);assert.equal(h.length,3);assert.equal(h[2].actor,'user1');
console.log('Sales contact preview: templates, recipient validation, URL safety, blocked contacts and factual history passed');
