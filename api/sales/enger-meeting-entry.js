// Read-only handoff. ENGER owns session creation and rechecks agent assignments.
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {json,methodNotAllowed} from '../../lib/http.js';
import {isUuid} from '../../lib/sales.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';

export default async function handler(req,res){
  res.setHeader?.('Cache-Control','private, no-store');
  const user=await requireUser(req,res);if(!user)return;
  if(req.method!=='GET')return methodNotAllowed(res,['GET']);
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||ctx.left||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
    return json(res,403,{error:'forbidden',hint:'有効な社内Sales権限が必要です。'});
  const params=new URL(req.url||'/','http://localhost').searchParams;
  const company=params.get('companyId'),sales=params.get('salesCompanyId');
  const session=params.get('sessionId');
  if(Boolean(company)===Boolean(sales)||![company||sales,session||null].every(x=>x===null||isUuid(x))||
    [...params.keys()].some(k=>params.getAll(k).length!==1))
    return json(res,400,{error:'invalid_company',hint:'企業一覧から商談を開き直してください。'});
  try{
    const db=admin(),tenant=ctx.tenantId;
    let links=db.from('gw_sales_company_links').select('company_id,source_company_id')
      .eq('tenant_id',tenant).eq('source_system','enger');
    links=company?links.eq('source_company_id',company.toLowerCase()):links.eq('company_id',sales.toLowerCase());
    const linked=await links.limit(2);
    if(linked.error)throw linked.error;
    if((linked.data||[]).length>1)return json(res,409,{error:'ambiguous_company_link',hint:'企業IDが複数に紐づいています。管理者が確認してください。'});
    let salesRow=null;
    const salesId=linked.data?.[0]?.company_id||sales?.toLowerCase();
    if(salesId){
      const r=await db.from('gw_sales_companies').select('id,name,status,hidden_at,ng_reason,next_action,next_action_on')
        .eq('tenant_id',tenant).eq('id',salesId).maybeSingle();
      if(r.error)throw r.error;
      if(!r.data)return json(res,404,{error:'company_not_found'});
      salesRow=r.data;
      if(salesRow.hidden_at||salesRow.ng_reason||salesRow.status==='excluded'||(!session&&['won','lost'].includes(salesRow.status)))
        return json(res,409,{error:'company_blocked',hint:'営業禁止・非表示・終了状態をSalesで確認してください。'});
    }
    const companyId=(linked.data?.[0]?.source_company_id||company||'').toLowerCase();
    if(!isUuid(companyId))return json(res,409,{error:'company_link_required',hint:'ENGER企業IDが未連携です。企業DBで法人番号と既存企業を確認し、登録・連携してから開始してください。'});
    const [scope,source]=await Promise.all([
      db.schema('enger').from('dx2_sales_company_directory_for_tenant')
        .select('id,name,needs_contact_review,directory_hidden_at').eq('tenant_id',tenant).eq('id',companyId).maybeSingle(),
      db.schema('enger').from('companies').select('id,name,deleted_at').eq('id',companyId).is('deleted_at',null).maybeSingle(),
    ]);
    if(scope.error||source.error)throw Error('company_lookup_failed');
    if(!scope.data||!source.data)return json(res,404,{error:'company_not_found'});
    if(scope.data.needs_contact_review||scope.data.directory_hidden_at)
      return json(res,409,{error:'company_blocked',hint:'連絡注意・非表示の企業です。Salesで営業可否を確認してください。'});
    if(!salesRow)return json(res,409,{error:'sales_link_confirmation_required',companyId,companyName:source.data.name,
      hint:'このENGER企業をSalesの営業記録に連携します。既存記録を照合して再利用します。企業アカウントは発行しません。'});
    // Reverse lookup rejects inconsistent many-to-one mappings as well.
    const reverse=await db.from('gw_sales_company_links').select('source_company_id')
      .eq('tenant_id',tenant).eq('source_system','enger').eq('company_id',salesRow.id).limit(2);
    if(reverse.error)throw reverse.error;
    if(reverse.data?.length!==1||reverse.data[0].source_company_id!==companyId)
      return json(res,409,{error:'ambiguous_company_link',hint:'企業の対応付けを一意に確認できません。管理者が確認してください。'});
    let query=db.from('gw_sales_live_meeting_sessions')
      .select('id,company_id,status,stage,started_by,step_details,closeout_next_action,closeout_next_due,updated_at')
      .eq('tenant_id',tenant).eq('company_id',companyId);
    query=session?query.eq('id',session.toLowerCase()):query.eq('status','active');
    const meetings=await query.limit(2);
    if(meetings.error)throw meetings.error;
    if(meetings.data?.length>1)return json(res,409,{error:'duplicate_active_meeting',hint:'進行中の商談が複数あります。履歴を確認してください。'});
    const meeting=meetings.data?.[0];
    if(session&&!meeting)return json(res,404,{error:'meeting_not_found'});
    if(meeting?.step_details?.layout==='compact_v1')return json(res,409,{error:'legacy_meeting_review_required',
      hint:'旧Sales商談が進行中です。履歴を確認してから切り替えてください。新しい商談は作成していません。'});
    // Agent permissions and ownership are authoritatively checked again in ENGER.
    const manage=(ctx.roles||[]).some(r=>['owner','manager'].includes(r));
    if(meeting&&meeting.started_by!==user.id&&!manage)
      return json(res,409,{error:'meeting_owned_by_other',hint:'別の担当者がこの企業で商談中です。担当者に確認してください。'});
    const target=new URL('https://enger.jp/business/agent-meeting');
    target.searchParams.set('companyId',companyId);
    if(meeting)target.searchParams.set('sessionId',meeting.id);
    return json(res,200,{ok:true,companyId,salesCompanyId:salesRow.id,companyName:source.data.name,
      url:target.href,session:meeting?{id:meeting.id,status:meeting.status,stage:meeting.stage,updatedAt:meeting.updated_at}:null,
      nextAction:salesRow.next_action||null,nextDue:salesRow.next_action_on||null});
  }catch{
    return json(res,503,{error:'meeting_entry_unavailable',hint:'企業・商談の照合に失敗しました。再確認してください。商談は作成していません。'});
  }
}
