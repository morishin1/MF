// One-company AI research, initiated explicitly from an authorized Sales detail.
// The ten-company pilot batch is intentionally separate from this endpoint.
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {json,methodNotAllowed} from '../../lib/http.js';
import {admin} from '../../lib/supabase.js';
import {companyInScope} from '../../lib/sales-company-portal-db.js';
import {runOne} from './company-ai-pilot.js';

export const config={maxDuration:60};
export default async function handler(req,res){
  res.setHeader?.('Cache-Control','private, no-store');
  const user=await requireUser(req,res);if(!user)return;
  if(req.method!=='POST')return methodNotAllowed(res,['POST']);
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
    return json(res,403,{error:'sales_permission_required',hint:'この企業のAI分析にはSales権限が必要です。'});
  // Verify the actual ENGER company is in this Sales tenant before any
  // registration/linking or AI model call. This is not the owner-only batch API.
  const companyId=req.body?.companyId;
  if(typeof companyId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId))
    return json(res,400,{error:'invalid_company_id'});
  const scope=await companyInScope(admin(),ctx.tenantId,companyId);
  if(!scope.ok)return json(res,scope.status,{error:scope.error});
  return runOne(req,res,ctx,{single:true,actorId:user.id});
}
