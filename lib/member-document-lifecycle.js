// The button order is the employee lifecycle: recruitment -> offer/contract -> joining -> employed -> leaving.
// This is a DISPLAY checklist, not a declaration that each paper is legally mandatory.
// Existing onboarding required/NA decisions always take precedence over defaults.
export const LIFECYCLE_PHASES = Object.freeze([
  {key:"recruit",label:"採用時"},
  {key:"offer",label:"内定・契約"},
  {key:"join",label:"入社時"},
  {key:"active",label:"在籍中"},
  {key:"leave",label:"退社時"},
]);
export const LIFECYCLE_DOCUMENTS = Object.freeze([
  {key:"resume",label:"履歴書",phase:"recruit",applies:"all",defaultRequired:"employee",itemKeys:["doc_resume"],kinds:["resume"],upload:"resume"},
  {key:"work_history",label:"職務経歴",phase:"recruit",applies:"all",itemKeys:["doc_resume"],kinds:["work_history"],upload:"work_history"},
  {key:"skill_sheet",label:"スキルシート",phase:"recruit",applies:"all",kinds:["skill_sheet"],upload:"skill_sheet"},
  {key:"offer_letter",label:"内定通知",phase:"offer",applies:"all",kinds:["offer_letter"],upload:null},
  {key:"accepted_offer",label:"内定承諾",phase:"offer",applies:"all",kinds:["accepted_offer"],upload:null},
  {key:"labor_notice",label:"労働条件通知",phase:"offer",applies:"employee",defaultRequired:"employee",itemKeys:["doc_contract"],kinds:["labor_notice"],upload:"labor_notice"},
  {key:"employment_contract",label:"雇用契約",phase:"offer",applies:"employee",defaultRequired:"employee",itemKeys:["doc_contract"],kinds:["employment_contract"],upload:"employment_contract"},
  {key:"service_contract",label:"業務委託契約",phase:"offer",applies:"contractor",defaultRequired:"contractor",itemKeys:["doc_contract_gyomu"],kinds:["service_contract"],upload:"service_contract"},
  {key:"nda",label:"秘密保持契約",phase:"offer",applies:"all",itemKeys:["doc_nda"],kinds:["nda"],upload:"nda"},
  {key:"dependents",label:"扶養申告",phase:"join",applies:"employee",defaultRequired:"employee",itemKeys:["doc_dependents"],kinds:["dependents"],upload:"dependents"},
  {key:"pension",label:"基礎年金番号",phase:"join",applies:"employee",itemKeys:["doc_pension"],kinds:["pension_notice"],upload:"pension_notice"},
  {key:"employment_ins",label:"雇用保険",phase:"join",applies:"employee",itemKeys:["doc_employment_ins"],kinds:["employment_ins_card"],upload:"employment_ins_card"},
  {key:"previous_withholding",label:"前職源泉票",phase:"join",applies:"employee",itemKeys:["doc_withholding"],kinds:["previous_withholding"],upload:"previous_withholding"},
  {key:"bank",label:"振込口座",phase:"join",applies:"employee",itemKeys:["form_bank"],kinds:["bank_account"],upload:"bank_account"},
  {key:"profile",label:"入社情報",phase:"join",applies:"employee",itemKeys:["form_profile"],kinds:["profile_form"],upload:"profile_form"},
  {key:"emergency",label:"緊急連絡先",phase:"join",applies:"employee",itemKeys:["form_emergency"],kinds:["emergency_contact"],upload:"emergency_contact"},
  {key:"consent",label:"規程等同意",phase:"join",applies:"employee",itemKeys:["form_consent"],kinds:["onboard_consent"],upload:"onboard_consent"},
  {key:"contract_addendum",label:"契約更新・覚書",phase:"active",applies:"all",kinds:["contract_addendum"],upload:"contract_addendum"},
  {key:"other",label:"その他書類",phase:"active",applies:"all",kinds:["other"],upload:"other"},
  {key:"resignation_notice",label:"退職届",phase:"leave",applies:"employee",kinds:["resignation_notice"],upload:"resignation_notice"},
  {key:"handover_form",label:"業務引継ぎ",phase:"leave",applies:"all",kinds:["handover_form"],upload:"handover_form"},
  {key:"asset_return_form",label:"貸与品返却",phase:"leave",applies:"all",kinds:["asset_return_form"],upload:"asset_return_form"},
  {key:"retirement_pledge",label:"退職時誓約",phase:"leave",applies:"all",kinds:["retirement_pledge"],upload:"retirement_pledge"},
  {key:"retire_certificate",label:"退職証明書",phase:"leave",applies:"employee",kinds:["retire_certificate"],upload:null},
  {key:"retire_withholding",label:"退職時源泉票",phase:"leave",applies:"employee",kinds:["retire_withholding"],upload:null},
  {key:"retire_separation",label:"離職票",phase:"leave",applies:"employee",kinds:["retire_separation"],upload:null},
  {key:"retire_insurance_loss",label:"資格喪失証明",phase:"leave",applies:"employee",kinds:["retire_insurance_loss"],upload:null},
]);
const STAGE_BY_KEY=new Map(LIFECYCLE_DOCUMENTS.map(x=>[x.key,x]));
const formValue=(i)=>String(i.item_key||"");
const hasFile=(d)=>Boolean(d&&d.storagePath);
const recent=(a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""));
const currentContract=(contracts)=>[...(contracts||[])].sort((a,b)=>
  Number(b.status==="active")-Number(a.status==="active")
  ||String(b.created_at||"").localeCompare(String(a.created_at||"")))[0]||null;
const allDocs=(docs,kinds)=>docs.filter(d=>kinds.includes(d.kind)).sort((a,b)=>
  Number(Boolean(b.signed))-Number(Boolean(a.signed)) ||
  Number(Boolean(b.verified))-Number(Boolean(a.verified)) || recent(a,b));
const applicable=(def,employee)=> {
  const contractor=employee?.employment_type==="業務委託"||employee?.employee_kind==="bp";
  if(def.applies==="contractor")return contractor;
  if(def.applies==="employee")return !contractor;
  return true;
};
const safeKey=(s)=>/^[a-z0-9_]{2,80}$/i.test(String(s||""));
const checklistDecision=(def,checklist)=>{
  const matches=(checklist||[]).filter(x=>x.category==="document"&&def.itemKeys?.includes(formValue(x)));
  if(!matches.length)return null;
  const item=matches.at(-1);
  return {required:item.required===true,state:item.status||null,submittedAt:item.submitted_at||null,
    dueOn:item.due_on||null,label:item.title||null};
};
function decideState(def,employee,docs,checklist,retireRecords){
  const related=allDocs(docs,def.kinds);
  const file=related.find(hasFile)||null;
  const checking=checklistDecision(def,checklist);
  const isLeaving=employee?.status==="leaving"||employee?.status==="left";
  const retired=def.phase==="leave";
  const retireRecord=retired&&def.key.startsWith("retire_")?(retireRecords||[]).filter(r=>r.kind===def.key)
    .sort((a,b)=>(b.version||0)-(a.version||0))[0]||null:null;
  if(checking?.state==="na"&&!file)return {hidden:true};
  let required=checking?checking.required:(def.defaultRequired==="employee"?
    !["業務委託"].includes(employee?.employment_type)&&employee?.employee_kind!=="bp":
    def.defaultRequired==="contractor"?employee?.employment_type==="業務委託":false);
  // Backfilled HR employees often have no original offer records. Do not assert missing consent/offer for them.
  if(!checking&&["offer_letter","accepted_offer"].includes(def.key))required=false;
  let state="check";
  if(retired&&!file&&!isLeaving)state="future";
  else if(file?.signed)state="signed";
  else if(file&&def.key==="accepted_offer")state="accepted";
  else if(file&&retired&&file.source==="retire")state="issued";
  else if(file?.verified)state=["employment_contract","service_contract"].includes(def.key)?"contract_unconfirmed":"verified";
  else if(file)state=["employment_contract","service_contract"].includes(def.key)?"contract_unconfirmed":"received";
  else if(checking?.state==="done")state="record_only";
  else if(checking?.state==="submitted")state="record_only";
  else if(retireRecord?.state==="processing")state="processing";
  else if(retired&&!isLeaving)state="future";
  else if(required)state="missing";
  else state="check";
  const date=retireRecord?.issued_on||file?.issuedOn||null;
  const due=retireRecord?.expected_on||checking?.dueOn||null;
  return {file,related,checking,required,state,issuedOn:date,dueOn:due};
}
/** The same facts/ordering are used for the list buttons and the selected-document modal. */
export function memberLifecycle(employee,documents=[],checklist=[],contracts=[],retireRecords=[]){
  const activeContract=currentContract(contracts);
  const phaseOrder=new Map(LIFECYCLE_PHASES.map((x,i)=>[x.key,i]));
  const buttons=[];
  for(const def of LIFECYCLE_DOCUMENTS){
    if(!applicable(def,employee))continue;
    const d=decideState(def,employee,documents,checklist,retireRecords);
    if(d.hidden)continue;
    const related=d.related||[];
    const file=d.file;
    const period=(["offer","active"].includes(def.phase)&&activeContract)?
      {from:activeContract.period_from||null,to:activeContract.period_to||null,
        contractType:activeContract.contract_type||null,
        source:"関連契約期間"}:null;
    buttons.push({
      key:def.key,label:def.label,phase:def.phase,state:d.state,
      required:d.required,requiredLabel:d.required?"必要書類":d.state==="future"?"今後の手続き":"必要に応じて",
      uploadKind:def.upload,docKinds:[...def.kinds],
      fileCount:related.filter(hasFile).length,hasFile:Boolean(file),
      latestFile:file?{source:file.source,id:file.id,title:file.title||def.label,filename:file.filename||def.label}:null,
      fileDate:file?.createdAt||null,issueDate:d.issuedOn||null,dueOn:d.dueOn||null,period,
      originalRecord:d.checking?.state||null,
    });
  }
  // Add existing custom onboarding document requirements as discoverable buttons.
  for(const item of checklist||[]){
    if(item.category!=="document"||item.status==="na"||formValue(item)==="doc_mynumber")continue;
    const key=formValue(item);
    if(!safeKey(key)||LIFECYCLE_DOCUMENTS.some(d=>d.itemKeys?.includes(key)))continue;
    const doc=documents.find(x=>x.kind==="other" && (x.title===item.title));
    buttons.push({
      key:"custom_"+key,label:String(item.title||"追加提出書類").slice(0,28),
      phase:"join",state:doc?.verified?"verified":hasFile(doc)?"received":
        ["done","submitted"].includes(item.status)?"record_only":item.required?"missing":"check",
      required:item.required===true,requiredLabel:item.required?"必要書類":"必要に応じて",
      uploadKind:"other",docKinds:["other"],fileCount:hasFile(doc)?1:0,hasFile:hasFile(doc),
      latestFile:hasFile(doc)?{source:doc.source,id:doc.id,title:doc.title,filename:doc.filename}:null,
      fileDate:doc?.createdAt||null,issueDate:null,dueOn:item.due_on||null,period:null,
      originalRecord:item.status||null,
    });
  }
  return {phases:LIFECYCLE_PHASES,buttons:buttons.sort((a,b)=>
    (phaseOrder.get(a.phase)||0)-(phaseOrder.get(b.phase)||0))};
}
