import { requireUser } from '../../../lib/auth.js';
import { gwContext, canSell } from '../../../lib/gw.js';
import { canAccessEightEngerDirectory } from '../../../lib/sales-enger-scope.js';
import { canManageProposals } from '../../../lib/sales-proposals.js';
import { canConfirmEvaluation } from '../../../lib/company-evaluation-save.js';
import { membershipFor } from '../../../lib/enger-agent-role.js';
import { admin, userClient } from '../../../lib/supabase.js';
import { json, methodNotAllowed, readJson } from '../../../lib/http.js';
import { loadCompanyAnalysisData, readCompanyAnalysisRows } from '../../../lib/sales-proposal-company-analysis-data.js';
import { buildCompanyAnalysis } from '../../../lib/sales-proposal-company-analysis.js';
import { improvementSignal } from '../../../lib/sales-proposal-flow.js';
import { applyReviewSummary, readReviews } from '../../../lib/sales-outcome-data.js';
import { normalizeReview, staffOutcomes, problem } from '../../../lib/sales-outcome-review.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  if (!['GET','POST'].includes(req.method)) return methodNotAllowed(res,['GET','POST']);
  const user=await requireUser(req,res);
  if (!user) return;
  try {
    const ctx=await gwContext(user.id);
    if (!canSell(ctx) || !canAccessEightEngerDirectory(ctx) || ctx.employee?.status!=='active') throw problem('営業権限が必要です。',403);
    const db=admin(), sb=userClient(req), member=await membershipFor(db,user.id);
    if (member && (member.status!=='active'||member.membership_type!=='internal'||member.partner_organization_id)) throw problem('社内営業のみ閲覧できます。',403);
    const now=new Date().toISOString(), allowTerms=canConfirmEvaluation(ctx), allowRank=canManageProposals(ctx)||allowTerms;
    const [input,records]=await Promise.all([loadCompanyAnalysisData({db,sb,tenantId:ctx.tenantId}),
      readReviews(db,ctx.tenantId,['proposal','closing','affiliation','feedback','meeting','terms','clearance'])]);
    const model=buildCompanyAnalysis({...input,now});
    applyReviewSummary(model,records.map(r=>({...r,...r.payload})));
    if(req.method==='POST') {
      const value=normalizeReview(await readJson(req),{model,input,records,allowRank,allowTerms,now});
      const {error,data}=await db.rpc('gw_sales_record_outcome',{p_tenant:ctx.tenantId,p_kind:value.kind,p_entity:value.entity,
        p_expected:value.revision,p_request:value.requestId,p_actor:user.id,p_payload:value.payload});
      if(error) {
        if(error.code==='P0002') throw problem('企業の営業・連絡停止状態を確認してください。',409);
        if (['40001','23505'].includes(error.code)) throw problem('別の更新があります。画面を再読み込みして内容を確認してください。',409);
        throw error;
      }
      return json(res,200,{revision:data});
    }
    const params=new URL(req.url,'https://localhost').searchParams, company=params.get('company'), pid=params.get('proposal');
    const employees=input.employees.map(e=>({id:e.id,name:e.display_name}));
    if (!company && !pid) {
      const handoffs=await readCompanyAnalysisRows(()=>sb.from('gw_sales_proposal_handoffs').select('id,proposal_id,to_stage,to_owner_id,created_at')
        .eq('tenant_id',ctx.tenantId).eq('to_stage','closing'),{source:'handoffs'});
      const stats=staffOutcomes(model,records,handoffs,input.employees,now);
      return json(res,200,{...stats,results:stats.results.filter(g=>allowRank||g.ownerId===ctx.employee.id),allowRank,asOf:now});
    }
    const proposal=pid && model.rows.find(r=>r.sourceProposalId===pid && !r.sourceMissing);
    if(pid && !proposal) throw problem('提案が見つかりません。',404);
    const key=company || proposal.company.key, rows=model.rows.filter(r=>r.company.key===key);
    if(!rows.length || (pid && proposal.company.key!==key)) throw problem('企業が見つかりません。',404);
    const c=rows[0].company;
    const jobs=new Map(rows.filter(r=>r.facts.jobId && r.company.identity.kind==='id').map(r=>[r.facts.jobId,{id:r.facts.jobId,title:r.jobTitle}]));
    for (const l of input.confirmedHistoryLinks) if(l.entity_type==='job' && 'enger:'+l.company_id===key && !jobs.has(l.entity_id))
      jobs.set(l.entity_id,{id:l.entity_id,title:'紐付け済みの案件 '+l.entity_id.slice(0,8)});
    const relevant=records.filter(r=>['meeting','terms'].includes(r.kind)?r.entity_key===key:r.kind==='clearance'?jobs.has(r.entity_key)&&r.payload.company===key:
      r.entity_key===pid && (['affiliation','feedback'].includes(r.kind)||allowRank));
    const selected=proposal?{id:pid,jobTitle:proposal.jobTitle,talent:proposal.talentName,stage:proposal.currentStage,flow:proposal.flow,
      result:proposal.resultLabel,owner:proposal.facts.sentBy,blast:proposal.facts.blast,cycle:proposal.facts.lastReopen,
      lost:proposal.facts.lost,canReviewClosing:proposal.facts.resultDue,canReviewProposal:!!proposal.facts.currentSend}:null;
    const lastMeeting=relevant.find(r=>r.kind==='meeting')?.payload;
    const after=lastMeeting?.status==='done'?rows.filter(r=>Date.parse(r.facts.currentSend)>Date.parse(lastMeeting.meetingAt)):null;
    const followup=after?{sent:after.length,held:after.filter(r=>r.facts.resultDue).length,passed:after.filter(r=>r.facts.interviewResult==='passed').length}:null;
    return json(res,200,{followup,company:{key,name:c.name,engerId:c.engerCompanyId,verified:rows.some(r=>r.company.identity.kind==='id') && !!c.engerCompanyId},
      proposal:selected, proposals:rows.filter(r=>r.sourceProposalId && !r.sourceMissing).map(r=>({id:r.sourceProposalId,title:r.jobTitle,talent:r.talentName,
        side:r.lossSide,reason:r.lossReason,detail:r.lossDetail,stage:r.currentStage,verified:r.company.identity.kind==='id'})),
      signal:improvementSignal(rows,now),employees,me:ctx.employee.id,jobs:[...jobs.values()],records:relevant,allowTerms,allowRank});
  } catch(e) {
    if([400,403,404,409].includes(e.status)) return json(res,e.status,{error:'review_error',hint:e.message});
    console.error('[sales-outcome-review]',e?.code || 'unavailable');
    return json(res,503,{error:'review_unavailable',hint:'記録を確認できませんでした。再読み込みしてください。'});
  }
}
