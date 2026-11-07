// Company AI results -> ENGER DX's real match-engine input model.
// Never turn a company-level assumption into a confirmed ENGER job/candidate.
// A talent-side search uses a draft job-shaped profile for preview only.
// A job-side search requires an actual verified ENGER candidate UUID.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REMOTE={full_remote:"full_remote",hybrid:"partial_remote",onsite:"onsite",unknown:null};
const limited=(x,n)=>String(x??"").normalize("NFKC").trim().slice(0,n);
const skills=v=>[...new Set((Array.isArray(v)?v:[]).filter(x=>typeof x==="string").map(x=>limited(x,60)).filter(Boolean))].slice(0,12);
const numbers=v=>v===null||v===undefined||v===""?null:Number(v);
const money=v=>{const n=numbers(v);return Number.isFinite(n)&&n>=0&&n<=10000?n:null};
const yyyyMmDd=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||""))?String(v):null;

/**
 * ENGER rankCandidates(job,candidates) expects a Job-shaped input.
 * This adapter keeps exact engine column names, not generic CRM summary names.
 */
export function toEngerJobMatchInput(requirement) {
  if(!requirement||requirement.direction!=="talent")return null;
  const salaryMin=money(requirement.salary_min);
  const salaryMax=money(requirement.salary_max);
  return {
    title:limited(requirement.role,100),
    role_label:limited(requirement.role,100),
    role_labels:(Array.isArray(requirement.role_labels)&&requirement.role_labels.length?
      requirement.role_labels:[requirement.role]).map(x=>limited(x,80)).filter(Boolean).slice(0,5),
    skills:skills(requirement.skills),
    salary_min:salaryMin,
    salary_max:salaryMax,
    remote_type:REMOTE[requirement.work_style]??null,
    work_location:limited(requirement.location,100)||null,
    start_date:yyyyMmDd(requirement.start_date),
    required_experience_years:Number.isInteger(requirement.required_experience_years)
      &&requirement.required_experience_years>=0&&requirement.required_experience_years<=50
      ?requirement.required_experience_years:null,
    // NOT an ENGER job, not an approved listing; only a comparison draft.
    confirmed:false,
    source:"local_ai_unverified",
  };
}
export function toEngerCandidateMatchReference(requirement) {
  if(!requirement||requirement.direction!=="job")return null;
  // Do not invent an engineer from a company summary.
  const id=limited(requirement.source_candidate_id,60);
  return UUID.test(id)?{candidateId:id,confirmed:false,source:"local_ai_reference"}:null;
}
export const MATCHING_FIELD_MAP=Object.freeze({
  role:"title / role_label / role_labels",
  skills:"skills",
  salary_min:"salary_min (万円／月)",
  salary_max:"salary_max (万円／月)",
  work_style:"remote_type",
  location:"work_location",
  start_date:"start_date",
  required_experience_years:"required_experience_years",
  source_candidate_id:"candidateId (実在のenger.candidates.idのみ)",
});

/**
 * Exact CompanyNeed shape consumed by ENGER DX getNeedMatches().
 * These are preview-only values, not rows written to dx2_company_needs.
 * On company confirmation, a separate guarded promotion step can create
 * an active need. autoSend/isFocus always start false.
 */
export function toEngerNeedDraft(requirement,companyId,index=0){
  if(!requirement||!["talent","job"].includes(requirement.direction)||!UUID.test(companyId))return null;
  const start=limited(requirement.start_period||requirement.start_date,80);
  return {
    id:"local-ai-preview:"+companyId+":"+index,
    companyId,kind:requirement.direction,
    title:limited(requirement.role,100)||"ニーズ未確認",
    skills:skills(requirement.skills),
    salaryMin:money(requirement.salary_min),
    salaryMax:money(requirement.salary_max),
    remoteType:REMOTE[requirement.work_style]??null,
    headcount:Number.isInteger(requirement.headcount)&&requirement.headcount>0?requirement.headcount:null,
    startPeriod:start||null,
    note:limited("AI仮説（未確認）。"+limited(requirement.rationale,300),480),
    isFocus:false,autoSend:false,isActive:false,
    cadence:"biweekly",nextSendAt:null,lastSentAt:null,createdBy:null,createdAt:null,
  };
}
