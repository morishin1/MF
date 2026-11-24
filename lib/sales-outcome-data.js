import { readCompanyAnalysisRows } from './sales-proposal-company-analysis-data.js';
import { reviewIndex, reviewKey } from './sales-outcome-review.js';
import { buildCompanyAnalysis } from './sales-proposal-company-analysis.js';

export const CURRENT = 'gw_sales_outcome_current';
export function readReviews(db, tenant, kinds, fields='id,kind,entity_key,revision,payload,created_at') {
  return readCompanyAnalysisRows(()=>db.from(CURRENT).select(fields).eq('tenant_id',tenant).in('kind',kinds),{source:'outcome_reviews'});
}
export function applyReviewSummary(model, records) {
  const states=reviewIndex(records);
  for (const row of model.rows) {
    const aff=states.get(reviewKey('affiliation',row.sourceProposalId));
    if (aff && (aff.cycle || null)===(row.facts.lastReopen || null)) {
      const value={available:'提案可を確認',unavailable:'提案不可を確認',waiting:'回答待ち'}[aff.status];
      if(value) row.flow[2]={label:'所属確認',value,state:aff.status==='available'?'done':aff.status==='unavailable'?'stopped':'pending'};
    }
    const fb=states.get(reviewKey('feedback',row.sourceProposalId));
    if(fb && row.facts.lost && (fb.cycle || null)===(row.facts.lastReopen || null)) {
      const reason={skill:'スキル・経験',terms:'単価・働き方などの条件',timing:'時期',filled:'枠の充足',intent:'人材の意向',process:'選考・連絡方法',other:'その他'}[fb.category];
      if(reason) row.facts.cause={code:'confirmed:'+fb.category,label:reason};
      const side={job:{code:'job',label:'案件側'},candidate:{code:'talent',label:'人材側'},external:{code:'external',label:'外部要因'}}[fb.side];
      if(side && fb.channel!=='internal') row.facts.side=side;
      row.confirmedFeedback={reason:reason || '理由未確認',side:side?.label || '未確認',quote:fb.quote,observed:fb.observed,channel:fb.channel};
    }
    row.facts.improvementStatus=states.get(reviewKey('meeting',row.company.key))?.status || null;
    row.facts.tradeGrade=states.get(reviewKey('terms',row.company.key))?.grade || null;
  }
}

// Get current-cycle stage, replies and assessments only for Sales rows already authorized by the list endpoint.
export async function readListFlow(db, ctx, proposals, activities, now) {
  const sourceIds=proposals.filter(r=>r.source_system==='enger').map(r=>r.source_proposal_id).filter(Boolean);
  const ids=proposals.map(p=>p.id), en=db.schema('enger');
  const load=async (keys,factory,options={})=>{
    const result=[], unique=[...new Set(keys)];
    for(let i=0;i<unique.length;i+=100) {
      const part=unique.slice(i,i+100);
      result.push(...await readCompanyAnalysisRows(()=>factory(part),options));
    }
    return result;
  };
  const [engerProposals,stageHistory,emailRounds,emailReactions,latestResults,records]=await Promise.all([
    load(sourceIds,part=>en.from('proposals').select('id,stage,deleted_at,created_at,stage_updated_at,updated_at,job_id,candidate_id,match_evaluation_id,job_action_type,cand_action_type,confirm_notified_at,mail_sent_at,lost_phase,dx2_lost_side,lost_reason,lost_detail_reason').in('id',part)),
    load(sourceIds,part=>en.from('activity_logs').select('id,action,target_type,target_id,created_at,detail').eq('target_type','proposal').eq('action','ステージ変更').in('target_id',part)),
    load(sourceIds,part=>en.from('dx2_proposal_email_rounds').select('id,proposal_id,side,sent_at,opens_round').in('proposal_id',part)),
    load(sourceIds,part=>en.from('dx2_proposal_email_reactions').select('id,proposal_id,side,answered_at,recorded_at,round_id,result').in('proposal_id',part)),
    load(ids,part=>db.from('gw_sales_proposal_assessments').select('proposal_id,revision,created_at,interview_result:facts->>interviewResult')
      .eq('tenant_id',ctx.tenantId).in('proposal_id',part),{key:['proposal_id','revision']}),
    load(sourceIds,part=>db.from(CURRENT).select('id,kind,entity_key,status:payload->>status,cycle:payload->>cycle').eq('kind','affiliation').eq('tenant_id',ctx.tenantId).in('entity_key',part)),
  ]);
  const model=buildCompanyAnalysis({salesProposals:proposals,engerProposals,stageHistory,emailRounds,emailReactions,activities,latestResults,tenantId:ctx.tenantId,now});
  applyReviewSummary(model,records);
  return new Map(model.rows.map(r=>[r.salesProposalId,r.flow]));
}
