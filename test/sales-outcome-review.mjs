import test from 'node:test';
import assert from 'node:assert/strict';
import { proposalFlow, improvementSignal, currentAnswers } from '../lib/sales-proposal-flow.js';
import { normalizeReview, staffOutcomes } from '../lib/sales-outcome-review.js';
import { applyReviewSummary } from '../lib/sales-outcome-data.js';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const now='2026-11-25T01:00:00Z', sent='2026-10-28T00:00:00Z', co='enger:'+id(500), emp=[{id:id(600),display_name:'営業A'},{id:id(601),display_name:'営業B'}];
const company={key:co,identity:{kind:'id'},engerCompanyId:id(500)};
const row=(n,success=false)=>({company,sourceProposalId:id(n),salesProposalId:id(n+5000),sentAt:sent,service:'SES',flow:proposalFlow(),
  lossSideRaw:'案件側',lossDetail:'企業の回答原文',facts:{blast:false,currentSend:sent,side:{code:'job'},jobId:id(700),lost:!success,resultDue:success,
    performedAt:success?sent:null,actualHeldAt:success?sent:null,interviewResult:success?'passed':null,lastReopen:null}});
const rec=(kind,entity_key,payload,revision=1)=>({kind,entity_key,payload,revision});
const proof={channel:'client',quote:'必須実務経験を確認したいとの回答',observed:'2026-10-29'};
const options={model:{rows:[row(1),row(2)]},input:{employees:emp,engerCompanies:[{id:id(500)}],confirmedHistoryLinks:[]},records:[],allowRank:true,allowTerms:true,now};
const body=(kind,entity,data)=>({kind,entity,data,revision:0,requestId:id(900)});
test('five milestones preserve unknown, recipient interest, affiliation inquiry and interview outcome separately',()=>{
  assert.deepEqual(proposalFlow().map(x=>x.label),['マッチング','提案','所属確認','結果','合否']);
  const flow=proposalFlow({source:{job_id:id(1),candidate_id:id(2),mail_sent_at:sent,cand_action_type:'話を進める',job_action_type:'見送り',stage:'失注'}});
  assert.equal(flow[0].state,'done');assert.equal(flow[2].state,'pending');assert.equal(flow[3].state,'stopped');assert.equal(flow[4].value,'合否記録なし');
  assert.equal(proposalFlow({source:{stage:'合格'}})[1].state,'unknown');
  assert.equal(proposalFlow({source:{job_action_type:'話を進める',stage:'提案中'},reopenedAt:now})[3].value,'未確認');
  assert.equal(proposalFlow({source:{stage:'失注',lost_phase:'4. 面談後失注'}})[4].value,'結果待ち');
});
test('meeting suggestion requires three mature unique sent offers and recognizes later success',()=>{
  const rows=[row(1),row(2),row(3)]; assert.equal(improvementSignal(rows,now).suggested,true);
  rows[0].sentAt=now;assert.equal(improvementSignal(rows,now).suggested,false);
  rows[0].sentAt=sent;rows.push({...row(4),sentAt:now,facts:{passed:true}});assert.equal(improvementSignal(rows,now).suggested,false);
});
test('source and cycle evidence required; company stop requires meeting and concrete client losses after it',()=>{
  const feedback=body('feedback',id(1),{...proof,side:'job',category:'skill'});
  assert.equal(normalizeReview(feedback,options).payload.quote,proof.quote);
  assert.throws(()=>normalizeReview({...feedback,data:{...feedback.data,channel:'internal'}},options));
  const terms=body('terms',co,{...proof,grade:'D',refs:[id(1),id(2)],condition:'再協議まで個別提案を停止',nextDate:'2026-12-01'});
  assert.throws(()=>normalizeReview(terms,options),/商談/);
  assert.throws(()=>normalizeReview(terms,{...options,allowTerms:false}),/権限/);
  const recorded={...options,records:[rec('meeting',co,{status:'done',action:'条件をすり合わせ',meetingAt:'2026-10-20T01:00:00Z'})]};
  assert.equal(normalizeReview(terms,recorded).payload.grade,'D');
  const talent=row(2);talent.facts.side.code='talent';talent.lossSideRaw='人材側';
  assert.throws(()=>normalizeReview(terms,{...recorded,model:{rows:[row(1),talent]}}));
  assert.throws(()=>normalizeReview({...terms,data:{...terms.data,refs:[id(1),id(1)]}},recorded));
  const clearance=body('clearance',id(700),{...proof,company:co,termsRevision:2,until:'2026-11-30'});
  assert.throws(()=>normalizeReview(clearance,{...options,records:[rec('terms',co,{grade:'C',nextDate:'2026-12-01'})]}),/変わり/);
});
test('reopen discards earlier affiliation and feedback; unknown outcome cannot become a failed result',()=>{
  const r=row(1);r.facts.lastReopen=now;
  applyReviewSummary({rows:[r]},[{kind:'affiliation',entity_key:id(1),status:'available',cycle:null}]);
  assert.equal(r.flow[2].state,'unknown');
  applyReviewSummary({rows:[r]},[{kind:'affiliation',entity_key:id(1),status:'available',cycle:now}]);
  assert.equal(r.flow[2].state,'done');
});
test('same-cohort ranks use documented roles, case denominators, coverage, ties and minimum peers',()=>{
  const rows=[],reviews=[];
  for(let n=1;n<=40;n++) {
    rows.push(row(n,n<=10 || n>20 && n<=35));
    reviews.push(rec('proposal',id(n),{ownerId:emp[n<=20?0:1].id,delivery:'individual',grade:'B',difficulty:'normal',cause:'role'}));
  }
  const scores=()=>staffOutcomes({rows},reviews,[],emp,now).results.filter(g=>g.role==='proposal');
  assert.deepEqual(scores().map(g=>[g.name,g.rank,g.adjusted]),[['営業B',1,.75],['営業A',2,.5]]);
  for(let i=10;i<15;i++)rows[i].facts.resultDue=true;
  assert.deepEqual(scores().map(g=>g.rank),[1,1]);
  reviews[0].payload.cause='external'; rows[0].facts.resultDue=false;rows[0].facts.lost=true;
  assert.ok(scores().every(g=>g.rank===null));assert.equal(scores().find(g=>g.name==='営業A').external,1);
  for(let i=41;i<=50;i++){const x=row(i);x.facts.blast=null;rows.push(x);}
  assert.ok(scores().every(g=>g.rank===null));
});
test('positive reaction, after-interview loss and provisional close cannot create a pass or an attributed closer',()=>{
  const x=row(1,true);x.facts.interviewResult=null;x.facts.actualHeldAt=null;
  let result=staffOutcomes({rows:[x]},[],[{proposal_id:x.salesProposalId,to_stage:'closing',to_owner_id:emp[0].id,created_at:sent}],emp,now);
  assert.equal(result.coverage.closing.total,1);assert.equal(result.results.filter(g=>g.role==='closing').length,0);
  const review=rec('closing',x.sourceProposalId,{ownerId:emp[0].id,heldAt:sent,grade:'B',difficulty:'normal',delivery:'individual'});
  result=staffOutcomes({rows:[x]},[review],[],emp,now);
  const closer=result.results.find(g=>g.role==='closing');assert.equal(closer.pending,1);assert.equal(closer.raw,null);assert.equal(closer.rank,null);
});

test('a fresh email round supersedes the old answer, and a dated reply after reopen remains visible',()=>{
  const rounds=[{id:id(6),side:'job',opens_round:true,sent_at:sent}];
  const old={side:'job',round_id:id(5),answered_at:sent,result:'pass'};
  assert.deepEqual(currentAnswers(rounds,[old],null,now),{job:'unanswered'});
  const answers=currentAnswers(rounds,[{...old,round_id:id(6),result:'proceed'}],sent,now);
  assert.equal(proposalFlow({reopenedAt:sent,answers})[3].value,'案件側：進める');
  assert.equal(proposalFlow({reopenedAt:sent,answers})[4].state,'unknown');
});
