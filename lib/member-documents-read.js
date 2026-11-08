// gw_employees を唯一の人の鍵として、既存原本を横断して読む。
// 書類本体・Storageパスの移動やコピー、別の社員への氏名マッチングをしない。
import { memberDocType, summarizeMemberDocuments } from "./member-documents.js";
import { memberLifecycle } from "./member-document-lifecycle.js";
import { memberDisplayState } from "./member-document-display.js";

const MAX=3000;
async function rows(q,name) {
  const {data,error}=await q.limit(MAX);
  if (error) throw new Error(name+": "+error.message);
  return data||[];
}
const idKey=(a,b)=>String(a||"")+"|"+String(b||"");
const push=(m,id,item)=>{ if(!m.has(id))m.set(id,[]);m.get(id).push(item); };
const kindFromItem=(item)=>{
  const k=item?.item_key||"";
  if(k==="doc_resume") return "resume";
  if(k==="doc_dependents") return "dependents";
  if(k==="doc_contract") return "employment_contract";
  if(k==="doc_contract_gyomu") return "service_contract";
  if(k==="doc_nda") return "nda";
  if(k==="doc_withholding") return "previous_withholding";
  if(k==="doc_pension") return "pension_notice";
  if(k==="doc_employment_ins") return "employment_ins_card";
  if(k==="form_bank") return "bank_account";
  if(k==="form_profile") return "profile_form";
  if(k==="form_emergency") return "emergency_contact";
  if(k==="form_consent") return "onboard_consent";
  return "other";
};
const contractKind=(s)=>String(s||"").includes("業務委託")?"service_contract":"employment_contract";
const signKind=(s)=>/nda|秘密保持/i.test(String(s||""))?"nda":/業務委託/.test(String(s||""))?"service_contract":"employment_contract";
const doc=(source,row,kind,title,opts={})=>({
  source,id:row.id,kind,title,filename:opts.filename||row.filename||row.file_name||title||"",
  status:opts.status||"登録済",createdAt:opts.createdAt||row.created_at||null,
  signed:opts.signed===true,verified:opts.verified===true,
  storagePath:opts.storagePath||null,bucket:"hr",
  issuedOn:opts.issuedOn||null,dueOn:opts.dueOn||null,
  group:memberDocType(kind)?.group||"submitted",
  salary:memberDocType(kind)?.salary===true,
});
function setByEmployee(m,rows,fn){for(const row of rows){const v=fn(row);if(v)push(m,row.employee_id,v);}}
const orEmpty=(value)=>Array.isArray(value)?value:[];

export async function readMemberDocumentRegister(sb,tenantId,{employeeId=null}={}) {
  let eq=sb.from("gw_employees").select("id,display_name,employment_type,status,employee_kind,department,joined_on,left_on").eq("tenant_id",tenantId);
  if(employeeId)eq=eq.eq("id",employeeId);
  const people=await rows(eq.order("display_name"),"gw_employees");
  if(employeeId && !people.length)return {error:"not_found"};
  if(!people.length)return {employees:[],uploadReady:true,byEmployee:new Map()};
  const ids=people.map(x=>x.id);
  const base=(table,columns)=>sb.from(table).select(columns).eq("tenant_id",tenantId).in("employee_id",ids);
  const loadManual=async()=>{
    const {data,error}=await base("gw_member_documents","id,employee_id,doc_kind,filename,mime_type,storage_path,status,verified_at,created_at,deleted_at")
      .is("deleted_at",null).order("created_at",{ascending:false}).limit(MAX);
    if(error&&/PGRST205|42P01|does not exist|schema cache|not found/i.test(error.code+" "+error.message))
      return {ready:false,data:[]};
    if(error)throw new Error("gw_member_documents: "+error.message);
    return {ready:true,data:data||[]};
  };
  const loadDisplay=async()=>{
    const {data,error}=await base("gw_member_document_display","employee_id,display_state").limit(MAX);
    if(error&&/PGRST205|42P01|does not exist|schema cache|not found/i.test(error.code+" "+error.message))
      return {ready:false,data:[]};
    if(error)throw new Error("gw_member_document_display: "+error.message);
    return {ready:true,data:data||[]};
  };
  const [contracts,signs,orders,procedures,applicants,retireRows,manual,display]=await Promise.all([
    rows(base("gw_contracts","id,employee_id,contract_type,status,period_from,period_to,file_path,filename,confirmed_at,created_at"),"gw_contracts"),
    rows(base("gw_sign_requests","id,employee_id,doc_kind,title,status,signed_at,pdf_path,signed_pdf_path,file_name,created_at"),"gw_sign_requests"),
    rows(base("gw_doc_orders","id,employee_id,doc_kind,title,status,file_path,file_name,uploaded_at,created_at"),"gw_doc_orders"),
    rows(base("gw_procedures","id,employee_id,kind,created_at"),"gw_procedures"),
    rows(base("gw_hr_applicants","id,employee_id"),"gw_hr_applicants"),
    rows(base("gw_retire_docs","id,employee_id,kind,version,state,storage_path,file_name,expected_on,issued_on,published,created_at"),"gw_retire_docs"),
    loadManual(),loadDisplay(),
  ]);
  const displayByEmployee=new Map(display.data.map(x=>[x.employee_id,x.display_state]));
  const procIds=procedures.map(x=>x.id);
  const apIds=applicants.map(x=>x.id);
  const empty=async()=>[];
  const [items,files,offers,hrDocs]=await Promise.all([
    procIds.length?rows(sb.from("gw_procedure_items").select("id,procedure_id,item_key,title,category,required,status,owner,submitted_at,due_on,created_at").eq("tenant_id",tenantId).in("procedure_id",procIds),"gw_procedure_items"):empty(),
    procIds.length?rows(sb.from("gw_procedure_files").select("id,procedure_id,item_id,filename,mime_type,storage_path,created_at").eq("tenant_id",tenantId).in("procedure_id",procIds),"gw_procedure_files"):empty(),
    apIds.length?rows(sb.from("gw_hr_offers").select("id,applicant_id,offer_title,offer_pdf_path,notice_title,notice_pdf_path,accepted_pdf_path,accepted_at,handoff_at,revoked_at,declined_at,created_at").eq("tenant_id",tenantId).in("applicant_id",apIds),"gw_hr_offers"):empty(),
    apIds.length?rows(sb.from("gw_hr_documents").select("id,applicant_id,doc_type,filename,storage_path,created_at,deleted_at").eq("tenant_id",tenantId).in("applicant_id",apIds).is("deleted_at",null),"gw_hr_documents"):empty(),
  ]);
  const docMap=new Map();
  const contractMap=new Map();
  const retireMap=new Map();
  const selectedProcedures=new Map();
  const procedureToEmployee=new Map(procedures.map(p=>[p.id,p.employee_id]));
  const itemById=new Map(items.map(i=>[i.id,i]));
  const appToEmp=new Map(applicants.map(a=>[a.id,a.employee_id]));
  const handedOffers=new Set(offers.filter(o=>o.handoff_at&&o.accepted_at&&!o.revoked_at&&!o.declined_at).map(o=>o.applicant_id));
  setByEmployee(contractMap,contracts,r=>r);
  setByEmployee(retireMap,retireRows,r=>({...r,kind:"retire_"+r.kind}));
  setByEmployee(docMap,retireRows,r=>{
    if(!r.storage_path || !["issued","superseded"].includes(r.state)) return null;
    const kind="retire_"+r.kind;
    return doc("retire",r,kind,{
      retire_certificate:"退職証明書",retire_withholding:"退職時の源泉徴収票",
      retire_separation:"離職票",retire_insurance_loss:"健康保険資格喪失証明書",
    }[kind]||"退職時の書類",{
      filename:r.file_name,storagePath:r.storage_path,status:r.published?"発行済・公開中":"発行済",
      verified:true,issuedOn:r.issued_on,dueOn:r.expected_on,
    });
  });
  setByEmployee(docMap,contracts,r=>r.file_path?doc("contract",r,contractKind(r.contract_type),r.contract_type||"契約書",{
    storagePath:r.file_path,status:r.confirmed_at?"契約条件確認済（署名未確認）":"登録済（署名未確認）",
  }):null);
  setByEmployee(docMap,signs,r=>{
    const signed=!!(r.signed_at && r.signed_pdf_path);
    const path=signed?r.signed_pdf_path:r.pdf_path;
    return doc("sign",r,signKind(r.doc_kind||r.title),r.title||"電子契約",{
      storagePath:path,status:signed?"電子署名済":r.sent_at||["sent","viewed","pending"].includes(r.status)?"署名待ち":"下書き",
      signed,
    });
  });
  setByEmployee(docMap,orders,r=>r.file_path?doc("order",r,signKind(r.doc_kind||r.title),r.title||"社労士作成書類",{
    filename:r.file_name,storagePath:r.file_path,status:"書類受領（署名未確認）",createdAt:r.uploaded_at,
  }):null);
  for(const p of procedures){
    if(p.kind!=="onboarding")continue;
    const old=selectedProcedures.get(p.employee_id);
    if(!old||String(p.created_at)>String(old.created_at))selectedProcedures.set(p.employee_id,p);
  }
  const checklistMap=new Map();
  for(const item of items){
    const emp=procedureToEmployee.get(item.procedure_id);
    if(!emp)continue;
    const latest=selectedProcedures.get(emp);
    if(latest && latest.id===item.procedure_id)push(checklistMap,emp,item);
  }
  for(const r of files){
    const emp=procedureToEmployee.get(r.procedure_id);
    if(!emp)continue;
    const item=itemById.get(r.item_id);
    // マイナンバーは本システムでは管理しない（名簿書類台帳へも転載禁止）。
    if(item?.item_key==="doc_mynumber"||/マイナンバー|個人番号/.test(item?.title||""))continue;
    push(docMap,emp,doc("procedure",r,kindFromItem(item),item?.title||"入社時提出書類",{
      status:item?.status==="done"?"確認済":item?.status==="submitted"?"提出済":"登録済",
      storagePath:r.storage_path,verified:item?.status==="done",
    }));
  }
  for(const r of manual.data){
    push(docMap,r.employee_id,doc("manual",r,r.doc_kind,memberDocType(r.doc_kind)?.label||r.doc_kind,{
      storagePath:r.storage_path,status:r.status==="verified"?"確認済":"受領・確認待ち",
      verified:r.status==="verified",
    }));
  }
  for(const r of hrDocs){
    if(!handedOffers.has(r.applicant_id))continue;
    const emp=appToEmp.get(r.applicant_id);
    const type={resume:"resume",work_history:"work_history",skill_sheet:"skill_sheet"}[r.doc_type]||"other";
    if(emp)push(docMap,emp,doc("hr",r,type,memberDocType(type)?.label||"応募書類",{storagePath:r.storage_path,status:"HRから引継ぎ済"}));
  }
  for(const r of offers){
    if(!handedOffers.has(r.applicant_id))continue;
    const emp=appToEmp.get(r.applicant_id);
    if(!emp)continue;
    if(r.notice_pdf_path)push(docMap,emp,doc("offer-notice",r,"labor_notice",r.notice_title||"労働条件通知書",{
      filename:r.notice_title||"労働条件通知書.pdf",storagePath:r.notice_pdf_path,status:"条件承諾済（署名は別管理）",
    }));
    if(r.offer_pdf_path)push(docMap,emp,doc("offer-letter",r,"offer_letter",r.offer_title||"内定通知書",{
      filename:r.offer_title||"内定通知書.pdf",storagePath:r.offer_pdf_path,status:"送付済",
    }));
    if(r.accepted_pdf_path)push(docMap,emp,doc("offer-accepted",r,"accepted_offer","条件承諾済みPDF",{
      filename:"承諾済みPDF",storagePath:r.accepted_pdf_path,status:"条件承諾済（締結とは別）",
    }));
  }
  const byEmployee=new Map();
  for(const e of people){
    const all=orEmpty(docMap.get(e.id));
    // 同一の実体を別テーブルが指す場合は一度だけ表示（より強い署名の記録を優先）。
    const rank=(d)=>d.signed?4:d.verified?3:d.source==="manual"?2:1;
    const sorted=all.sort((a,b)=>rank(b)-rank(a) || String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
    const seen=new Set();
    const docs=sorted.filter(d=>!d.storagePath || !seen.has(idKey(d.bucket,d.storagePath))&&seen.add(idKey(d.bucket,d.storagePath)));
    const cs=orEmpty(contractMap.get(e.id));
    const req=orEmpty(checklistMap.get(e.id));
    const summary=summarizeMemberDocuments(e,docs,req,cs);
    summary.displayState=memberDisplayState(e,displayByEmployee.get(e.id));
    summary.displayReady=display.ready;
    const retirement=orEmpty(retireMap.get(e.id));
    const lifecycle=memberLifecycle(e,docs,req,cs,retirement);
    byEmployee.set(e.id,{employee:e,documents:docs,contracts:cs,checklist:req,retirement,summary,lifecycle});
  }
  return {employees:people,uploadReady:manual.ready,displayReady:display.ready,byEmployee};
}
