// Staff-authenticated, company-scoped meeting preview.
// Identical allowed field contract as ENGER Business shared recommendations.
// No partner company, names, contact info, cost, original CV or credentials.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope,readPublicCandidates} from "../../lib/sales-company-portal-db.js";
import {isPublicTalent,toPublicTalent} from "../../lib/enger-talent-public.js";
import {PUBLISHED_JOB_COLUMNS,jobAvailable,toPublicJob} from "../../lib/sales-company-share-public.js";
import {formatCompanyNumber} from "../../lib/sales-company-number.js";
import {parseMeetingSelection,matchMeetingSelection} from "../../lib/sales-meeting-selection.js";

export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 res.setHeader?.("Cache-Control","private, no-store");
 if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
   return json(res,403,{error:"forbidden"});
 const query=new URL(req.url||"/","http://localhost").searchParams;
 const id=query.get("companyId");
 if(!isUuid(id))return json(res,400,{error:"invalid_company"});
 const db=admin(),scope=await companyInScope(db,ctx.tenantId,id);
 if(!scope.ok)return json(res,scope.status,{error:scope.error});
 // 新商談ではDBの企業別セッションを唯一の公開候補リストとする。
 // URLから送られたselectionよりsessionIdに記録済みの候補が優先。
 let selection=parseMeetingSelection(query.get("selection"));
 const sessionId=query.get("sessionId");
 if(sessionId!==null){
   if(!isUuid(sessionId))return json(res,400,{error:"invalid_session"});
   const session=await db.from("gw_sales_live_meeting_sessions")
     .select("selected_keys").eq("id",sessionId)
     .eq("tenant_id",ctx.tenantId).eq("company_id",id).maybeSingle();
   if(session.error)return json(res,503,{error:"session_unavailable"});
   if(!session.data)return json(res,404,{error:"session_not_found"});
   const keys=session.data.selected_keys;
   if(!Array.isArray(keys)||keys.length>30||
      keys.some(k=>typeof k!=="string"||!/^(talent|job):[0-9a-f-]{36}$/i.test(k)||
        !isUuid(k.split(":")[1])))
     return json(res,503,{error:"session_invalid_selection"});
   selection={keys:new Set(keys.map(k=>k.toLowerCase()))};
   if(selection.keys.size!==keys.length)
     return json(res,503,{error:"session_duplicate_selection"});
 }else if(selection?.error)return json(res,400,{error:selection.error});
 const [company,links]=await Promise.all([
   db.schema("enger").from("companies").select("id,name,company_no")
     .eq("id",id).is("deleted_at",null).maybeSingle(),
   db.schema("enger").from("dx2_company_sales_shortlist")
     .select("id,item_type,candidate_id,job_id,published_at")
     .eq("tenant_id",ctx.tenantId).eq("company_id",id).eq("status","published")
     .order("published_at",{ascending:false}).limit(100),
 ]);
 if(company.error||!company.data||links.error)
   return json(res,503,{error:"meeting_unavailable",hint:"商談画面のデータを取得できませんでした。"});
 const rows=(links.data||[]).filter(r=>matchMeetingSelection(r,selection));
 if(selection && rows.length!==selection.keys.size)
   return json(res,409,{error:"selection_not_published",
     hint:"選択した候補の一部は公開承認済みではありません。企業へ見せる候補を確認してください。"});
 const cids=[...new Set(rows.filter(x=>x.item_type==="talent").map(x=>x.candidate_id).filter(isUuid))];
 const jids=[...new Set(rows.filter(x=>x.item_type==="job").map(x=>x.job_id).filter(isUuid))];
 const [talents,jobs]=await Promise.all([
   cids.length?readPublicCandidates(db,q=>q.in("id",cids),cids.length):Promise.resolve({rows:[]}),
   jids.length?db.schema("enger").from("jobs").select(PUBLISHED_JOB_COLUMNS)
     .in("id",jids).limit(jids.length):Promise.resolve({data:[]}),
 ]);
 if(talents.error||jobs.error)
   return json(res,503,{error:"assets_unavailable",hint:"公開情報を照合できませんでした。"});
 const ts=new Map((talents.rows||[]).filter(isPublicTalent).map(x=>[x.id,toPublicTalent(x)]));
 const js=new Map((jobs.data||[]).filter(jobAvailable).map(x=>[x.id,toPublicJob(x)]));
 const items=rows.flatMap(x=>{
   const item=x.item_type==="talent"?ts.get(x.candidate_id):js.get(x.job_id);
   if(!item)return [];
   const safe=x.item_type==="job"?{...item,id:undefined}:item;
   return [{type:x.item_type,key:x.item_type+":"+(x.item_type==="talent"?x.candidate_id:x.job_id),sharedAt:x.published_at,
      title:x.item_type==="talent"?(safe.talentNo||"人材")+" "+(safe.title||"エンジニア"):
        (safe.jobNo||"案件")+" "+safe.title,
      skills:(safe.skills||[]).slice(0,8),
      meta:x.item_type==="talent"?
        [safe.availability,safe.experience,safe.remoteLabel].filter(Boolean).join(" ／ "):
        [safe.remote,safe.location].filter(Boolean).join(" ／ "),
   }];
 });
 return json(res,200,{companyName:scope.company.name,displayId:formatCompanyNumber(company.data.company_no),
   items,count:items.length,withheld:rows.length-items.length,
   selectedOnly:Boolean(selection),selectedCount:selection?selection.keys.size:null,
   staffPreview:true,
   note:"これは社内認証で開く商談用プレビューです。企業担当者のログインやパスワードを代行せず、公開承認済みの候補だけ表示します。"});
}
