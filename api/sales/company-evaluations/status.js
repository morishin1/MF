import {evaluateScores} from '../../../lib/company-evaluation-policy.js';
// Server-to-server READ ONLY. Existing shared key, separate HMAC purpose, fixed configured tenant.
import {readJson,json,methodNotAllowed} from '../../../lib/http.js';
import {admin} from '../../../lib/supabase.js';
import {verifyGwSignature} from '../../../lib/sales-proposal-intake.js';
import {UUID,EVALUATION_TABLE} from '../../../lib/company-evaluation-save.js';
export const PURPOSE='company-evaluation-status';
async function handle(req,res) {
  if(req.method!=='POST')return methodNotAllowed(res,['POST']);
  res.setHeader?.('Cache-Control','private, no-store');
  if(process.env.COMPANY_EVALUATION_LINK_ENABLED!=='1')return json(res,503,{error:'evaluation_link_disabled'});
  const secret=process.env.ENGER_SALES_SECRET || '';const tenant=process.env.SALES_PROPOSAL_TENANT_ID || '';
  if(secret.length<32 || !UUID.test(tenant))return json(res,503,{error:'not_configured'});
  const body=await readJson(req);const auth=verifyGwSignature(req.headers,body,PURPOSE,{secret});
  if(!auth.ok)return json(res,auth.status,{error:auth.error});
  if(!Array.isArray(body?.source_company_ids)||body.source_company_ids.length<1||body.source_company_ids.length>50||body.source_company_ids.some(id=>typeof id!=='string'||!UUID.test(id)))return json(res,400,{error:'invalid_company_ids'});
  const ids=[...new Set(body.source_company_ids)];const sb=admin();
  const links=await sb.from('gw_sales_company_links').select('source_company_id,company_id').eq('tenant_id',tenant).eq('source_system','enger').in('source_company_id',ids).limit(100);
  if(links.error || (links.data || []).length>=100)return json(res,503,{error:'identity_unavailable'});
  const localIds=[...new Set((links.data || []).map(x=>x.company_id))];
  if(!localIds.length)return json(res,200,{items:[],missing:ids});
  const [companies,evaluations]=await Promise.all([
    sb.from('gw_sales_companies').select('id').eq('tenant_id',tenant).in('id',localIds),
    sb.from(EVALUATION_TABLE).select('company_id,revision::text,evaluation,updated_at').eq('tenant_id',tenant).in('company_id',localIds),
  ]);
  if(companies.error || evaluations.error)return json(res,503,{error:'evaluation_unavailable'});
  const valid=new Set((companies.data || []).map(x=>x.id));const byId=new Map((evaluations.data || []).map(x=>[x.company_id,x]));
  const items=[];
  for(const id of ids){const candidates=(links.data || []).filter(x=>x.source_company_id===id && valid.has(x.company_id));if(candidates.length!==1)continue;
    const row=byId.get(candidates[0].company_id);if(!row)continue;const e=row.evaluation;
    // No evidence/contacts/actor details cross systems; only the shared review summary.
    items.push({sourceCompanyId:id,revision:row.revision,status:e.status,score:e.score,rank:e.rank,suggestedRank:e.suggestedRank,policy:e.policy,reason:e.reason,reviewedAt:e.reviewedAt,updatedAt:row.updated_at,enforcementEnabled:false,needsReevaluation:evaluateScores(e.scores || {}).score==null});
  }
  return json(res,200,{items,missing:ids.filter(id=>!items.some(x=>x.sourceCompanyId===id))});
}

export default async function handler(req,res) {
  try { return await handle(req,res); }
  catch { return json(res,503,{error:'evaluation_unavailable',hint:'企業評価を取得できません。'}); }
}
