import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReadiness, evidenceFor, normalizeReadinessFacts, requiredSkillLines } from '../lib/sales-proposal-readiness.js';

const today = '2026-11-22';
const source = { job_action_type:'proceed', cand_action_type:'proceed' };
const job = {
  skills:['Java','PostgreSQL','C++'],
  detail:'【必須スキル】\n・Javaの開発経験3年以上\n・PostgreSQL\n・C++\n・年齢要件あり\n【尚可】\n・Python',
};
const candidate = { skills:['Java','PostgreSQL','C++','JavaScript'], exp:'5年' };
const fit = evidenceFor(job,candidate);
const all = {
  contact:'direct',hiring:'confirmed',budget:'yes',candidateContact:'direct',intent:'yes',
  dates:'yes',offers:'none',confirmedOn:'2026-11-20',rate:'yes',start:'yes',location:'yes',flow:'yes',
  fitVerified:'yes',note:'類似案件で進行を担当したことを確認',
};
const assess = (facts = all, extra = {}) => assessReadiness({
  facts,source,fit,history:{ meetings:2 },conditions:{ meetingHeld:false },today,...extra,
});

test('the mandatory list is separate from preferred or personal attributes and skills match whole names', () => {
  assert.deepEqual(requiredSkillLines(job.detail), ['Javaの開発経験3年以上','PostgreSQL','C++']);
  assert.deepEqual(evidenceFor(job,{ skills:['JavaScript','C','PostgreSQL'] }).checks.map(c=>c.matches), [[],['PostgreSQL'],[]]);
  assert.deepEqual(fit.matched,['Java','PostgreSQL','C++']);
  assert.equal(fit.grade,'B');
});
test('proposal grades are based on all four weighted axes and verified evidence', () => {
  assert.equal(assess().grade,'A');
  assert.equal(assess().score,100);
  assert.equal(assess().next,'企業に面談候補日を2つ提示');
  assert.equal(assess({...all,fitVerified:''}).grade,'B');
  assert.equal(assess({...all,rate:''}).grade,'B');
  assert.equal(assess({...all,candidateContact:'sheet'}).grade,'C');
  assert.equal(assess({...all,offers:'accepted'}).grade,'C');
  assert.equal(assess({...all,interviewResult:'failed'}).grade,'C');
  assert.equal(assess({interviewResult:'failed'}).next,'企業に見送り理由を確認し、ENGERと共有');
  assert.equal(assess({...all,confirmedOn:'2026-10-31'}).grade,null);
  assert.equal(assess({...all,hiringCount:0}).grade,'C');
  assert.equal(assess(all,{source:{...source,job_action_type:'pass'}}).grade,'C');
  assert.equal(assess(all,{conditions:{unlinked:true}}).grade,null);
  assert.equal(assess(all,{inactive:true}).grade,null);
  assert.equal(assess({}).grade,null);
});
test('facts reject unverifiable/future values and only accept interview outcomes after a held meeting', () => {
  assert.equal(normalizeReadinessFacts({...all,fitVerified:'yes',note:''},today,false),null);
  assert.equal(normalizeReadinessFacts({...all,confirmedOn:'2026-11-30'},today,false),null);
  assert.equal(normalizeReadinessFacts({...all,hiringCount:-1},today,false),null);
  assert.equal(normalizeReadinessFacts({...all,interviewResult:'passed'},today,false),null);
  assert.equal(normalizeReadinessFacts({...all,interviewResult:'passed'},today,true).interviewResult,'passed');
});
