// GET/POST /api/sales/company-stars?company_id=<verified-sales-uuid>
// Manual ★ notes; independent of evidence-backed A-D reviews and never auto-blocks proposals.
import { json, methodNotAllowed, readJson } from '../../lib/http.js';
import { requireUser } from '../../lib/auth.js';
import { gwContext, canSell } from '../../lib/gw.js';
import { userClient } from '../../lib/supabase.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE='gw_sales_company_stars';
export default async function handler(req,res) {
  const user=await requireUser(req,res);if(!user)return;
  if(!['GET','POST'].includes(req.method))return methodNotAllowed(res,['GET','POST']);
  res.setHeader?.('Cache-Control','private, no-store');
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx))return json(res,403,{error:'forbidden'});
  let companyId,stars,note;
  if(req.method==='GET')companyId=new URL(req.url,'http://localhost').searchParams.get('company_id');
  else {
    const body=await readJson(req);
    companyId=body.company_id;
    stars=body.stars;
    note=body.note;
    if(!Number.isSafeInteger(stars)||stars<1||stars>5||typeof note!=='string'||note.length>500){
      return json(res,400,{error:'invalid_review',hint:'★は1〜5、評価メモは500文字以内で入力してください。'});
    }
    note=note.trim();
  }
  if(typeof companyId!=='string'||!UUID.test(companyId))return json(res,400,{error:'verified_company_id_required'});
  const db=userClient(req);
  const checked=await db.from('gw_sales_companies').select('id,name')
    .eq('tenant_id',ctx.tenantId).eq('id',companyId).maybeSingle();
  if(checked.error)return json(res,503,{error:'company_unavailable'});
  if(!checked.data)return json(res,404,{error:'company_not_found'});
  try {
    if(req.method==='GET'){
      const {data,error}=await db.from(TABLE).select('stars,note,updated_at')
        .eq('tenant_id',ctx.tenantId).eq('company_id',companyId).maybeSingle();
      if(error)throw error;
      return json(res,200,{company:checked.data,review:data||null,kind:'manual_rating'});
    }
    const {data,error}=await db.from(TABLE).upsert({
      tenant_id:ctx.tenantId,company_id:companyId,stars,note,updated_by:user.id,updated_at:new Date().toISOString(),
    },{onConflict:'tenant_id,company_id'}).select('stars,note,updated_at').single();
    if(error||!data)throw error||new Error('not_saved');
    return json(res,200,{company:checked.data,review:data,kind:'manual_rating'});
  } catch {
    return json(res,503,{error:'company_rating_unavailable',
      hint:'評価を保存・取得できません。db/157_sales_company_stars.sql の適用状況と権限を確認してください。'});
  }
}
