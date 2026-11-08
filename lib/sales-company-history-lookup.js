// Match evidence for historical ENGER rows. Never link by fuzzy name automatically.
import {sourceChannel} from "./sales-receipt-channel.js";
// This helper returns only candidate reasons; an authenticated Sales user must confirm.
export function normalizedBusinessName(value) {
 const v=String(value??"").normalize("NFKC").replace(/[\s　,，.・･]/g,"").toLowerCase();
 return v.replace(/^(株式会社|有限会社|合同会社|合資会社|一般社団法人)/,"")
   .replace(/(株式会社|有限会社|合同会社|合資会社|一般社団法人)$/,"");
}
export function companySearchKeyword(company) {
 const word=normalizedBusinessName(company).replace(/[^a-z0-9ぁ-んァ-ヶ一-龠]/gi,"").slice(0,65);
 return word.length<3?"":word;
}
export function verifiedMailDomain(company) {
 const email=String(company?.contact_email||"").trim().toLowerCase();
 const website=String(company?.website||"").trim().toLowerCase();
 const hostname=(()=>{try{return new URL(website).hostname.replace(/^www[.]/,"")}catch{return""}})();
 const mail=email.split("@").length===2?email.split("@")[1]:"";
 const blocked=new Set(["gmail.com","yahoo.co.jp","yahoo.com","outlook.com","hotmail.com",
  "icloud.com","live.jp","docomo.ne.jp","ezweb.ne.jp","softbank.ne.jp","qq.com","163.com"]);
 const domain=mail&&!blocked.has(mail)?mail:hostname;
 return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)&&!blocked.has(domain)?domain:"";
}
export function exactCompanyMatch(needle,actual) {
 const a=normalizedBusinessName(needle),b=normalizedBusinessName(actual);
 return a.length>=3&&a===b;
}
export function exactEmailDomain(domain,email) {
 if(!domain)return false;
 const e=String(email??"").trim().toLowerCase().split("@");
 return e.length===2&&e[1]===domain;
}
export function candidateEvidence(kind,record,company,domain) {
 const fromDomain=exactEmailDomain(domain,record.contact_email) ||
  (kind==="job"&&exactEmailDomain(domain,record.posted_by_email));
 if(fromDomain)return "sender_domain";
 const names=kind==="job"?[record.client_name]:kind==="talent"?[record.company,record.source_company]:[record.company];
 if(names.some(x=>exactCompanyMatch(company.name,x)))return kind==="proposal"?"historical_proposal":"company_name";
 return null;
}
export function historicalRow(itemType,row,sourceKind,linked=false) {
 const raw=String(itemType);
 const num=raw==="job"?row.job_no:raw==="talent"?row.candidate_no:null;
 const name=raw==="job"?(row.role_label||row.title||"案件") :
  raw==="talent"?(row.title||"人材") : (row.job_title||"過去の提案");
 const label=String(name).slice(0,110);
 const status=raw==="proposal"?String(row.stage||"").slice(0,50):
  row.deleted_at?"削除扱い":row.is_closed?"終了":"募集・稼働継続は未確認";
 return {
  id:row.id,type:raw,no:num?String(num):null,label,status,channel:sourceChannel(row),
  sourceKind,linked,createdAt:row.created_at||null,
  // Deliberately exclude emails, client names, partner firms, and cost rates.
 };
}
