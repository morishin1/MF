// Office人事労務が正式な労働条件通知書・契約書を準備するための最小受付。
// 面談・採用判断・履歴・給与の値は返さない。給与が見えない人は書類APIにも入れない。
import {requireUser} from '../../lib/auth.js';
import {gwContext,canOfficeHr,canSeeSalary} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {json,methodNotAllowed} from '../../lib/http.js';
import {offerTypeLabel} from '../../lib/hr-offer-types.js';
import {officeHandoffSummary} from '../../lib/hr-office-handoff.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private,no-store');
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canOfficeHr(ctx)||!canSeeSalary(ctx))return json(res,403,{error:'forbidden',hint:'Officeの人事労務・給与管理権限が必要です。'});
 if(req.method!=='GET')return methodNotAllowed(res,['GET']);
 const sb=admin();
 const r=await sb.from('gw_hr_applicants')
   .select('id,name,email,stage,status,decision,offer_type,employee_id,updated_at')
   .eq('tenant_id',ctx.tenantId).eq('decision','hired')
   .order('updated_at',{ascending:false}).limit(200);
 if(r.error)return json(res,503,{ready:false,error:'not_ready',hint:'内定者一覧を読み込めませんでした。'});
 // 既存の採用決定が、Officeの未処理一覧の原本。通知や別キュー表の成功に依存しない。
 // 育成枠だけは無限道場の専用手続きで進めるため、Officeの正式雇用・契約対象に含めない。
 const rows=(r.data||[]).filter(a=>!['declined','position_closed','passed'].includes(a.status)&&a.offer_type!=='training');
 const ids=rows.map(a=>a.id);let documents=[];
 if(ids.length){
   // 新しいPDFが登録されていれば、ファイルの実在と公開状況だけから進捗を算出する。
   const d=await sb.from('gw_hr_candidate_documents')
     .select('applicant_id,kind,status,created_at')
     .eq('tenant_id',ctx.tenantId).in('applicant_id',ids)
     .in('status',['draft','published'])
     .order('created_at',{ascending:false}).limit(1000);
   if(d.error)return json(res,503,{ready:false,error:'not_ready',hint:'書類の状況を確認できません。管理者にご連絡ください。'});
   documents=d.data||[];
 }
 const candidates=rows.map(a=>{
   const workflow=officeHandoffSummary(a,documents.filter(d=>d.applicant_id===a.id));
   return {id:a.id,name:a.name,email:a.email||null,
     plannedCategory:offerTypeLabel(a.offer_type)||'未設定',
     stage:a.stage,status:a.status,updatedAt:a.updated_at,
     workflow};
 });
 const pending=candidates.filter(a=>!a.workflow.completed).length;
 return json(res,200,{ready:true,candidates,pending,
   note:'内定によって労働契約が成立する場合は、内定時に必要な労働条件を明示してください。アップロードや公開だけでは本人の合意・署名にはなりません。'});
}
