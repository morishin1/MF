import { requireUser } from '../../lib/auth.js';
import { gwContext,canRecruit } from '../../lib/gw.js';
import { admin } from '../../lib/supabase.js';
import { json,readJson,methodNotAllowed } from '../../lib/http.js';
import { gwLog } from '../../lib/gw-audit.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private,no-store');
 const u=await requireUser(req,res);if(!u)return;
 const ctx=await gwContext(u.id);if(!ctx.tenantId||!canRecruit(ctx))return json(res,403,{error:'forbidden'});
 if(req.method!=='POST')return methodNotAllowed(res,['POST']);
 const b=await readJson(req);if(!/^[a-f0-9-]{36}$/i.test(b?.id||'')||!['confirmed','defective'].includes(b.state))return json(res,400,{error:'invalid_body'});
 const sb=admin();const {data:d,error}=await sb.from('gw_hr_documents').select('id,applicant_id').eq('tenant_id',ctx.tenantId).eq('id',b.id).is('deleted_at',null).maybeSingle();
 if(error)return json(res,503,{error:'not_ready'});if(!d)return json(res,404,{error:'not_found'});
 const note=String(b.note||'').trim().slice(0,500);if(b.state==='defective'&&!note)return json(res,400,{error:'reason_required'});
 const {error:e}=await sb.from('gw_hr_document_reviews').upsert({tenant_id:ctx.tenantId,document_id:d.id,state:b.state,note,reviewed_by:u.id,reviewed_at:new Date().toISOString()});
 if(e)return json(res,503,{error:'not_ready'});
 await gwLog({tenantId:ctx.tenantId,actorId:u.id,action:'hr.document_review',target:'hr_applicant:'+d.applicant_id,detail:{documentId:d.id,state:b.state}});
 return json(res,200,{ok:true});
}
