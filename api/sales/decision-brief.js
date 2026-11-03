// GET /api/sales/decision-brief
// Lightweight, read-only judgment view. This is NOT a matching score or proposal authorization.
// Uses authenticated userClient / RLS and existing Sales sync records only.
import {json,methodNotAllowed} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {userClient} from '../../lib/supabase.js';

const OPEN = ['proposal_wait','call_wait','mail_wait','reply_wait','meeting_adjust','meeting_done','considering','reproposal'];
const PRIORITY = {proposal_wait:0,meeting_adjust:1,considering:2,meeting_done:3,reproposal:4,reply_wait:5,call_wait:6,mail_wait:7};
const FIELDS='id,source_system,source_proposal_id,job_title,company_name,status,matched_at,sent_at,updated_at,proposal_owner_id';
const MAX=500;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const label={proposal_wait:'提案前の条件確認',meeting_adjust:'面談調整の進捗確認',meeting_done:'面談後の成約確認',considering:'検討停滞の理由確認',reproposal:'再提案条件の確認',call_wait:'営業連絡の進捗確認',mail_wait:'連絡対応の進捗確認',reply_wait:'回答待ちの原因確認'};
export default async function handler(req,res) {
  const user=await requireUser(req,res);
  if(!user)return;
  if(req.method!=='GET')return methodNotAllowed(res,['GET']);
  res.setHeader?.('Cache-Control','private, no-store');
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId || !canSell(ctx))return json(res,403,{error:'forbidden'});
  try {
    // 501st record signals a partial window. Never present a truncated count as complete.
    const {data,error}=await userClient(req).from('gw_sales_proposals').select(FIELDS)
      .eq('tenant_id',ctx.tenantId).is('archived_at',null).in('status',OPEN)
      .order('updated_at',{ascending:false}).range(0,MAX);
    if(error)return json(res,503,{error:'sales_decision_unavailable',hint:'Salesの進行案件を取得できません。同期・閲覧権限を確認してください。'});
    const partial=(data || []).length>MAX;
    const rows=(data || []).slice(0,MAX);
    const count=(states)=>rows.filter(r=>states.includes(r.status)).length;
    const priority=[...rows].sort((a,b)=>(PRIORITY[a.status]??99)-(PRIORITY[b.status]??99)
      ||String(b.updated_at||'').localeCompare(String(a.updated_at||''))).slice(0,5)
      .map(r=>({id:r.id,sourceProposalId:UUID.test(r.source_proposal_id||'')?r.source_proposal_id:null,
        sourceSystem:r.source_system||null,companyName:r.company_name||'企業名未確認',
        title:r.job_title||'案件名未確認',status:r.status,statusLabel:label[r.status]||'状況確認',
        // Demand, supply and cost were not validated in this Sales-only read.
        demand:'unverified',supply:'unverified',profit:'unverified',
        hasRegisteredOwner:Boolean(r.proposal_owner_id),updatedAt:r.updated_at||null}));
    return json(res,200,{partial,period:'current-open',source:'sales_synced',updatedAt:new Date().toISOString(),
      metrics:{openCases:rows.length,proposalToVerify:count(['proposal_wait']),
        contactToInspect:count(['call_wait','mail_wait','reply_wait','considering']),
        interviewToInspect:count(['meeting_adjust','meeting_done'])},
      priority,conditionsVerified:false,
      note:partial?'取得上限500件に達しました。件数は暫定です。':'Salesで閲覧可能な進行中提案の記録です。'});
  } catch {
    return json(res,503,{error:'sales_decision_unavailable',hint:'判断用の営業情報を取得できません。管理者にご確認ください。'});
  }
}