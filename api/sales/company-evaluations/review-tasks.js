import {requireUser} from '../../../lib/auth.js';
import {gwContext,canSell} from '../../../lib/gw.js';
import {userClient} from '../../../lib/supabase.js';
import {json,methodNotAllowed} from '../../../lib/http.js';
import {canManageProposals} from '../../../lib/sales-proposals.js';
async function handle(req,res) {
 const user=await requireUser(req,res);if(!user)return;
 if(req.method!=='GET')return methodNotAllowed(res,['GET']);
 res.setHeader?.('Cache-Control','private, no-store');
 const ctx=await gwContext(user.id);if(!ctx.tenantId||!canSell(ctx))return json(res,403,{error:'forbidden'});
 const manager=canManageProposals(ctx);if(!manager&&!ctx.employee?.id)return json(res,403,{error:'employee_required'});
 const page=String(req.query?.page || '0');if(!/^(0|[1-9][0-9]{0,2})$/.test(page))return json(res,400,{error:'invalid_page'});
 const sb=userClient(req),offset=Number(page)*100;
 let q=sb.from('gw_sales_company_review_tasks').select('id,source_company_id,kind,status,company_id,assignee_id,due_at,first_seen,last_seen,counts')
  .eq('tenant_id',ctx.tenantId).eq('status','open');if(!manager)q=q.eq('assignee_id',ctx.employee.id);
 const result=await q.order('first_seen',{ascending:true}).order('id',{ascending:true}).range(offset,offset+100);
 if(result.error)return json(res,503,{error:'review_queue_unavailable',hint:'企業審査の保存基盤が未確認です。未取得を確認事項ゼロとは扱いません。'});
 const rows=(result.data || []).slice(0,100);const ids=[...new Set(rows.map(x=>x.company_id).filter(Boolean))];
 let names=new Map();if(ids.length){const c=await sb.from('gw_sales_companies').select('id,name').eq('tenant_id',ctx.tenantId).in('id',ids);if(c.error)return json(res,503,{error:'review_company_unavailable'});names=new Map((c.data || []).map(x=>[x.id,x.name]));}
 return json(res,200,{items:rows.map(x=>({...x,companyName:names.get(x.company_id)||'企業IDの照合が必要',assignmentKnown:Boolean(x.assignee_id),deadlineKnown:Boolean(x.due_at)})),hasMore:(result.data||[]).length>100,page:Number(page),scope:manager?'team':'assigned',enforcementEnabled:false,linkEnabled:process.env.COMPANY_EVALUATION_LINK_ENABLED==='1'});
}

export default async function handler(req,res) {
  try { return await handle(req,res); }
  catch { return json(res,503,{error:'review_queue_unavailable',hint:'企業審査の確認事項は未取得です。ゼロ件とは扱いません。'}); }
}
