import {createHash} from 'node:crypto';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canRecruit,canDecideHire} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {gwLog} from '../../lib/gw-audit.js';
import {ymd} from '../../lib/jst.js';
import {readPdfFlowSummaries} from '../../lib/hr-pdf-flow-guard.js';
import {PROGRESS_EVENT,progressContext,progressRecord,progressOptions,progressNotices,progressLabel,progressPhase,validateProgressInput,readProgressEvents} from '../../lib/hr-progress.js';

// 対応段階の記録だけを更新。既存の採否・オファー・契約・合意・稼働・Office手続きは実行しない。
export default async function handler(req,res){
  res.setHeader('Cache-Control','private,no-store');
  const user=await requireUser(req,res);if(!user)return;
  const ctx=await gwContext(user.id);if(!ctx.tenantId||!canRecruit(ctx))return json(res,403,{error:'forbidden'});
  if(req.method!=='POST')return methodNotAllowed(res,['POST']);
  const b=await readJson(req);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b?.id||''))return json(res,400,{error:'invalid_id'});
  const sb=admin();
  const r=await sb.from('gw_hr_applicants').select('id,stage,status,decision,offer_type,employee_id,lead_category,updated_at').eq('tenant_id',ctx.tenantId).eq('id',b.id).maybeSingle();
  if(r.error)return json(res,503,{error:'not_ready',hint:'状態を取得できません。画面を読み直してください。'});
  const a=r.data;if(!a)return json(res,404,{error:'not_found'});
  const [events,pdf,offers]=await Promise.all([
    readProgressEvents(sb,ctx.tenantId,[a.id]),readPdfFlowSummaries(sb,ctx.tenantId,[a.id]),
    sb.from('gw_hr_offers').select('id,handoff_at').eq('tenant_id',ctx.tenantId).eq('applicant_id',a.id),
  ]);
  const flow=pdf.byApplicant.get(a.id)||null;
  const moves=progressOptions(a,{canDecide:canDecideHire(ctx),offers:offers.data||[],ready:events.ready&&pdf.ready&&!offers.error,pdfFlow:flow});
  const opt=moves.options.find(o=>o.key===b.to);
  if(!opt)return json(res,400,{error:'invalid_step'});
  if(moves.locked||opt.state!=='allowed')return json(res,409,{error:'step_blocked',hint:moves.locked||opt.reason});
  const recorded=progressRecord(a,events.events,flow);
  // 確認後のメモ更新も含め、他の操作があれば最新の状態を確認してから再試行する。
  const token=createHash('sha256').update(JSON.stringify([ctx.tenantId,a.id,progressContext(a,flow),a.updated_at,recorded.progressRevision,b.to])).digest('hex');
  const notices=progressNotices(b.to);
  const from=recorded.manualProgress?.phase||progressPhase(a,flow);
  if(b.dryRun===true)return json(res,200,{from:progressLabel(from),to:opt.label,token,...notices});
  const input=validateProgressInput(b,ymd());if(input.error)return json(res,400,input);
  if(b.token!==token)return json(res,409,{error:'stale',hint:'状態が更新されています。画面を読み直して変更してください。'});
  // updated_atだけをCASで更新。stage/status/decisionは契約フローの事実として維持する。
  const stamp=new Date().toISOString();
  const claim=await sb.from('gw_hr_applicants').update({updated_at:stamp}).eq('tenant_id',ctx.tenantId).eq('id',a.id).eq('updated_at',a.updated_at).select('id,updated_at').maybeSingle();
  if(claim.error)return json(res,503,{error:'save_failed',hint:'保存できませんでした。もう一度お試しください。'});
  if(!claim.data)return json(res,409,{error:'stale',hint:'状態が更新されています。画面を読み直してください。'});
  const detail={version:1,phase:b.to,from,method:b.method,confirmedOn:b.confirmedOn,note:input.note,context:progressContext(a,flow)};
  const saved=await sb.from('gw_hr_timeline').insert({tenant_id:ctx.tenantId,applicant_id:a.id,event_key:PROGRESS_EVENT,label:'状態を変更：'+opt.label,detail:JSON.stringify(detail),created_by:user.id,occurred_at:claim.data.updated_at}).select('id').single();
  if(saved.error)return json(res,503,{error:'save_failed',hint:'確認内容を保存できませんでした。もう一度お試しください。'});
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:'hr.hiring_progress',target:'hr_applicant:'+a.id,detail:{from:detail.from,to:b.to,method:b.method,confirmedOn:b.confirmedOn,eventId:saved.data.id}});
  return json(res,200,{ok:true,progressRevision:saved.data.id});
}
