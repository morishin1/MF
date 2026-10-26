// Reason acquisition is separate from causes; exercise actual modal/payload code without browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../sales/proposals.html',import.meta.url),'utf8');
const from = html.indexOf('  const noteField =');
const to = html.indexOf('  // ---- 提案担当→CS→クロージング',from);
assert.ok(from > 0 && to > from);
const nodes = new Map();
const get = (id) => { if(!nodes.has(id)) nodes.set(id,{value:'',style:{},hidden:false,disabled:false,innerHTML:''}); return nodes.get(id); };
let status = 'lost', markup = '', issues = [], sent = [];
const context = vm.createContext({
  $:get, esc:String, radios:()=>'', foot:()=>'', picked:()=>status,
  modal:(s)=>{markup=s}, ppShowIssue:(v)=>{issues.push(v);return !!v},
  detail:{proposal:{status:'lost'},labels:{reasonsFor:{lost:['client_declined','talent_declined','filled','other'],won:[null]},statuses:[{key:'lost',label:'見送り'},{key:'won',label:'成約'}],closeReasons:[{key:'other',label:'その他'}]}},
  document:{}, setTimeout, window:{},
});
vm.runInContext(html.slice(from,to),context);
context.capture=(v)=>sent.push(v);
vm.runInContext('send = capture;',context);
context.ppResult();context.ppToggle();
assert.ok(markup.includes('まだ聞いてない'));
assert.ok(markup.includes('具体的説明あり（真因未検証）'));
assert.ok(get('m-reason').innerHTML.includes('理由を選択してください'));
assert.equal(get('m-reason-collection-box').hidden,false);
for(const state of ['not_asked','no_answer','vague']) {
  get('m-reason-collection').value=state;get('m-reason').value='client_declined';
  context.ppReasonCollectionChanged();
  assert.equal(get('m-reason').disabled,true);
  assert.equal(get('m-reason-compat').hidden,false);
  context.ppSendResult();
  assert.equal(sent.at(-1).reason,'other');
  assert.equal(sent.at(-1).reasonCollectionStatus,state);
}
get('m-reason-collection').value='specific';get('m-reason').value='';
context.ppReasonCollectionChanged();assert.equal(get('m-reason').disabled,false);
let n=sent.length;context.ppSendResult();assert.equal(sent.length,n);assert.equal(issues.at(-1).field,'m-reason');
get('m-reason').value='client_declined';context.ppSendResult();
assert.equal(sent.at(-1).reason,'client_declined');assert.equal(sent.at(-1).reasonCollectionStatus,'specific');
get('m-reason-collection').value='';context.ppSendResult();assert.ok(!('reasonCollectionStatus' in sent.at(-1)));
status='won';context.ppToggle();get('m-reason-collection').value='vague';context.ppSendResult();
assert.ok(!('reasonCollectionStatus' in sent.at(-1)));assert.equal(get('m-reason-collection-box').hidden,true);
context.detail.proposal.status='lost';context.ppMemo();assert.ok(markup.includes('情報取得状態を選んだ場合は任意'));
get('m-reason-collection').value='no_answer';get('m-note').value='';context.ppSendMemo();
assert.equal(sent.at(-1).action,'memo');assert.equal(sent.at(-1).note,'見送り理由の情報取得状態：聞いたけど答えなし');assert.equal(sent.at(-1).reasonCollectionStatus,'no_answer');
context.detail.proposal.status='meeting_done';context.ppMemo();assert.ok(!markup.includes('m-reason-collection'));
context.ppSendMemo();assert.ok(!('reasonCollectionStatus' in sent.at(-1)));
const w={};vm.runInNewContext(readFileSync(new URL('../js/sales-proposal-feedback.js',import.meta.url),'utf8'),{window:w});
for(const state of ['not_asked','no_answer','vague','specific']) {
  assert.equal(w.SalesProposalFeedback.validate('memo',{note:'見送り理由の情報取得状態：選択した状態',reasonCollectionStatus:state},{}),null);
  assert.equal(w.SalesProposalFeedback.validate('memo',{note:'',reasonCollectionStatus:state},{proposalStatus:'won'}).field,'m-note');
}
assert.equal(w.SalesProposalFeedback.validate('memo',{note:'',reasonCollectionStatus:'invalid'},{proposalStatus:'lost'}).field,'m-note');
console.log('PASS reason collection UI: incomplete statuses, explicit category, no forced text, lost-only annotations, validation');
