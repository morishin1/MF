import {json,methodNotAllowed} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {admin} from '../../lib/supabase.js';
import {resolvePeriod} from '../../lib/sales-period.js';
import {CONTACT_RESULT_LIMIT,normalizeContactResults} from '../../lib/sales-contact-results.js';

export default async function handler(req,res){
  const user=await requireUser(req,res);if(!user)return;
  if(req.method!=='GET')return methodNotAllowed(res,['GET']);
  res.setHeader?.('Cache-Control','private, no-store');
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:'forbidden'});
  const params=new URL(req.url||'/','http://localhost').searchParams;
  const kind=params.get('kind')||'contact';
  const period=resolvePeriod(kind==='company_ng'?'last_30':params.get('period')||'last_30',{from:params.get('from'),to:params.get('to')});
  if(period.error)return json(res,400,period);
  if(!['contact','proposal_ng','company_ng'].includes(kind))return json(res,400,{error:'invalid_kind'});
  try{
    const db=admin().schema('enger');
    let query;
    if(kind==='contact')query=db.from('company_touchpoints').select('id,company_id,occurred_at,dx2_contact_result',{count:'exact'})
      .not('dx2_contact_result','is',null).gte('occurred_at',period.sinceIso).lt('occurred_at',period.untilIso).order('occurred_at',{ascending:false});
    else if(kind==='proposal_ng')query=db.from('proposals')
      .select('id,company_id,company,stage,stage_updated_at,lost_reason,lost_reason_category,lost_detail_reason,lost_reason_note,dx2_lost_side,closer,proposer,owner,client_contact,next_action,job_title,candidate_name',{count:'exact'})
      .is('deleted_at',null).in('stage',['見送り','失注']).gte('stage_updated_at',period.sinceIso).lt('stage_updated_at',period.untilIso).order('stage_updated_at',{ascending:false});
    else query=db.from('dx2_sales_pipeline').select('company_id,owner,owner_user_id,ng_at,ng_by,ng_reason,next_action,next_due',{count:'exact'})
      .eq('is_ng',true).order('ng_at',{ascending:false}); // Current block list, including unknown dates; independent of the period.
    const found=await query.limit(CONTACT_RESULT_LIMIT);
    if(found.error||found.count==null)throw new Error('results_unavailable');
    const rows=found.data||[],ids=[...new Set(rows.map(r=>r.company_id).filter(Boolean))],names=new Map();
    for(let i=0;i<ids.length;i+=100){
      const companies=await db.from('companies').select('id,name').in('id',ids.slice(i,i+100));
      if(companies.error)throw new Error('names_unavailable');
      for(const c of companies.data||[])names.set(c.id,c.name);
    }
    return json(res,200,{kind,period,rows:normalizeContactResults(kind==='contact'?rows:[],kind==='proposal_ng'?rows:[],kind==='company_ng'?rows:[],names),
      total:found.count,capped:found.count>rows.length,limit:CONTACT_RESULT_LIMIT,
      basis:kind==='contact'?'対応日時で集計。1件は1回の連絡記録です。未返信をNGや未読とは判定しません。':kind==='proposal_ng'?'現在見送り・失注の提案を、ステージ変更日で集計。理由不明や連絡途絶の過去記録も含みます。':'現在有効な企業NGの一覧です。期間指定は適用しません。'});
  }catch{return json(res,503,{error:'contact_results_unavailable',hint:'連絡結果・NG理由を取得できません。保存先と接続を確認してください。'});}
}
