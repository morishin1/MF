// One-company AI research, initiated explicitly from an authorized Sales detail.
// The ten-company pilot batch is intentionally separate from this endpoint.
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell,isOwner} from '../../lib/gw.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {json,methodNotAllowed} from '../../lib/http.js';
import {runOne} from './company-ai-pilot.js';

export const config={maxDuration:60};
export default async function handler(req,res){
  res.setHeader?.('Cache-Control','private, no-store');
  const user=await requireUser(req,res);if(!user)return;
  if(req.method!=='POST')return methodNotAllowed(res,['POST']);
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx)||!isOwner(ctx))
    return json(res,403,{error:'owner_only',hint:'この企業のAI分析は経営者権限で実行してください。'});
  return runOne(req,res,ctx,{single:true,actorId:user.id});
}
