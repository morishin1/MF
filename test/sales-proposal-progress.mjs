import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeActivity,planFollowUp,shapeProposal,countFilters,filterRows} from '../lib/sales-proposals.js';
const now='2026-11-20T02:00:00.000Z';
const owner='00000000-0000-4000-8000-000000000001';
const base={id:'p',status:'call_wait',sent_at:'2026-11-18T02:00:00Z',sales_owner_id:owner};
const input=(p={})=>({note:'企業は面談に前向き。単価を確認する。',progress:{stage:'conditions',nextAction:'企業に単価と開始日を確認',dueAt:'2026-11-20T15:00',assigneeId:owner,revenueKind:'monthly',revenue:'800000',cost:'700000',startOn:'2026-12-01',...p}});

test('対応結果、次の行動・期限、金額の未設定と0を区別して保存する',()=>{
  const n=normalizeActivity('progress',input(),{now});
  assert.equal(n.value.detail.salesProgress.dueAt,'2026-11-20T06:00:00.000Z');
  assert.equal(n.value.detail.salesProgress.revenue,800000);
  const plan=planFollowUp({proposal:base,activity:{...n.value,id:'a'},tasks:[{id:'old',status:'open',kind:'call'}],now});
  assert.equal(plan.patch.status,'considering');
  assert.deepEqual(plan.complete,[], '未実施の電話を完了にしない');
  assert.equal(plan.cancel[0].id,'old');
  assert.equal(plan.create[0].assignee_id,owner);
  assert.equal(plan.create[0].title,input().progress.nextAction);
  assert.equal(plan.create[0].auto,false);
  assert.equal(normalizeActivity('progress',input({revenue:'',cost:''}),{now}).value.detail.salesProgress.revenue,null);
  assert.equal(normalizeActivity('progress',input({revenue:'0',cost:'0'}),{now}).value.detail.salesProgress.revenue,0);
});

test('同じ提案の最新記録だけを一覧と詳細の進捗・見込みへ反映する',()=>{
  const activity=(id,at,revenue)=>({id,proposal_id:'p',kind:'memo',note:'単価確認中',occurred_at:at,created_at:at,detail:{salesProgress:{stage:'conditions',revenue,cost:700000,revenueKind:'monthly'}}});
  const acts=[activity('new','2026-11-20T02:00:00Z',850000),activity('old','2026-11-19T02:00:00Z',800000),{...activity('other','2026-11-21T02:00:00Z',999999),proposal_id:'other'}];
  const p=shapeProposal({...base,status:'considering'},{activities:acts,now});
  assert.equal(p.salesStage,'conditions');assert.equal(p.progress.revenue,850000);
  assert.equal(p.latestMemo.text,'単価確認中');
  assert.equal(shapeProposal({...base,status:'lost'},{activities:acts,now}).salesStage,'lost','実際の終了状態を優先');
});

test('契約確認なしの成約・未来の稼働・不正金額・理由なし見送りを拒否する',()=>{
  for(const patch of [{stage:'won'},{stage:'active',contractConfirmed:true,startOn:'2026-11-21'},{stage:'lost'},
    {revenue:-1},{cost:'12.5'},{revenue:'Infinity'},{cost:true},{startOn:'2026-13-01'},{startOn:'2026-02-30'}, {nextAction:''},{dueAt:''}])
    assert.equal(normalizeActivity('progress',input(patch),{now}).error,'invalid_body',JSON.stringify(patch));
  const n=normalizeActivity('progress',input({stage:'active',contractConfirmed:true,startOn:'2026-11-19'}),{now});
  const plan=planFollowUp({proposal:base,activity:{...n.value,id:'a'},tasks:[],now});
  assert.equal(plan.patch.status,'won');assert.equal(plan.create.length,0);
  const p=shapeProposal({...base,...plan.patch},{activities:[{...n.value,id:'a',proposal_id:'p'}],now});
  assert.equal(p.salesStage,'active');
});

test('注力の件数と一覧が一致し、アーカイブは含めない',()=>{
  const rows=[{id:1,isHot:true},{id:2,isHot:true,archived:true},{id:3,isHot:false}];
  assert.equal(countFilters(rows,{now}).hot,1);
  assert.deepEqual(filterRows(rows,{filter:'hot',now}).map(p=>p.id),[1]);
});
