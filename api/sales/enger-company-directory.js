// GET /api/sales/enger-company-directory?bucket=existing|revive|new&page=1&q=&siSes=1&priority=A
// ENGER companies is the source of truth. Sales company IDs are not inferred from names.
// This is read-only with authenticated Sales access, no PII, no mutations or outbound messages.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {admin} from "../../lib/supabase.js";
const BUCKETS=["existing","revive","new"];
const PAGE_SIZE=50;
const FIELDS="id,name,status,industry,website,prefecture,data_source,created_at,meeting_done_at,is_end_client,source_priority,historical_contact_date,historical_activity_count,needs_contact_review,bucket,classification_basis,si_ses_candidate";
const validSearch=value=>String(value||"").trim().slice(0,80).replace(/[%_\\*()[\],]/g,"");
export default async function handler(req,res){
  const user=await requireUser(req,res);if(!user)return;
  if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
  res.setHeader?.("Cache-Control","private, no-store");
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx))return json(res,403,{error:"forbidden"});
  const p=new URL(req.url||"/","http://localhost").searchParams;
  const bucket=p.get("bucket")||"revive";
  const page=Number(p.get("page")||1),sector=p.get("siSes")==="1";
  const priority=p.get("priority")||"";
  if(!BUCKETS.includes(bucket)||!Number.isInteger(page)||page<1||page>20000
     ||(priority&&!["A","B","C","D"].includes(priority)) || !["","0","1"].includes(p.get("siSes")||""))
    return json(res,400,{error:"invalid_filter"});
  const q=validSearch(p.get("q"));
  try{
    const db=admin();
    const queryFor=(select,options)=> {
      let x=db.schema("enger").from("dx2_sales_company_directory").select(select,options).eq("bucket",bucket);
      if(q) x=x.ilike("name",`%${q}%`);
      if(sector)x=x.eq("si_ses_candidate",true);
      if(priority)x=x.eq("source_priority",priority);
      return x;
    };
    const [list,existing,revive,fresh,total,siSes]=await Promise.all([
      queryFor(FIELDS,{count:"exact"}).order("name",{ascending:true}).order("id",{ascending:true})
        .range((page-1)*PAGE_SIZE,page*PAGE_SIZE-1),
      db.schema("enger").from("dx2_sales_company_directory").select("id",{count:"exact",head:true}).eq("bucket","existing"),
      db.schema("enger").from("dx2_sales_company_directory").select("id",{count:"exact",head:true}).eq("bucket","revive"),
      db.schema("enger").from("dx2_sales_company_directory").select("id",{count:"exact",head:true}).eq("bucket","new"),
      db.schema("enger").from("dx2_sales_company_directory").select("id",{count:"exact",head:true}),
      db.schema("enger").from("dx2_sales_company_directory").select("id",{count:"exact",head:true}).eq("si_ses_candidate",true),
    ]);
    if([list,existing,revive,fresh,total,siSes].some(x=>x.error||x.count==null))
      return json(res,503,{error:"directory_unavailable",hint:"ENGER企業DBを完全に確認できませんでした。省略した件数を表示しません。"});
    const rows=(list.data||[]).map(r=>({
      id:r.id,name:r.name,status:r.status||null,industry:r.industry||null,
      website:/^https?:\/\//i.test(r.website||"")?String(r.website).slice(0,300):null,
      prefecture:r.prefecture||null,source:r.data_source||null,
      sourcePriority:r.source_priority||null,
      historicalContactDate:r.historical_contact_date||null,
      historicalActivityCount:r.historical_activity_count||0,
      needsContactReview:Boolean(r.needs_contact_review),
      bucket:r.bucket,classificationBasis:r.classification_basis,
      siSesCandidate:Boolean(r.si_ses_candidate),
      meetingDoneAt:r.meeting_done_at||null,
    }));
    return json(res,200,{
      source:"enger.companies",complete:true,readonly:true,
      total:total.count,sectorTotal:siSes.count,
      counts:{existing:existing.count,revive:revive.count,new:fresh.count},
      selectedCount:list.count,page,pageSize:PAGE_SIZE,
      rows,
      note:"既存/掘り起こし/新規は営業確認の優先区分であり、契約や発注確認の証明ではありません。連絡先は企業詳細で別途確認してください。",
    });
  }catch{
    return json(res,503,{error:"directory_unavailable",hint:"ENGER企業DBに接続できません。"});
  }
}
