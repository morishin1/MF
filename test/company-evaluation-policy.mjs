import assert from 'node:assert/strict';
import { EVALUATION_AXES, evaluateScores, evaluationWindow, evaluateReviewCandidates, validateEvaluationDecision } from '../lib/company-evaluation-policy.js';
const now = new Date('2026-10-30T04:00:00Z');
const full = Object.fromEntries(EVALUATION_AXES.map(x=>[x.key,{points:x.max,evidence:'確認済み根拠',observedAt:now.toISOString()}]));
assert.equal(EVALUATION_AXES.reduce((n,x)=>n+x.max,0),100);
assert.equal(evaluationWindow(now).since,'2026-08-01T15:00:00.000Z');
assert.equal(evaluateScores({},now).score,null);
assert.equal(evaluateScores({},now).suggestedRank,null);
const fractional=Object.fromEntries(EVALUATION_AXES.map(x=>[x.key,{...full[x.key],points:x.key==='outcomes'?0.1:x.key==='response'?0.2:0}]));
assert.equal(evaluateScores(fractional,now).score,0.3);

for (const [sum,rank] of [[100,'A'],[80,'A'],[79,'B'],[60,'B'],[59,'C'],[40,'C'],[39,'D'],[0,'D']]) {
 let remaining=sum;
 const scores=Object.fromEntries(EVALUATION_AXES.map(x=>{const points=Math.min(x.max,remaining);remaining-=points;return [x.key,{...full[x.key],points}];}));
 assert.equal(evaluateScores(scores,now).suggestedRank,rank);
 assert.equal(evaluateScores(scores,now).status,'review_required');
}
for (const patch of [{points:null},{points:NaN},{points:-1},{points:31},{points:'30'},{evidence:''},{observedAt:'invalid'},{observedAt:'2026-08-01T14:59:59Z'},{observedAt:'2026-10-30T04:00:01Z'}]) {
 assert.equal(evaluateScores({...full,outcomes:{...full.outcomes,...patch}},now).score,null);
}
for(const [count,expected] of [[4,[]],[5,['alert_owner']],[9,['alert_owner']],[10,['alert_owner','review_proposal_hold']],[14,['alert_owner','review_proposal_hold']],[15,['alert_owner','review_proposal_hold','review_blast_only']]]) {
 const result=evaluateReviewCandidates({sentCount:count,meetingCount:0,qualifiedCount:0,complete:true,identityVerified:true});
 assert.deepEqual(result.actions,expected);assert.equal(result.enforceable,false);assert.equal(result.pendingCount,count);
}
for(const patch of [{complete:false},{identityVerified:false},{sentCount:-1},{meetingCount:16},{qualifiedCount:16},{unknownReasonCount:16},{meetingCount:1,qualifiedCount:0}])assert.equal(evaluateReviewCandidates({sentCount:15,meetingCount:0,qualifiedCount:0,complete:true,identityVerified:true,...patch}).status,'unavailable');
assert.deepEqual(evaluateReviewCandidates({sentCount:15,meetingCount:1,qualifiedCount:1,unknownReasonCount:1,complete:true,identityVerified:true,previousPolicy:'stopped'}).actions,['confirm_loss_reasons','review_improvement']);
const context={isAdmin:true,identityVerified:true,now};
const d={rank:'D',policy:'stopped',reason:'改善協議後も進展なしを確認',reviewedAt:now.toISOString(),improvementDiscussed:true,noProgressConfirmed:true};
assert.equal(validateEvaluationDecision(d,context).ok,true);
for(const patch of [{reason:''},{improvementDiscussed:false},{noProgressConfirmed:false},{policy:'normal'},{rank:'S'},{reviewedAt:'2027-01-01'}])assert.equal(validateEvaluationDecision({...d,...patch},context).ok,false);
assert.equal(validateEvaluationDecision(d,{...context,isAdmin:false}).ok,false);
assert.equal(validateEvaluationDecision(d,{...context,isAdmin:"true"}).ok,false);
assert.equal(validateEvaluationDecision(d,{...context,now:undefined}).ok,false);
assert.equal(validateEvaluationDecision(d,{...context,identityVerified:false}).ok,false);
console.log('PASS company evaluation: score boundaries, missing evidence, 90-day JST window, 5/10/15 candidates, pending safety, admin D decision');
