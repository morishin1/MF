import {json,methodNotAllowed} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {admin} from '../../lib/supabase.js';
import {historyFilters,historyRow} from '../../lib/sales-company-history.js';
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 if(req.method!=='GET')return methodNotAllowed(res,['GET']);res.setHeader?.('Cache-Control','private, no-store');
 const ctx=await gwContext(user.id);if(!canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:'forbidden'});
 const params=new URL(req.url,'http://localhost').searchParams;let f;
 try{f=historyFilters(params);}catch{return json(res,400,{error:'invalid_filter',hint:'日付・検索条件を確認してください。'});}
 try{
  const db=admin(),base=()=>db.from('gw_sales_company_history');
  const totalRequest=base().select('id',{count:'exact',head:true}).eq('tenant_id',ctx.tenantId);
  if(params.get('summary')==='1'){const t=await totalRequest;if(t.error||t.count==null)throw Error();return json(res,200,{total:t.count,complete:true});}
  let q=base().select('id,company_id,sales_company_id,company_name,company_available,occurred_at,kind,source,actor_name,label,subject,detail,next_action,next_date',{count:'exact'}).eq('tenant_id',ctx.tenantId);
  if(f.kind)q=q.eq('kind',f.kind);
  if(f.from)q=q.gte('occurred_at',f.from);if(f.to)q=q.lt('occurred_at',f.to);
  if(f.q)q=q.ilike('search_text','%'+f.q.replace(/[\\%_]/g,'\\$&')+'%');
  const [rows,total]=await Promise.all([q.order('occurred_at',{ascending:false}).order('id',{ascending:false}).range((f.page-1)*50,f.page*50-1),totalRequest]);
  if(rows.error||rows.count==null||!Array.isArray(rows.data)||total.error||total.count==null)throw Error();
  return json(res,200,{rows:rows.data.map(historyRow),selectedCount:rows.count,total:total.count,page:f.page,pageSize:50,complete:true});
 }catch{return json(res,503,{error:'history_unavailable',hint:'履歴を取得できませんでした。「再取得」で確認してください。'});}
}
