// Only explicitly approved fields may be displayed to a company or used in a share email.
const BLOCK=/株式会社|合同会社|有限会社|@|https?:|www\.|\+81|\b\d{2,4}[- ]\d{2,4}[- ]\d{4}\b/i;
const norm=v=>String(v??"").normalize("NFKC").trim();
const safe=(v,limit=60)=>{const s=norm(v);return s&&!BLOCK.test(s)?s.slice(0,limit):"";};
export const PUBLISHED_JOB_COLUMNS="id,job_no,title,role_label,skills,remote_type,work_location,is_published,review_status,status,is_closed,deleted_at,is_focus,created_at";
export function jobAvailable(row){
 return Boolean(row?.id&&row?.is_published===true&&row?.deleted_at==null&&row?.is_closed===false
   &&!["募集終了","停止","クローズ","closed","NG","却下","rejected"].includes(String(row.status||row.review_status||"")));
}
export function toPublicJob(row){
 const no=Number(row?.job_no);
 const jobNo=Number.isSafeInteger(no)&&no>0?"J-"+String(no).padStart(6,"0"):null;
 const skills=(Array.isArray(row?.skills)?row.skills:[])
   .map(x=>safe(x,35)).filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i).slice(0,8);
 return {
  id:row?.id, jobNo, title: safe(row?.role_label,60) || "ITエンジニア募集",
  skills,remote: safe(row?.remote_type,35),location:safe(row?.work_location,45),
  // Client/partner identity, free-text job description, costs and contact details are intentionally absent.
 };
}
export function toSalesJob(row){
 const base=toPublicJob(row);
 return {...base, displayTitle: norm(row?.title).slice(0,140),isFocus:row?.is_focus===true};
}
