// GET /api/sales/decision-brief?period=last_30&metric=openCases&page=1
// Scope: selected JST period's UPDATED open records (not a historical point-in-time snapshot).
// A count and its drilldown use the same predicate, tenant and RLS.
import { json, methodNotAllowed } from '../../lib/http.js';
import { requireUser } from '../../lib/auth.js';
import { gwContext, canSell } from '../../lib/gw.js';
import { userClient } from '../../lib/supabase.js';
import { resolvePeriod, DEFAULT_PERIOD } from '../../lib/sales-period.js';

const OPEN = ['proposal_wait','call_wait','mail_wait','reply_wait','meeting_adjust','meeting_done','considering','reproposal'];
const METRIC = {
  openCases: OPEN,
  proposalToVerify: ['proposal_wait'],
  contactToInspect: ['call_wait','mail_wait','reply_wait','considering'],
  interviewToInspect: ['meeting_adjust','meeting_done'],
};
const PRIORITY = {proposal_wait:0,meeting_adjust:1,considering:2,meeting_done:3,reproposal:4,reply_wait:5,call_wait:6,mail_wait:7};
const FIELDS='id,source_system,source_proposal_id,job_title,company_name,status,matched_at,sent_at,updated_at,proposal_owner_id';
const LIMIT=500, PAGE_SIZE=100;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL={proposal_wait:'提案前の条件確認',meeting_adjust:'面談調整の進捗確認',meeting_done:'面談後の成約確認',considering:'検討停滞の理由確認',reproposal:'再提案条件の確認',call_wait:'営業連絡の進捗確認',mail_wait:'連絡対応の進捗確認',reply_wait:'回答待ちの原因確認'};
const shape = row => ({
  id:row.id, sourceProposalId:UUID.test(row.source_proposal_id||'')?row.source_proposal_id:null,
  sourceSystem:row.source_system||null, companyName:row.company_name||'企業名未確認',
  title:row.job_title||'案件名未確認', status:row.status,
  statusLabel:LABEL[row.status]||'状況確認',
  demand:'unverified',supply:'unverified',profit:'unverified',
  hasRegisteredOwner:Boolean(row.proposal_owner_id),updatedAt:row.updated_at||null,
});
export default async function handler(req,res) {
  const user=await requireUser(req,res); if(!user)return;
  if(req.method!=='GET')return methodNotAllowed(res,['GET']);
  res.setHeader?.('Cache-Control','private, no-store');
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx))return json(res,403,{error:'forbidden'});

  const query=new URL(req.url,'http://localhost').searchParams;
  const key=query.get('period')||DEFAULT_PERIOD;
  const period=resolvePeriod(key,{from:query.get('from'),to:query.get('to')});
  if(period.error)return json(res,400,{error:period.error,hint:period.hint});
  const metric=query.get('metric');
  if(metric && !Object.hasOwn(METRIC,metric))return json(res,400,{error:'invalid_metric'});
  const page=Number(query.get('page')||1);
  if(!Number.isSafeInteger(page)||page<1||page>10000)return json(res,400,{error:'invalid_page'});

  const queryFor=states=>userClient(req).from('gw_sales_proposals').select(FIELDS,{count:'exact'})
    .eq('tenant_id',ctx.tenantId).is('archived_at',null)
    .in('status',states).gte('updated_at',period.sinceIso).lt('updated_at',period.untilIso);
  const countFor=states=>userClient(req).from('gw_sales_proposals').select('id',{count:'exact',head:true})
    .eq('tenant_id',ctx.tenantId).is('archived_at',null)
    .in('status',states).gte('updated_at',period.sinceIso).lt('updated_at',period.untilIso);

  try {
    if(metric) {
      const start=(page-1)*PAGE_SIZE;
      const {data,error,count}=await queryFor(METRIC[metric])
        .order('updated_at',{ascending:false}).order('id',{ascending:true})
        .range(start,start+PAGE_SIZE-1);
      if(error)return json(res,503,{error:'sales_decision_unavailable',hint:'対象の明細を取得できません。同期・権限を確認してください。'});
      return json(res,200,{period:{from:period.from,to:period.to,key:period.key},metric,
        total:count??0,page,pageSize:PAGE_SIZE,rows:(data||[]).map(shape),
        countBasis:'selected_period_last_updated'});
    }

    const {data,error,count}=await queryFor(OPEN).order('updated_at',{ascending:false}).order('id',{ascending:true})
      .range(0,LIMIT);
    if(error)return json(res,503,{error:'sales_decision_unavailable',hint:'Salesの進行案件を取得できません。同期・閲覧権限を確認してください。'});
    const partial=(count??0)>LIMIT;
    const rows=(data||[]).slice(0,LIMIT);
    const countStates=states=>rows.filter(row=>states.includes(row.status)).length;
    const fullCount=count??rows.length;
    // For an oversized window fetch exact subgroup counts. Do not silently show truncated totals.
    let proposalToVerify=countStates(METRIC.proposalToVerify);
    let contactToInspect=countStates(METRIC.contactToInspect);
    let interviewToInspect=countStates(METRIC.interviewToInspect);
    if(partial){
      const checks=await Promise.all([
        countFor(METRIC.proposalToVerify),
        countFor(METRIC.contactToInspect),
        countFor(METRIC.interviewToInspect),
      ]);
      if(checks.some(r=>r.error||r.count==null))return json(res,503,{error:'sales_count_unavailable',hint:'期間中の全件数を集計できませんでした。'});
      [proposalToVerify,contactToInspect,interviewToInspect]=checks.map(r=>r.count);
    }
    const priority=[...rows].sort((a,b)=>(PRIORITY[a.status]??99)-(PRIORITY[b.status]??99)
      ||String(b.updated_at||'').localeCompare(String(a.updated_at||''))).slice(0,5).map(shape);
    return json(res,200,{
      partial, period:{from:period.from,to:period.to,key:period.key},
      countBasis:'selected_period_last_updated', source:'sales_synced',updatedAt:new Date().toISOString(),
      metrics:{openCases:fullCount,proposalToVerify,contactToInspect,interviewToInspect},
      priority,conditionsVerified:false,
      note:'選択期間に更新された進行中のSales提案です。過去時点の状態復元ではありません。'
        +(partial?'上位候補は最大500件からの参考抽出です。':'')
    });
  }catch{
    return json(res,503,{error:'sales_decision_unavailable',hint:'判断用の営業情報を取得できません。'});
  }
}
