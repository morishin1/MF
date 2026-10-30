import { EVALUATION_TABLE, canConfirmEvaluation } from '../../lib/company-evaluation-save.js';
// Read-only 90-day company review. No GET writes, tasks, proposal holds, or blast sends.
import { requireUser } from '../../lib/auth.js';
import { gwContext, canSell } from '../../lib/gw.js';
import { userClient } from '../../lib/supabase.js';
import { json, methodNotAllowed } from '../../lib/http.js';
import { canManageProposals } from '../../lib/sales-proposals.js';
import { evaluationWindow, EVALUATION_AXES, evaluateScores } from '../../lib/company-evaluation-policy.js';
import { buildCompanyEvaluationCandidates } from '../../lib/company-evaluation-records.js';
import { readSourceStates, sourceStateFor } from '../../lib/sales-proposal-source-state.js';
const LIMIT = 20000;
async function all(make, orderKey = 'id') {
  const rows = [];
  for (let offset=0; offset<=LIMIT; offset+=1000) {
    const size = Math.min(1000,LIMIT-offset+1);
    const result = await make().order(orderKey,{ascending:true}).range(offset,offset+size-1);
    if (result.error) throw new Error('read_failed',{cause:result.error});
    rows.push(...(result.data || []));
    if (rows.length>LIMIT) throw new Error('limit_exceeded');
    if ((result.data || []).length<size) return rows;
  }
  throw new Error('limit_exceeded');
}
export default async function handler(req,res) {
  const user=await requireUser(req,res); if(!user)return;
  if(req.method!=='GET')return methodNotAllowed(res,['GET']);
  res.setHeader?.('Cache-Control','private, no-store');
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId || !canSell(ctx))return json(res,403,{error:'forbidden'});
  // Assigned-only proposal histories must never be mistaken for a company-wide evaluation.
  if(!canManageProposals(ctx))return json(res,403,{error:'team_scope_required',hint:'企業全体の評価は、全提案を確認できる管理者画面で確認してください。'});
  const now=new Date(); const window=evaluationWindow(now); const sb=userClient(req);
  try {
    const [proposals,links]=await Promise.all([
      all(()=>sb.from('gw_sales_proposals').select('id,tenant_id,source_system,source_proposal_id,source_company_id,company_id,company_name,sent_at,status,close_reason,archived_at')
        .eq('tenant_id',ctx.tenantId).gte('sent_at',window.since).lte('sent_at',window.until)),
      all(()=>sb.from('gw_sales_company_links').select('id,tenant_id,source_system,source_company_id,company_id').eq('tenant_id',ctx.tenantId).eq('source_system','enger')),
    ]);
    const meetings=[];
    for(let i=0;i<proposals.length;i+=100)meetings.push(...await all(()=>sb.from('gw_sales_proposal_activities')
      .select('id,tenant_id,proposal_id,kind,result,occurred_at').eq('tenant_id',ctx.tenantId)
      .in('proposal_id',proposals.slice(i,i+100).map(p=>p.id)).eq('kind','meeting').eq('result','done').lte('occurred_at',window.until)));
    const source=await readSourceStates(sb,ctx.tenantId,proposals);
    if(source.error)return json(res,503,{error:'source_state_unavailable',hint:'同期状態を取得できません。企業評価は更新していません。'});
    const deleted=new Set(proposals.filter(p=>sourceStateFor(p,source.states)?.deleted).map(p=>p.id));
    const complete=source.available===true && !(source.missingIds?.length);
    const result=buildCompanyEvaluationCandidates({tenantId:ctx.tenantId,proposals:proposals.filter(p=>!deleted.has(p.id)),meetings,links,now,complete,qualificationComplete:false});
    let persistence='ready', saved=[];
    try { saved=await all(()=>sb.from(EVALUATION_TABLE).select('company_id,revision::text,evaluation,updated_at').eq('tenant_id',ctx.tenantId),'company_id'); }
    catch(error){persistence=['42P01','PGRST205'].includes(error.cause?.code)?'not_configured':'unavailable';}
    const savedByCompany=new Map(saved.map(row=>[row.company_id,row]));
    for(const company of result.companies){const row=savedByCompany.get(company.localCompanyId);if(row){const e=row.evaluation;company.savedEvaluation={status:e.status,rank:e.rank,score:e.score,policy:e.policy,revision:row.revision,updatedAt:row.updated_at,needsReevaluation:evaluateScores(e.scores || {}).score==null};}}
    return json(res,200,{...result,axes:EVALUATION_AXES,persistence,canConfirm:persistence==='ready' && canConfirmEvaluation(ctx),
      note:`直近90日の参考集計です。源泉の配信種別・返信期限が未確認の集計からランクは確定しません。${persistence==='ready'?'保存済みの根拠付き評価は別欄に表示します。':'評価保存基盤は未取得です。'}提案停止・配信は自動実行しません。`,
      sourceState:complete?'ready':'unconfirmed'});
  } catch(error) {
    return json(res,503,{error:error.message==='limit_exceeded'?'evaluation_data_limit':'evaluation_data_unavailable',hint:'全件取得できないため評価を表示していません。管理者にデータ構成を確認してください。'});
  }
}
