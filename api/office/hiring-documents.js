// Office人事労務が正式な労働条件通知書・契約書を準備するための最小受付。
// 面談・採用判断・履歴・給与の値は返さない。給与が見えない人は書類APIにも入れない。
import {requireUser} from '../../lib/auth.js';
import {gwContext,canOfficeHr,canSeeSalary} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {json,methodNotAllowed} from '../../lib/http.js';
import {offerTypeLabel} from '../../lib/hr-offer-types.js';
import {officeHandoffSummary,OFFICE_DOC_KINDS} from '../../lib/hr-office-handoff.js';
export function createHandler(deps={}){
 const D={requireUser,gwContext,admin,canSeeSalary,...deps};
 return async function handler(req,res){
 res.setHeader('Cache-Control','private,no-store');
 const user=await D.requireUser(req,res);if(!user)return;
 const ctx=await D.gwContext(user.id);
 if(!ctx.tenantId||!canOfficeHr(ctx))return json(res,403,{error:'forbidden',hint:'Office人事労務の権限が必要です。'});
 if(req.method!=='GET')return methodNotAllowed(res,['GET']);
 const sb=D.admin();
 const r=await sb.from('gw_hr_applicants')
   .select('id,name,email,stage,status,decision,offer_type,employee_id,updated_at')
   .eq('tenant_id',ctx.tenantId).eq('decision','hired')
   .order('updated_at',{ascending:false}).limit(200);
 if(r.error)return json(res,503,{ready:false,error:'not_ready',hint:'内定者一覧を読み込めませんでした。'});
 // 既存の採用決定が、Officeの未処理一覧の原本。通知や別キュー表の成功に依存しない。
 // 育成枠だけは無限道場の専用手続きで進めるため、Officeの正式雇用・契約対象に含めない。
 const rows=(r.data||[]).filter(a=>!['declined','position_closed','passed'].includes(a.status)&&a.offer_type!=='training');
 const ids=rows.map(a=>a.id);let documents=[],oldOffers=null;
 if(ids.length){
   // 新しいPDFに加えて、移行前の旧オファー（gw_hr_offers）も確認する。
   const [d,legacy]=await Promise.all([
     sb.from('gw_hr_candidate_documents')
       .select('applicant_id,kind,status,created_at')
       .eq('tenant_id',ctx.tenantId).in('applicant_id',ids)
       .in('status',['draft','published'])
       .order('created_at',{ascending:false}).limit(1000),
     sb.from('gw_hr_offers')
       .select('applicant_id,notice_pdf_path,sent_at,revoked_at,created_at')
       .eq('tenant_id',ctx.tenantId).in('applicant_id',ids)
       .order('created_at',{ascending:false}).limit(1000)
   ]);
   if(d.error)return json(res,503,{ready:false,error:'not_ready',hint:'書類の状況を確認できません。管理者にご連絡ください。'});
   documents=d.data||[];
   // 旧DBの列が未適用なら「未アップロード」と誤表示せず「HRで確認」とする。
   if(!legacy.error)oldOffers=legacy.data||[];
 }
 const candidates=rows.map(a=>{
   const applicantDocs=documents.filter(d=>d.applicant_id===a.id);
   const workflow=officeHandoffSummary(a,applicantDocs,
     oldOffers===null?null:oldOffers.filter(o=>o.applicant_id===a.id));
   // Officeの表示は「アップロード済／未アップロード」の二値だけ。
   // draft / published は両方ともアップロード済として扱い、署名や契約完了を推定しない。
   const uploadedKinds=Object.fromEntries(OFFICE_DOC_KINDS.map(kind=>[kind,
     applicantDocs.some(doc=>doc.kind===kind)]));
   return {id:a.id,name:a.name,email:a.email||null,
     plannedCategory:offerTypeLabel(a.offer_type)||'未設定',
     stage:a.stage,status:a.status,updatedAt:a.updated_at,
     workflow,uploadedKinds};
 });
 // 画面の未対応件数も書類の有無で数える（旧フローの公開・署名待ちを混ぜない）。
 const pending=candidates.filter(a=>{
   if(a.workflow.completed)return false;
   const kind=a.workflow.contractKind;
   const needed=kind==='contractor_contract'?['contractor_contract']
     :kind==='employment_contract'?['terms','employment_contract']:OFFICE_DOC_KINDS;
   return needed.some(key=>!a.uploadedKinds[key]);
 }).length;
 return json(res,200,{ready:true,candidates,pending,canManageDocuments:D.canSeeSalary(ctx),
   note:'内定によって労働契約が成立する場合は、内定時に必要な労働条件を明示してください。アップロードや公開だけでは本人の合意・署名にはなりません。'});
 };}
export default createHandler();
