import {readJson,json,methodNotAllowed} from '../../../lib/http.js';
import {admin} from '../../../lib/supabase.js';
import {verifyGwSignature} from '../../../lib/sales-proposal-intake.js';
import {UUID} from '../../../lib/company-evaluation-save.js';
import {REVIEW_PURPOSE,validateCompanyReviewSnapshot} from '../../../lib/company-review-snapshot.js';
async function handle(req,res) {
  if(req.method!=='POST')return methodNotAllowed(res,['POST']);
  if(process.env.COMPANY_EVALUATION_LINK_ENABLED!=='1')return json(res,503,{error:'evaluation_link_disabled'});
  const secret=process.env.ENGER_SALES_SECRET || '',tenant=process.env.SALES_PROPOSAL_TENANT_ID || '';
  if(secret.length<32 || !UUID.test(tenant))return json(res,503,{error:'not_configured'});
  const body=await readJson(req);const auth=verifyGwSignature(req.headers,body,REVIEW_PURPOSE,{secret});if(!auth.ok)return json(res,auth.status,{error:auth.error});
  const checked=validateCompanyReviewSnapshot(body);if(checked.error)return json(res,400,{error:checked.error});
  const s=checked.value;
  const {data,error}=await admin().rpc('gw_sales_apply_company_review_snapshot',{p_tenant:tenant,p_snapshot_id:s.snapshotId,p_observed_at:s.observedAt,p_window_start:s.windowStart,p_companies:s.companies});
  if(error)return json(res,503,{error:'review_snapshot_unavailable'});
  if(['stale','snapshot_conflict'].includes(data?.status))return json(res,409,{error:data.status});
  if(!['applied','replayed'].includes(data?.status))return json(res,503,{error:'snapshot_result_unconfirmed'});
  return json(res,200,data);
}

export default async function handler(req,res) {
  try { return await handle(req,res); }
  catch { return json(res,503,{error:'review_snapshot_unavailable',hint:'集計反映は未確認です。'}); }
}
