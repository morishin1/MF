// GET /api/sales/enger-company-directory?bucket=existing|revive|new&page=1&q=&siSes=1&priority=A
// ENGER companies is the source of truth. Sales company IDs are not inferred from names.
// This is read-only with authenticated Sales access, no PII, no mutations or outbound messages.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
const BUCKETS=["existing","revive","new"];
const PAGE_SIZE=50;
const FIELDS="id,name,status,industry,website,prefecture,data_source,created_at,meeting_done_at,is_end_client,source_priority,historical_contact_date,historical_activity_count,needs_contact_review,bucket,classification_basis,si_ses_candidate,effective_priority,manual_priority,relationship_status,relationship_evidence,directory_hidden_at";
const SORTS=new Set(["name","effective_priority","status","industry","prefecture","historical_activity_count","historical_contact_date","created_at","si_ses_candidate","relationship_status"]);
const validSearch=value=>String(value||"").trim().slice(0,80).replace(/[%_\\*()[\],]/g,"");
export default async function handler(req,res){
  const user=await requireUser(req,res);if(!user)return;
  if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
  res.setHeader?.("Cache-Control","private, no-store");
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:"forbidden"});
  const p=new URL(req.url||"/","http://localhost").searchParams;
  const bucket=p.get("bucket")||"revive";
  const page=Number(p.get("page")||1),sector=p.get("siSes")==="1";
  const priority=p.get("priority")||"";
  const sort=p.get("sort")||"effective_priority";
  const direction=p.get("direction")||"asc";
  const includeHidden=p.get("includeHidden")==="1";
  if(!BUCKETS.includes(bucket)||!Number.isInteger(page)||page<1||page>20000
     ||(priority&&!["A","B","C","D"].includes(priority)) || !["","0","1"].includes(p.get("siSes")||"")
     || !SORTS.has(sort) || !["asc","desc"].includes(direction)
     || !["","0","1"].includes(p.get("includeHidden")||""))
    return json(res,400,{error:"invalid_filter"});
  const q=validSearch(p.get("q"));
  try{
    const db=admin();
    const queryFor=(select,options)=> {
      let x=db.schema("enger").from("dx2_sales_company_directory_for_tenant").select(select,options)
        .eq("tenant_id",ctx.tenantId).eq("bucket",bucket);
      if(!includeHidden)x=x.is("directory_hidden_at",null);
      if(q) x=x.ilike("name",`%${q}%`);
      if(sector)x=x.eq("si_ses_candidate",true);
      if(priority)x=x.eq("effective_priority",priority);
      return x;
    };
    const [list,existing,revive,fresh,total,siSes]=await Promise.all([
      queryFor(FIELDS,{count:"exact"}).order(sort,{ascending:direction==="asc",nullsFirst:false})
       .order("name",{ascending:true}).order("id",{ascending:true})
        .range((page-1)*PAGE_SIZE,page*PAGE_SIZE-1),
      db.schema("enger").from("dx2_sales_company_directory_for_tenant").select("id",{count:"exact",head:true})
       .eq("tenant_id",ctx.tenantId).eq("bucket","existing").is("directory_hidden_at",null),
      db.schema("enger").from("dx2_sales_company_directory_for_tenant").select("id",{count:"exact",head:true})
       .eq("tenant_id",ctx.tenantId).eq("bucket","revive").is("directory_hidden_at",null),
      db.schema("enger").from("dx2_sales_company_directory_for_tenant").select("id",{count:"exact",head:true})
       .eq("tenant_id",ctx.tenantId).eq("bucket","new").is("directory_hidden_at",null),
      db.schema("enger").from("dx2_sales_company_directory_for_tenant").select("id",{count:"exact",head:true}).eq("tenant_id",ctx.tenantId),
      db.schema("enger").from("dx2_sales_company_directory_for_tenant").select("id",{count:"exact",head:true})
       .eq("tenant_id",ctx.tenantId).eq("si_ses_candidate",true),
    ]);
    if([list,existing,revive,fresh,total,siSes].some(x=>x.error||x.count==null))
      return json(res,503,{error:"directory_unavailable",hint:"ENGER企業DBを完全に確認できませんでした。省略した件数を表示しません。"});
    const rows=(list.data||[]).map(r=>({
      id:r.id,name:r.name,status:r.status||null,industry:r.industry||null,
      website:/^https?:\/\//i.test(r.website||"")?String(r.website).slice(0,300):null,
      prefecture:r.prefecture||null,source:r.data_source||null,
      sourcePriority:r.source_priority||null,
      priority:r.effective_priority||null,manualPriority:r.manual_priority||null,
      relationshipStatus:r.relationship_status||"unknown",
      relationshipEvidence:r.relationship_evidence||null,excluded:Boolean(r.directory_hidden_at),
      historicalContactDate:r.historical_contact_date||null,
      historicalActivityCount:r.historical_activity_count||0,
      needsContactReview:Boolean(r.needs_contact_review),
      bucket:r.bucket,classificationBasis:r.classification_basis,
      siSesCandidate:Boolean(r.si_ses_candidate),
      meetingDoneAt:r.meeting_done_at||null,
    }));
    return json(res,200,{
      source:"enger.companies",complete:true,readonly:false,
      total:total.count,sectorTotal:siSes.count,
      counts:{existing:existing.count,revive:revive.count,new:fresh.count},
      selectedCount:list.count,page,pageSize:PAGE_SIZE,sort,direction,includeHidden,
      rows,
      note:"既存/掘り起こし/新規は営業確認の優先区分であり、契約や発注確認の証明ではありません。連絡先は企業詳細で別途確認してください。",
    });
  }catch{
    return json(res,503,{error:"directory_unavailable",hint:"ENGER企業DBに接続できません。"});
  }
}
