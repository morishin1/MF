// Curated, scoped answers only; browsing and searching never invokes an LLM.
import {json} from '../lib/http.js';
import {requireUser} from '../lib/auth.js';
import {gwContext,canManageHr,canAccessOffice} from '../lib/gw.js';
import {admin} from '../lib/supabase.js';
import {CATEGORIES,CATEGORY_CODES,allowedKnowledgeScopes,searchKnowledge} from '../lib/ai-knowledge.js';
const safeLink=s=>{if(typeof s!=='string'||!s||s.startsWith('//')||/[\s\\\u0000-\u001f]/.test(s))return null;try{const u=new URL(s,'https://groupware.invalid');return u.protocol==='https:'&&!u.username&&!u.password&&(s.startsWith('https://')||(!/^[\w+.-]+:/.test(s)&&u.origin==='https://groupware.invalid'))?s:null;}catch{return null;}};
export function createHandler(deps={}){const D={requireUser,gwContext,admin,...deps};return async(req,res)=>{
 res.setHeader('Cache-Control','private,no-store');const user=await D.requireUser(req,res);if(!user)return;
 const ctx=await D.gwContext(user.id);if(!ctx.tenantId||!ctx.employee)return json(res,403,{error:'not_enrolled'});
 if(req.method!=='GET')return json(res,405,{error:'method_not_allowed'});
 const q=new URL(req.url,'http://localhost').searchParams,query=(q.get('q')||'').trim(),category=q.get('category')||'';
 if(query.length>200||category&&!CATEGORY_CODES.includes(category))return json(res,400,{error:'invalid_query'});
 try{
  const sb=D.admin(),scopes=allowedKnowledgeScopes(ctx,canManageHr,canAccessOffice);let rows;
  if(query)rows=await searchKnowledge(sb,{tenantId:ctx.tenantId,scopes,query,category:category||undefined,limit:30});
  else{let select=sb.from('gw_ai_knowledge').select('id,title,category,content,link_url,link_label,updated_at').eq('tenant_id',ctx.tenantId).eq('is_active',true).in('access_scope',scopes).order('updated_at',{ascending:false}).limit(100);if(category)select=select.eq('category',category);const r=await select;if(r.error)throw r.error;rows=r.data||[];}
  return json(res,200,{questions:rows.map(r=>({id:r.id,title:r.title,category:r.category,answer:r.content,sourceUrl:safeLink(r.link_url),sourceLabel:r.link_label,updatedAt:r.updated_at})),categories:CATEGORIES,canManage:canManageHr(ctx)});
 }catch{return json(res,503,{error:'questions_unavailable',hint:'Q&Aを読み込めませんでした。時間をおいて再読み込みしてください。'});}
};}
export default createHandler();
