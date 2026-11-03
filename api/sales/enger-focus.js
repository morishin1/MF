// Authenticated, read-only ENGER focus snapshot for the Sales dashboard.
// ENGER remains the source of truth. Never expose candidate contacts or write back.
import {json,methodNotAllowed} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS=5;
const clean=(value,max=120)=>String(value||'').trim().slice(0,max);
const checkedTime=value=>value&&Number.isFinite(Date.parse(value))?value:null;
const cleanSkill=v=>typeof v==='string'?clean(v,36):'';
const toSkills=list=>Array.isArray(list)?list.map(cleanSkill).filter(Boolean).slice(0,3):[];
const workNo=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;

const makeQuery=(db,table,fields)=>db.schema('enger').from(table)
  .select(fields,{count:'exact'}).eq('is_focus',true).eq('is_closed',false)
  .is('deleted_at',null).order('focused_at',{ascending:false,nullsFirst:false})
  .order('id',{ascending:true}).limit(MAX_ROWS);

export default async function handler(req,res){
  const user=await requireUser(req,res);if(!user)return;
  if(req.method!=='GET')return methodNotAllowed(res,['GET']);
  res.setHeader?.('Cache-Control','private, no-store');
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx))return json(res,403,{error:'forbidden'});
  try{
    // Admin client is allowed ONLY after verifying Sales access; query only
    // narrowly selected non-sensitive fields. No candidate name, email or phone.
    const db=admin();
    const [jobs,candidates]=await Promise.all([
      makeQuery(db,'jobs','id,job_no,title,role_label,skills,last_confirmed_at,focused_at,dx2_focus_decision_due'),
      makeQuery(db,'candidates','id,candidate_no,initials,title,skills,focused_at,dx2_focus_decision_due'),
    ]);
    if(jobs.error||candidates.error||jobs.count==null||candidates.count==null){
      return json(res,503,{error:'enger_focus_unavailable',hint:'ENGERの注力一覧を取得できませんでした。接続・権限を確認してください。'});
    }
    return json(res,200,{
      updatedAt:new Date().toISOString(),
      source:'enger',scope:'current_active',complete:true,
      jobs:{
        count:jobs.count,
        rows:(jobs.data||[]).map(row=>({
          id:UUID.test(row.id)?row.id:null,
          no:workNo(row.job_no),title:clean(row.title)||'案件名未登録',
          role:clean(row.role_label,60),skills:toSkills(row.skills),
          lastConfirmedAt:checkedTime(row.last_confirmed_at),
          focusedAt:checkedTime(row.focused_at),
          decisionDue:row.dx2_focus_decision_due||null,
        })),
      },
      talents:{
        count:candidates.count,
        rows:(candidates.data||[]).map(row=>({
          id:UUID.test(row.id)?row.id:null,
          no:workNo(row.candidate_no),
          initials:clean(row.initials,30)||'匿名人材',
          role:clean(row.title,80),skills:toSkills(row.skills),
          focusedAt:checkedTime(row.focused_at),
          decisionDue:row.dx2_focus_decision_due||null,
        })),
      },
      note:'現在注力中・未クローズの件数。提案許可・予算・利益・稼働可否を確定するものではありません。',
    });
  }catch{
    return json(res,503,{error:'enger_focus_unavailable',hint:'ENGER注力情報を取得できませんでした。'});
  }
}
