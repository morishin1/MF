// Historical assets belonging to a Sales company: discover -> staff verifies -> link.
// Original imported ENGER jobs, candidates and proposal rows are not rewritten.
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope,logPortalEvent} from "../../lib/sales-company-portal-db.js";
import {companySearchKeyword,verifiedMailDomain,candidateEvidence,historicalRow}
 from "../../lib/sales-company-history-lookup.js";

const TABLE="dx2_sales_company_history_links";
const LIMIT=150;
const bad=(res,error,hint,status=400)=>json(res,status,{error,hint});
const TABLES={
 job:{name:"jobs",fields:"id,job_no,title,role_label,client_name,contact_email,posted_by_email,created_at,is_closed,deleted_at",match:["client_name","contact_email","posted_by_email"]},
 talent:{name:"candidates",fields:"id,candidate_no,title,company,source_company,contact_email,created_at,is_closed,deleted_at",match:["company","source_company","contact_email"]},
 proposal:{name:"proposals",fields:"id,job_title,company,stage,created_at,deleted_at",match:["company"]},
};
async function discover(db,company) {
 const keyword=companySearchKeyword(company.name),domain=verifiedMailDomain(company);
 const requests=[];
 for(const [type,def] of Object.entries(TABLES))for(const field of def.match){
   const isEmail=field.includes("email");
   if(isEmail&&!domain||!isEmail&&!keyword)continue;
   const val=isEmail?"%@"+domain:"%"+keyword+"%";
   requests.push({type,task:db.schema("enger").from(def.name).select(def.fields)
     .ilike(field,val).order("created_at",{ascending:false}).limit(LIMIT)});
 }
 const results=await Promise.all(requests.map(r=>r.task));
 if(results.some(r=>r.error))throw Error("search_failed");
 const found=new Map();
 let truncated=false;
 for(let i=0;i<results.length;i++) {
   const {type}=requests[i],rows=results[i].data||[];
   if(rows.length>=LIMIT)truncated=true;
   for(const row of rows) {
     const sourceKind=candidateEvidence(type,row,company,domain);
     if(!sourceKind)continue;
     const key=type+":"+row.id;
     const prior=found.get(key);
     if(!prior||sourceKind==="sender_domain")
       found.set(key,historicalRow(type,row,sourceKind));
   }
 }
 return {items:[...found.values()].sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""))).slice(0,240),
   truncated,domainMatched:Boolean(domain)};
}
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 res.setHeader?.("Cache-Control","private, no-store");
 if(!["GET","POST"].includes(req.method))return methodNotAllowed(res,["GET","POST"]);
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
   return bad(res,"forbidden","Salesの企業管理権限が必要です。",403);
 let input=null;
 if(req.method==="POST")try{input=await readJson(req);}catch{return bad(res,"bad_json","入力形式を確認してください。");}
 const params=new URL(req.url||"/","http://localhost").searchParams;
 const companyId=req.method==="GET"?params.get("companyId"):input?.companyId;
 if(!isUuid(companyId))return bad(res,"invalid_company","企業IDを確認してください。");
 const db=admin();
 const scope=await companyInScope(db,ctx.tenantId,companyId);
 if(!scope.ok)return bad(res,scope.error,"企業の閲覧権限がありません。",scope.status);
 const [company,stored]=await Promise.all([
   db.schema("enger").from("companies").select("id,name,contact_email,website")
     .eq("id",companyId).is("deleted_at",null).maybeSingle(),
   db.schema("enger").from(TABLE).select("entity_type,entity_id,source_kind,linked_at")
     .eq("tenant_id",ctx.tenantId).eq("company_id",companyId).limit(250),
 ]);
 if(company.error||!company.data||stored.error)return bad(res,"history_unavailable","履歴の照合情報を取得できませんでした。",503);
 let matches;
 try{matches=await discover(db,company.data);}
 catch{return bad(res,"search_unavailable","過去DBの照合候補を取得できませんでした。",503);}
 const linked=new Set((stored.data||[]).map(x=>x.entity_type+":"+x.entity_id));
 const items=matches.items.map(x=>({...x,linked:linked.has(x.type+":"+x.id)}));
 if(req.method==="GET"){
   return json(res,200,{companyId,items,counts:{
     jobs:items.filter(x=>x.type==="job").length,
     talents:items.filter(x=>x.type==="talent").length,
     proposals:items.filter(x=>x.type==="proposal").length,
     confirmed:stored.data?.length||0
   },partial:matches.truncated,
   note:"社名やメールドメインからの候補です。確認・紐づけ操作を行うまで企業情報として確定しません。"});
 }
 const type=input?.type,id=input?.itemId,action=input?.action;
 if(!["job","talent","proposal"].includes(type)||!isUuid(id)||
    !["confirm","unlink"].includes(action)||input.confirmed!==true)
   return bad(res,"invalid_request","照合する対象と確認操作を選んでください。");
 const exists=stored.data?.find(x=>x.entity_type===type&&x.entity_id===id);
 if(action==="confirm"){
   const item=matches.items.find(x=>x.type===type&&x.id===id);
   if(!item)return bad(res,"unmatched","この企業との関係を確認できる履歴がありません。",409);
   if(exists)return json(res,200,{ok:true,alreadyLinked:true});
   const inserted=await db.schema("enger").from(TABLE).insert({
     tenant_id:ctx.tenantId,company_id:companyId,entity_type:type,
     entity_id:id,source_kind:item.sourceKind,confirmed_by:user.id,
   });
   if(inserted.error)return bad(res,"link_failed","企業への紐づけを保存できませんでした。",503);
 }else{
   if(!exists)return json(res,200,{ok:true,alreadyUnlinked:true});
   const removed=await db.schema("enger").from(TABLE).delete()
      .eq("tenant_id",ctx.tenantId).eq("company_id",companyId)
      .eq("entity_type",type).eq("entity_id",id);
   if(removed.error)return bad(res,"unlink_failed","紐づけの解除に失敗しました。",503);
 }
 await logPortalEvent(db,{companyId,actorKind:"staff",actorUserId:user.id,
   action:"historical."+action,targetId:id,
   detail:{type,sourceKind:exists?.source_kind||matches.items.find(x=>x.type===type&&x.id===id)?.sourceKind}});
 return json(res,200,{ok:true,action,type,itemId:id});
}
