import {evaluateScores} from '../../../lib/company-evaluation-policy.js';
import { requireUser } from '../../../lib/auth.js';
import { gwContext, canSell } from '../../../lib/gw.js';
import { userClient, admin } from '../../../lib/supabase.js';
import { json, methodNotAllowed, readJson } from '../../../lib/http.js';
import { canManageProposals } from '../../../lib/sales-proposals.js';
import { EVALUATION_TABLE, EVALUATION_HISTORY_TABLE, UUID, normalizeEvaluationSave, canConfirmEvaluation } from '../../../lib/company-evaluation-save.js';
async function handle(req,res) {
  const user = await requireUser(req,res); if (!user) return;
  if (!['GET','POST'].includes(req.method)) return methodNotAllowed(res,['GET','POST']);
  res.setHeader?.('Cache-Control','private, no-store');
  const ctx=await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx) || !canManageProposals(ctx)) return json(res,403,{error:'forbidden'});
  if (req.method === 'POST') {
    if (!canConfirmEvaluation(ctx)) return json(res,403,{error:'admin_required'});
    const body = await readJson(req); const normalized = normalizeEvaluationSave(body,ctx);
    if (normalized.error) return json(res,normalized.status,{error:normalized.error,hint:normalized.error==='improvement_review_required' ? 'D確定には改善協議済み・進展なしの両方の確認が必要です。' : normalized.error==='complete_evidence_required' ? '確定には5項目すべての点数・直近90日の確認日・根拠が必要です。' : '点数・確認日・根拠・判断理由・ランクと方針の組み合わせを確認してください。'});
    const value=normalized.value;
    const {data,error}=await admin().rpc('gw_sales_save_company_evaluation',{
      p_tenant:ctx.tenantId,p_company:value.companyId,p_actor:user.id,p_expected_revision:value.expectedRevision,
      p_request_id:value.requestId,p_evaluation:value.evaluation,
    });
    if(error) return json(res,503,{error:'evaluation_save_unavailable',hint:'保存基盤を確認してください。保存完了とは扱わず、再読込で状態を確認してください。'});
    if (['revision_conflict','idempotency_conflict'].includes(data?.status)) return json(res,409,{error:data.status,currentRevision:data.revision});
    if (!['saved','replayed'].includes(data?.status)) return json(res,503,{error:'evaluation_save_unconfirmed'});
    return json(res,200,data);
  }
  const companyId=String(req.query?.company_id || '');
  if (!UUID.test(companyId)) return json(res,400,{error:'invalid_company_id'});
  const sb=userClient(req);
  const company=await sb.from('gw_sales_companies').select('id,name').eq('tenant_id',ctx.tenantId).eq('id',companyId).maybeSingle();
  if(company.error)return json(res,503,{error:'company_unavailable'});
  if(!company.data)return json(res,404,{error:'company_not_found'});
  const [current,history]=await Promise.all([
    sb.from(EVALUATION_TABLE).select('tenant_id,company_id,revision::text,evaluation,updated_at,updated_by').eq('tenant_id',ctx.tenantId).eq('company_id',companyId).maybeSingle(),
    sb.from(EVALUATION_HISTORY_TABLE).select('revision::text,evaluation,created_at,actor_id').eq('tenant_id',ctx.tenantId).eq('company_id',companyId).order('revision',{ascending:false}).limit(20),
  ]);
  if(current.error || history.error)return json(res,503,{error:'evaluation_storage_unavailable',hint:'評価保存のDB準備がまだ確認できません。保存・確定はできません。'});
  return json(res,200,{company:company.data,current:current.data,history:history.data || [],canConfirm:canConfirmEvaluation(ctx),needsReevaluation:Boolean(current.data && evaluateScores(current.data.evaluation.scores || {}).score==null),enforcementEnabled:false});
}

export default async function handler(req,res) {
  try { return await handle(req,res); }
  catch { return json(res,503,{error:'evaluation_request_unavailable',hint:'保存完了は未確認です。自動再送せず、最新状態を再確認してください。'}); }
}
