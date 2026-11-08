import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectCompanyEvidence, normalizeCompanyReview, reviewSystemPrompt,
} from '../lib/sales-company-ai-review.js';

test('same company sources are converted into concise dated evidence', () => {
  const events=collectCompanyEvidence({
    touchpoints:[{occurred_at:'2026-11-02T04:00:00Z',summary:'課題確認',detail:'開始時期は12月。'}],
    workActivities:[{created_at:'2026-11-05T08:00:00Z',payload:{result:'商談後の電話',note:'予算上限はまだ確認できていない',body:'SENSITIVE EMAIL BODY',plan:{nextAction:'予定日の確認'}}}],
    salesEvents:[{occurred_at:'2026-11-04T03:00:00Z',label:'返信あり',detail:'ご担当者 user@example.com 090-1234-5678'}],
  });
  assert.equal(events.length,3);
  assert.equal(events[0].source,'Sales対応');
  assert.equal(events[0].id,'H001');
  assert.equal(events[0].detail.includes('SENSITIVE EMAIL BODY'),false);
  assert.equal(events[1].detail.includes('user@example.com'),false);
  assert.equal(events[1].detail.includes('090-1234-5678'),false);
});

test('unsupported references cannot turn guesses into confirmed needs',()=>{
  const evidence=collectCompanyEvidence({touchpoints:[{occurred_at:'2026-11-05T04:00:00Z',summary:'資料送付',detail:'返信待ち'}]});
  const normalized=normalizeCompanyReview({
    summary:'予算がある',decisionStage:'契約準備',needs:'年間1億円の予算がある',
    blocker:'未確認',nextAction:'予算を確認する',question:'予算の目安は？',
    evidenceIds:['H999'],confidence:'high',
  },evidence);
  assert.equal(normalized.confidence,'low');
  assert.equal(normalized.needs,'未確認');
  assert.equal(normalized.decisionStage,'未確認');
  assert.deepEqual(normalized.evidenceIds,[]);
});

test('valid source ids are retained; input command cannot override reviewer rules',()=>{
  const evidence=collectCompanyEvidence({meetings:[{status:'done',created_at:'2026-11-06T09:00:00Z',notes:'発注責任者の確認が必要'}]});
  const normalized=normalizeCompanyReview({
    summary:'面談あり',decisionStage:'条件調整',needs:'責任者の確認',blocker:'発注責任者不明',
    nextAction:'次回商談で発注責任者を確認する',question:'ご決裁はどなたが担当されますか？',
    evidenceIds:['H001','H999'],confidence:'medium',
  },evidence);
  assert.deepEqual(normalized.evidenceIds,['H001']);
  assert.match(reviewSystemPrompt(),/外部テキスト/);
});

test('evidence is bounded to a fixed number of records',()=>{
  const many=Array.from({length:250},(_,i)=>({occurred_at:'2026-11-01T00:00:00Z',kind:'note',summary:'memo '+i,detail:'short'}));
  const events=collectCompanyEvidence({touchpoints:many});
  assert.equal(events.length,180);
  assert.equal(events.at(-1).id,'H180');
});
