// Office人事労務が正式な労働条件通知書・契約書を準備するための最小受付。
// 面談・採用判断・履歴・給与の値は返さない。給与が見えない人は書類APIにも入れない。
import {requireUser} from '../../lib/auth.js';
import {gwContext,canOfficeHr,canSeeSalary} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {json,methodNotAllowed} from '../../lib/http.js';
import {offerTypeLabel} from '../../lib/hr-offer-types.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private,no-store');
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canOfficeHr(ctx)||!canSeeSalary(ctx))return json(res,403,{error:'forbidden',hint:'Officeの人事労務・給与管理権限が必要です。'});
 if(req.method!=='GET')return methodNotAllowed(res,['GET']);
 const sb=admin();
 const r=await sb.from('gw_hr_applicants')
   .select('id,name,email,stage,status,decision,offer_type,updated_at')
   .eq('tenant_id',ctx.tenantId).eq('decision','hired')
   .order('updated_at',{ascending:false}).limit(200);
 if(r.error)return json(res,503,{error:'not_ready',hint:'内定者一覧を読み込めませんでした。'});
 return json(res,200,{candidates:(r.data||[]).filter(a=>!['declined','position_closed','passed'].includes(a.status)).map(a=>({
   id:a.id,name:a.name,email:a.email||null,
   plannedCategory:offerTypeLabel(a.offer_type)||'未設定',
   stage:a.stage,status:a.status,updatedAt:a.updated_at,
 })),note:'内定に伴って労働契約が成立する場合は、内定時までに必要な労働条件を明示してください。'});
}
