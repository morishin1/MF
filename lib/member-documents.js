// Office / KEIEI の契約・提出書類。既存の採用・入社書類は移さず参照する。
// 「契約情報あり」「PDF受領済み」「電子署名済み」は絶対に混同しない。
import { DOCS, COMPANY_DOCS, docByTitle } from "./onboard-docs.js";

export const MEMBER_DOC_TYPES = Object.freeze([
  { key:"employment_contract", label:"雇用契約書", group:"contract", salary:true },
  { key:"service_contract", label:"業務委託契約書", group:"contract", salary:true },
  { key:"labor_notice", label:"労働条件通知書", group:"contract", salary:true },
  { key:"nda", label:"秘密保持契約書（NDA）", group:"contract", salary:false },
  { key:"contract_addendum", label:"契約更新書・覚書", group:"contract", salary:true },
  { key:"offer_letter", label:"内定・採用通知書", group:"contract", salary:false },
  { key:"accepted_offer", label:"条件承諾済みPDF", group:"contract", salary:true },
  { key:"resume", label:"履歴書", group:"submitted", salary:false },
  { key:"work_history", label:"職務経歴書", group:"submitted", salary:false },
  { key:"skill_sheet", label:"スキルシート", group:"submitted", salary:false },
  { key:"dependents", label:"扶養控除等申告書", group:"submitted", salary:false },
  { key:"other", label:"その他の書類", group:"submitted", salary:false },
]);
const TYPE = new Map(MEMBER_DOC_TYPES.map((x)=>[x.key,x]));
export const memberDocType = (key)=>TYPE.get(key) || null;
export const MEMBER_DOC_MAX_BYTES = 10 * 1024 * 1024;
export const MEMBER_DOC_MIMES = ["application/pdf","image/jpeg","image/png"];
export const forbiddenMemberFilename = (name) =>
  /マイナンバー|個人番号|my.?number|12桁番号|住民票コード/i.test(String(name||""));
export const employmentStatus = (status) => ({
  invited:"入社準備",active:"在籍中",leaving:"退職手続き中",left:"退職",
})[status] || "状態未設定";
const CONTRACT_KINDS = ["employment_contract","service_contract","labor_notice","contract_addendum"];
const hasFile = (d) => !!(d && d.storagePath);
const isContract = (k) => k === "doc_contract" || k === "doc_contract_gyomu";
const normalizedKey = (item) => item?.item_key || docByTitle(item?.title)?.key || item?.id || "";
const linkedKinds = (key) => {
  if (key === "doc_contract") return ["employment_contract","labor_notice","accepted_offer"];
  if (key === "doc_contract_gyomu") return ["service_contract"];
  if (key === "doc_resume") return ["resume","work_history","skill_sheet"];
  if (key === "doc_dependents") return ["dependents"];
  if (key === "doc_nda") return ["nda"];
  if (key === "doc_pension" || key === "doc_employment_ins" || key === "doc_withholding") return [key];
  return [key];
};
const latestDocument = (documents,kinds) => documents.filter((d)=>kinds.includes(d.kind) && hasFile(d))
  .sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")))[0] || null;

export function requiredDocuments(employee, checklist = [], documents = []) {
  const employmentType = String(employee?.employment_type || "");
  const contractor = employmentType === "業務委託" || employee?.employee_kind === "bp";
  if (!employmentType && !checklist.length) return { configured:false, origin:"employment_type_missing", items:[] };
  // 入社時のチェックリストがある人は、その人に確定済みの要否・対象外を優先する。
  const fromChecklist = checklist.filter((x)=>x.category === "document" &&
    x.required === true && x.status !== "na" && normalizedKey(x) !== "doc_mynumber");
  let base;
  if (checklist.some((x)=>x.category === "document")) {
    base = fromChecklist.map((x)=>({ key:normalizedKey(x), label:x.title || "提出書類", originalStatus:x.status, fromChecklist:true }));
  } else if (contractor) {
    base = employee?.employee_kind === "bp" ? [] : [
      {key:"doc_contract_gyomu",label:"業務委託契約書",fromChecklist:false},
    ];
  } else if (["正社員","契約社員","パート","アルバイト"].includes(employmentType)) {
    const defaultKeys = ["doc_contract","doc_resume","doc_dependents"];
    base = [...COMPANY_DOCS, ...DOCS].filter((d)=>defaultKeys.includes(d.key)).map((d)=>({
      key:d.key,label:d.title,fromChecklist:false,
    }));
  } else {
    return { configured:false, origin:"employment_type_unknown", items:[] };
  }
  const seen = new Set();
  const items = base.filter((x)=>!seen.has(x.key) && seen.add(x.key)).map((x)=>{
    const found = latestDocument(documents, linkedKinds(x.key));
    const signed = isContract(x.key) && documents.some((d)=>linkedKinds(x.key).includes(d.kind) && d.signed === true);
    let state = "missing";
    if (signed) state = "signed";
    else if (found?.verified || (found && x.originalStatus === "done")) state = "verified";
    else if (found) state = "received";
    else if (x.originalStatus === "done") state = "record_only";
    else if (x.originalStatus === "submitted") state = "record_only";
    // 雇用契約書の単純なアップロードは署名済みという意味にはしない。
    if (isContract(x.key) && state === "verified" && !signed) state = "contract_unconfirmed";
    return {...x,state,sourceId:found?.id||null,source:found?.source||null};
  });
  return {configured:true,origin:base.some((x)=>x.fromChecklist)?"checklist":"default",items};
}

export function summarizeMemberDocuments(employee, documents = [], checklist = [], contracts = []) {
  const required = requiredDocuments(employee,checklist,documents);
  const total=required.items.length;
  const received=required.items.filter((x)=>["signed","verified","received","contract_unconfirmed"].includes(x.state)).length;
  const complete=required.items.filter((x)=>["signed","verified"].includes(x.state)).length;
  const missing=required.items.filter((x)=>x.state==="missing").length;
  const review=required.items.filter((x)=>["received","contract_unconfirmed","record_only"].includes(x.state)).length;
  const contractSigned=documents.some((d)=>CONTRACT_KINDS.includes(d.kind) && d.signed === true);
  const contractFile=documents.some((d)=>CONTRACT_KINDS.includes(d.kind) && hasFile(d));
  const pendingSignature=documents.some((d)=>CONTRACT_KINDS.includes(d.kind) && d.status==="署名待ち");
  const contractData=contracts.length > 0;
  const contractStatus=contractSigned?"締結済":pendingSignature?"署名待ち":contractFile?"契約書あり・署名未確認":contractData?"契約情報のみ":employee?.employee_kind==="bp"?"所属企業との契約を確認":"契約書未確認";
  const contractEnd=contracts.filter((x)=>x.status==="active" && x.period_to)
    .sort((a,b)=>String(b.period_to).localeCompare(String(a.period_to)))[0]?.period_to || null;
  const today=new Date().toISOString().slice(0,10);
  const days=contractEnd ? Math.floor((Date.parse(contractEnd+"T00:00:00Z")-Date.parse(today+"T00:00:00Z"))/86400000) : null;
  const contractAlert=days!==null?(days<0?"期限経過":days<=30?"30日以内に期限":null):null;
  const state=!required.configured?"必要書類の基準未設定":!total?"個人の必須書類なし":missing?"未登録あり":review?"確認待ち":complete===total?"確認済":"書類状態を確認";
  return {
    employeeId:employee.id, name:employee.display_name,employmentType:employee.employment_type||null,
    employmentStatus:employmentStatus(employee.status),employeeStatus:employee.status,
    requiredConfigured:required.configured,requiredOrigin:required.origin,
    requiredCount:total,receivedCount:received,completeCount:complete,missingCount:missing,reviewCount:review,
    documentCount:documents.filter(hasFile).length,documentStatus:state,contractStatus,contractAlert,contractEnd,
    required:required.items,
  };
}
