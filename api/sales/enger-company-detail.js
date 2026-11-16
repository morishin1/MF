// GET /api/sales/enger-company-detail?id=...
// Verified company ID and factual evidence only. Do not infer transactions by name.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {readSalesCompanies} from "../../lib/sales-enger-company.js";
import {formatCompanyNumber} from "../../lib/sales-company-number.js";
export default async function handler(req,res) {
 const user=await requireUser(req,res);if(!user)return;
 if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
 res.setHeader?.("Cache-Control","private, no-store");
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:"forbidden"});
 const id=new URL(req.url||"/","http://localhost").searchParams.get("id");
 if(!isUuid(id))return json(res,400,{error:"invalid_id",hint:"企業IDが正しくありません。一覧を再読み込みしてください。"});
 try{
  const db=admin();
  const [detail,company,touchpoints,proposalCount,intake,links] = await Promise.all([
   db.schema("enger").from("dx2_sales_company_directory_for_tenant")
     .select("id,name,bucket,source_priority,effective_priority,manual_priority,classification_basis,relationship_status,relationship_evidence,needs_contact_review,directory_hidden_at,industry,website,prefecture,status,meeting_done_at,historical_contact_date,historical_activity_count,si_ses_candidate")
     .eq("tenant_id",ctx.tenantId).eq("id",id).maybeSingle(),
   db.schema("enger").from("companies")
     .select("id,company_no,name,website,contact_form_url,phone,contact_email,contact_name,address,prefecture,corporate_number,industry,status,tags,note,last_activity,last_contacted_at,meeting_done,meeting_done_at,is_end_client,is_favorite,created_at,data_source")
     .eq("id",id).is("deleted_at",null).maybeSingle(),
   db.schema("enger").from("company_touchpoints")
     .select("id,occurred_at,kind,summary,detail,next_action,next_due,created_by",{count:"exact"})
     .eq("company_id",id).order("occurred_at",{ascending:false}).limit(200),
   db.schema("enger").from("proposals").select("id",{count:"exact",head:true})
     .eq("company_id",id).is("deleted_at",null),
   db.schema("enger").from("dx2_sales_company_supply_pipeline")
     .select("id,request_kind,stage,created_at,updated_at,job_id,candidate_id")
     .eq("company_id",id).eq("tenant_id",ctx.tenantId)
     .order("created_at",{ascending:false}).limit(30),
   db.from("gw_sales_company_links")
     .select("company_id").eq("tenant_id",ctx.tenantId)
     .eq("source_system","enger").eq("source_company_id",id).limit(2),
  ]);
  const results=[detail,company,touchpoints,proposalCount,intake,links];
  if(results.some(x=>x.error))
    return json(res,503,{error:"company_evidence_unavailable",hint:"企業情報・履歴の一部を照合できません。欠損を実績0件として表示しません。"});
  if(!detail.data||!company.data)return json(res,404,{error:"company_not_found"});
  if(proposalCount.count==null)return json(res,503,{error:"proposal_count_unavailable"});
  const s=detail.data,c=company.data;
  const salesLink=(links.data||[]).length===1?links.data[0].company_id:null;
  const sales=(await readSalesCompanies(db,ctx.tenantId,[id])).get(id)||null;
  // Phone and email are saved contact data, not proof of current consent or validity.
  return json(res,200,{
   company:{
     id:c.id,companyNo:c.company_no,displayId:formatCompanyNumber(c.company_no),name:c.name,industry:c.industry||null,status:c.status||null,corporateNumber:c.corporate_number||null,
     website:sales?sales.website:(/^https?:\/\//i.test(c.website||"")?String(c.website).slice(0,500):null),
     formUrl:sales?sales.formUrl:c.contact_form_url||null,
     phone:sales?sales.phone:c.phone||null,contactEmail:sales?(sales.emails[0]||null):c.contact_email||null,contactName:c.contact_name||null,
     sales,
     address:c.address||null,prefecture:c.prefecture||null,note:c.note||null,
     lastActivity:c.last_activity||null,lastContactedAt:c.last_contacted_at||null,
     meetingDone:Boolean(c.meeting_done),meetingDoneAt:c.meeting_done_at||null,
     isEndClient:Boolean(c.is_end_client),isFavorite:Boolean(c.is_favorite),tags:Array.isArray(c.tags)?c.tags:null,dataSource:c.data_source||null,
     // Canonical source values for optimistic bulk edits. Display contacts may come from linked Sales.
     editSource:{
       name:c.name,contactName:c.contact_name||null,contactEmail:c.contact_email||null,
       phone:c.phone||null,address:c.address||null,industry:c.industry||null,
       website:c.website||null,formUrl:c.contact_form_url||null,status:c.status||null,
       note:c.note||null,isFavorite:Boolean(c.is_favorite),isEndClient:Boolean(c.is_end_client),tags:Array.isArray(c.tags)?c.tags:null,
     },
     sourcePriority:s.source_priority||null,priority:s.effective_priority||null,
     manualPriority:s.manual_priority||null,bucket:s.bucket,classificationBasis:s.classification_basis,
     relationshipStatus:s.relationship_status||"unknown",
     relationshipEvidence:s.relationship_evidence||null,
     needsContactReview:Boolean(s.needs_contact_review),
     directoryExcluded:Boolean(s.directory_hidden_at),
     historicalContactDate:s.historical_contact_date||null,
     historicalActivityCount:s.historical_activity_count||0,
     siSesCandidate:Boolean(s.si_ses_candidate),
   },
   evidence:{
     touchpointCount:touchpoints.count??(touchpoints.data||[]).length,
     touchpoints:(touchpoints.data||[]).map(x=>({
       id:x.id,occurredAt:x.occurred_at,kind:x.kind,summary:x.summary,
       detail:x.detail,nextAction:x.next_action,nextDue:x.next_due,createdBy:x.created_by||null,
     })),
     proposalCount:proposalCount.count,
     hasHistoricalMeetingRecord:Boolean(c.meeting_done),
     registeredSupplies:(intake.data||[]).filter(x=>x.stage==="registered").length,
     intakeCount:(intake.data||[]).length,
     linkedSalesCompanyId:salesLink,
     salesLinkAmbiguous:(links.data||[]).length>1,
   },
   warning:"旧資料の優先度や打ち合わせ履歴は過去の契約・売上を証明しません。明示的に確認した契約情報のみ取引ありと判定します。",
  });
 }catch{
  return json(res,503,{error:"company_evidence_unavailable",hint:"企業の詳細・取引履歴を確認できませんでした。"});
 }
}
