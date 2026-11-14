// 本人公開は閲覧権限だけ。採否・条件への合意・契約締結・Office社員登録とは独立する。
import crypto from 'node:crypto';
import {isEmail} from './mail/index.js';
export const TABLE='gw_hr_candidate_documents',EVENTS='gw_hr_candidate_document_events',BUCKET='hr-candidate-documents';
export const KINDS={terms:'労働条件通知書',offer:'内定通知書',employment_contract:'雇用契約書',contractor_contract:'業務委託契約書'};
export const MAX_BYTES=5*1024*1024;
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export const emailOf=s=>typeof s==='string'&&isEmail(s.trim())?s.trim().toLowerCase():null;
export function verifiedEmail(user){return user?.id&&user.email_confirmed_at&&!user.is_anonymous?emailOf(user.email):null;}
export const cleanFilename=s=>String(s||'書類.pdf').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_').slice(0,110);
export const validUpload=b=>typeof b?.kind==='string'&&Object.hasOwn(KINDS,b.kind)&&Number.isSafeInteger(b.sizeBytes)&&b.sizeBytes>5&&b.sizeBytes<=MAX_BYTES&&typeof b.fileName==='string'&&/\.pdf$/i.test(b.fileName);
export const shape=d=>({id:d.id,kind:d.kind,title:KINDS[d.kind],filename:d.filename,version:d.version,status:d.status,createdAt:d.created_at,publishedAt:d.published_at,viewedAt:d.viewed_at,recipientEmail:d.recipient_email||null});
export const publicationSnapshot=(a,d)=>({applicantId:a.id,documentId:d.id,sha256:d.sha256,version:d.version,kind:d.kind,name:a.name,email:emailOf(a.email),decision:a.decision,status:a.status,documentStatus:d.status});
export const publicationDigest=(a,d)=>hash(JSON.stringify(publicationSnapshot(a,d)));
export async function readMine(sb,user){
  const email=verifiedEmail(user);if(!email)return {ready:true,documents:[],email:null};
  const r=await sb.from(TABLE).select('*').eq('recipient_email',email).eq('status','published').order('published_at',{ascending:false}).limit(200);
  if(r.error)return {ready:false,documents:[],email};
  // Office移行後は、人事が明示的に紐づけた社員IDとログインIDでも本人を確認する。
  // 氏名や未検証メールによるアカウントの自動紐づけはしない。
  const employees=await sb.from('gw_employees').select('id,tenant_id').eq('user_id',user.id).neq('status','left').limit(20);
  if(employees.error)return {ready:false,documents:[],email};
  const linked=(employees.data||[]).length?await sb.from('gw_hr_applicants').select('id,tenant_id,employee_id,email').in('employee_id',employees.data.map(e=>e.id)).limit(100):{data:[]};
  if(linked.error)return {ready:false,documents:[],email};
  const own=(linked.data||[]).filter(a=>employees.data.some(e=>e.id===a.employee_id&&e.tenant_id===a.tenant_id));
  const bound=own.length?await sb.from(TABLE).select('*').in('applicant_id',own.map(a=>a.id)).eq('status','published').limit(200):{data:[]};
  if(bound.error)return {ready:false,documents:[],email};
  const documents=[...new Map([...(r.data||[]),...(bound.data||[])].map(d=>[d.id,d])).values()];
  const ids=[...new Set(documents.map(d=>d.applicant_id))];if(!ids.length)return {ready:true,documents:[],email};
  const people=await sb.from('gw_hr_applicants').select('id,tenant_id,email,employee_id').in('id',ids);
  if(people.error)return {ready:false,documents:[],email};
  // 公開後に応募者の連絡先が変わった場合、元のアドレスでは閲覧させない。
  return {ready:true,email,documents:documents.filter(d=>(people.data||[]).some(a=>a.id===d.applicant_id&&a.tenant_id===d.tenant_id&&((emailOf(a.email)===email&&d.recipient_email===email)||employees.data.some(e=>e.id===a.employee_id&&e.tenant_id===a.tenant_id))))};
}
