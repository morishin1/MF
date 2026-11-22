import { createHash } from 'node:crypto';
import { requireUser } from '../../../lib/auth.js';
import { gwContext, canSell } from '../../../lib/gw.js';
import { admin, userClient } from '../../../lib/supabase.js';
import { membershipFor } from '../../../lib/enger-agent-role.js';
import { canAccessEightEngerDirectory } from '../../../lib/sales-enger-scope.js';
import { json, methodNotAllowed, readJson } from '../../../lib/http.js';
import { canManageProposals, isClosed, isUuid, CLOSE_REASON_LABEL } from '../../../lib/sales-proposals.js';
import { inChunks, loadProposal } from '../../../lib/sales-proposals-db.js';
import { isPublicTalent, redact } from '../../../lib/enger-talent-public.js';
import { assessReadiness, evidenceFor, normalizeReadinessFacts, summarizeInterviewFeedback } from '../../../lib/sales-proposal-readiness.js';
import { prepareInterview, interviewAiConfigured } from '../../../lib/sales-proposal-interview-ai.js';
import { jstDate } from '../../../lib/timecard.js';

const TABLE = 'gw_sales_proposal_assessments';
const fallbackName = name => typeof name === 'string' && name.trim() && !['未登録','不明','—','-','個人'].includes(name.trim());
const ensure = result => { if (result.error) throw result.error; return result.data; };
const money = v => v != null && Number(v) > 0 && Number(v) <= 300 ? Number(v) : null;
function termsOf(job, talent, meetingHeld) {
  const rateLabel = typeof talent?.rate === 'string' ? talent.rate.normalize('NFKC').trim() : '';
  const simpleRate = rateLabel.match(/^(\d{1,3}(?:\.\d+)?)\s*万(?:円)?(?:\s*[/／]\s*月)?$/);
  const flow = typeof job?.flow_note === 'string' ? job.flow_note.normalize('NFKC').trim() : '';
  return {
    jobMin: money(job?.salary_min), jobMax: money(job?.salary_max),
    talentMin: money(talent?.salary_min) ?? (simpleRate ? money(simpleRate[1]) : null),
    talentMax: money(talent?.salary_max),
    jobStart: job?.start_date || null, talentStart: talent?.start_date || redact(talent?.avail, 60),
    location: redact(job?.work_location, 80), remote: redact(talent?.remote_pref, 45),
    flow: /^(?:エンド直|エンド直請け|元請直|一次請け|商流制限なし|制限なし)$/.test(flow) ? flow : null,
    closed: Boolean(job?.is_closed), unlinked: !job || !talent, meetingHeld,
  };
}

async function companyHistory(db, sb, tenantId, p) {
  const lookup = sb.from('gw_sales_proposals').select('id,source_proposal_id,status,close_reason')
    .eq('tenant_id', tenantId).eq('source_system','enger').not('sent_at','is',null);
  let basis;
  if (p.company_id) { lookup.eq('company_id', p.company_id); basis = 'Salesの企業ID'; }
  else if (isUuid(p.source_company_id)) { lookup.eq('source_company_id', p.source_company_id); basis = 'ENGERの企業ID'; }
  else if (fallbackName(p.company_name)) { lookup.eq('company_name', p.company_name); basis = '同じ提案先企業名'; }
  else return null;
  const history = ensure(await lookup.order('sent_at', { ascending: false }).order('id').limit(251));
  const sample = history.slice(0, 250);
  const [ meetings, earned, revisions, feedback ] = await Promise.all([
    inChunks(sample.map(row => row.id), ids => sb.from('gw_sales_proposal_activities').select('proposal_id')
      .eq('tenant_id',tenantId).eq('kind','meeting').eq('result','done').in('proposal_id', ids)),
    inChunks(sample.map(row => row.source_proposal_id).filter(isUuid), ids => db.schema('enger').from('proposals')
      .select('id').in('id', ids).is('deleted_at', null).in('stage', ['合格','面談合格'])),
    inChunks(sample.map(row => row.id), ids => db.from('gw_sales_proposal_latest_results').select('proposal_id,interview_result')
      .eq('tenant_id', tenantId).in('proposal_id', ids)),
    inChunks(sample.map(row => row.id), ids => db.from(TABLE).select('proposal_id,revision,facts')
      .eq('tenant_id',tenantId).in('proposal_id', ids).order('revision',{ ascending: false }).limit(1000)),
  ]);
  const held = new Set(ensure(meetings).map(row => row.proposal_id));
  const sourcePassed = new Set(ensure(earned).map(row => row.id));
  const latest = new Map(ensure(revisions).map(row => [row.proposal_id, row.interview_result]));
  const previous = new Set(sample.filter(row => row.id !== p.id).map(row => row.id));
  const interviewFeedback = summarizeInterviewFeedback(ensure(feedback), previous);
  const summary = { basis, sent: sample.length, meetings: 0, passed: 0, won: 0, lost: {}, interviewFeedback, limited: history.length > sample.length };
  for (const row of sample) {
    const pass = latest.get(row.id) === 'passed' || (!latest.get(row.id) && sourcePassed.has(row.source_proposal_id));
    if (pass) summary.passed++;
    if (pass || held.has(row.id) || row.status === 'meeting_done') summary.meetings++;
    if (row.status === 'won') summary.won++;
    if (['lost','closed_no_reply','stopped'].includes(row.status)) {
      const label = CLOSE_REASON_LABEL[row.close_reason] || '理由未記録';
      summary.lost[label] = (summary.lost[label] || 0) + 1;
    }
  }
  return summary;
}

export async function runReadiness(req, res, { db, sb, ctx, user, prepare = prepareInterview }) {
  const get = req.method === 'GET';
  const body = get ? {} : await readJson(req);
  const id = get ? new URL(req.url, 'http://localhost').searchParams.get('id') : body?.id;
  if (!isUuid(id)) return json(res,400,{error:'invalid_proposal'});
  const result = await loadProposal(sb, ctx.tenantId, id);
  if (result.error) throw result.error;
  const p = result.proposal;
  if (p?.source_system !== 'enger' || !isUuid(p.source_proposal_id)) return json(res,404,{error:'not_linked', hint:'ENGERに連携済みの提案で利用できます。'});
  const en = db.schema('enger');
  const scope = { p_tenant: ctx.tenantId, p_proposal: p.id };
  const manager = canManageProposals(ctx);
  const inactive = Boolean(p.archived_at || p.contact_stop || isClosed(p.status));
  const canEdit = Boolean(p.sent_at && !inactive && (manager || (ctx.employee?.id && ctx.employee.id === p.sales_owner_id)));
  if (!get && !canEdit) return json(res, 403, { error: 'forbidden', hint:'現在のSales担当者または管理者が保存できます。'});
  const [ source, saved, meetings, history ] = await Promise.all([
    en.from('proposals').select('job_id,candidate_id,job_action_type,cand_action_type,match_evaluation_id,stage')
      .eq('id',p.source_proposal_id).is('deleted_at',null).maybeSingle().then(ensure),
    db.from(TABLE).select('revision,facts,assessment,created_at').eq('tenant_id',ctx.tenantId)
      .eq('proposal_id',id).order('revision',{ascending:false}).limit(1).maybeSingle().then(ensure),
    sb.from('gw_sales_proposal_activities').select('id').eq('tenant_id',ctx.tenantId).eq('proposal_id',id)
      .eq('kind','meeting').eq('result','done').limit(1).then(ensure),
    companyHistory(db, sb, ctx.tenantId, p).catch(() => null),
  ]);
  if (!source) return json(res,404,{error:'source_missing',hint:'ENGERで元の提案を確認してください。'});
  const [ job, talent, ai ] = await Promise.all([
    isUuid(source.job_id) ? en.from('jobs').select('skills,detail,required_experience_years,salary_min,salary_max,start_date,work_location,flow_note,is_closed,deleted_at,updated_at')
      .eq('id', source.job_id).maybeSingle().then(ensure) : null,
    isUuid(source.candidate_id) ? en.from('candidates').select('id,skills,exp,avail,start_date,salary_min,salary_max,rate,remote_pref,status,is_closed,deleted_at,updated_at')
      .eq('id', source.candidate_id).maybeSingle().then(ensure) : null,
    isUuid(source.job_id) && isUuid(source.candidate_id) ?
      en.from('dx2_match_ai_evaluations').select('id,score,result_json,analyzed_at').eq('job_id',source.job_id).eq('candidate_id',source.candidate_id)
        .eq('status','成功').is('superseded_at',null).order('analyzed_at',{ascending:false}).limit(1).maybeSingle().then(ensure).catch(() => null) : null,
  ]);
  const readableJob = job && !job.deleted_at ? job : null;
  const readableTalent = isPublicTalent(talent) ? talent : null;
  const freshAi = ai && readableJob && readableTalent && [job.updated_at, talent.updated_at].every(at => !at || Date.parse(at) <= Date.parse(ai.analyzed_at)) ? ai : null;
  const fit = evidenceFor(readableJob, readableTalent, freshAi);
  const meetingHeld = meetings.length > 0 || p.status === 'meeting_done' || ['合格','面談合格'].includes(source.stage);
  const conditions = {
    ...termsOf(readableJob, readableTalent, meetingHeld),
    sourceClosed: ['失注','見送り','辞退','不合格'].includes(source.stage),
    meetingBooked: Boolean(p.meeting_at && Date.parse(p.meeting_at) > Date.now()),
  };
  if (job?.deleted_at || talent?.deleted_at || (talent && !readableTalent)) conditions.closed = true;
  const today = jstDate();
  const fitHash = createHash('sha256').update(JSON.stringify(fit)).digest('hex');
  let preparation = saved?.assessment?.preparation?.fitHash === fitHash ? saved.assessment.preparation : null;
  let facts = saved?.facts || {};
  const revision = saved?.revision || 0;
  const canAnalyze = Boolean(canEdit && !conditions.closed && !conditions.sourceClosed && !fit.ai && interviewAiConfigured() && (fit.checks.length || fit.matched.length) && !preparation);
  if (!get) {
    if (body.revision !== revision) return json(res,409,{error:'assessment_changed',hint:'別の担当者が更新しました。表示を開き直してください。'});
    if (body.action === 'save') {
      facts = normalizeReadinessFacts(body.facts,today,meetingHeld);
      if (!facts) return json(res,400,{error:'invalid_facts',hint:'入力内容を確認してください。過去実績やスキルを確認済みにした場合は、根拠を記入してください。'});
    } else if (body.action === 'analyze' && canAnalyze) {
      try { preparation = { ...await prepare(fit), fitHash, at:new Date().toISOString() }; }
      catch { return json(res,503,{error:'ai_unavailable',hint:'AI分析を取得できませんでした。登録済みの比較を確認できます。'}); }
    } else return json(res,400,{error:'invalid_action'});
  }
  const assessment = assessReadiness({facts,source,fit,history,conditions,today,inactive});
  let current = revision;
  if (!get) {
    const save = await db.rpc('gw_append_sales_proposal_assessment',{
      ...scope, p_revision:revision,p_actor:user.id,p_employee:ctx.employee?.id || null,p_manager:manager,
      p_facts:facts,p_assessment:{...assessment,preparation},
    });
    if (save.error?.code === '40001') return json(res,409,{error:'assessment_changed',hint:'別の担当者が更新しました。表示を開き直してください。'});
    if (save.error?.code === '42501') return json(res,403,{error:'forbidden',hint:'提案の担当または対応状況が変更されました。'});
    current = ensure(save);
  }
  return json(res,200,{
    facts, revision:current, canEdit, canAnalyze:canAnalyze && !preparation, assessment, conditions, history, fit,
    interview: fit.ai || (preparation ? Object.fromEntries(Object.entries(preparation).filter(([key]) => key !== 'fitHash')) : null),
    companyReply: ['proceed','pass'].includes(source.job_action_type) ? source.job_action_type : null,
    candidateReply: ['proceed','pass'].includes(source.cand_action_type) ? source.cand_action_type : null,
    recordedAt: !get && body.action === 'save' ? new Date().toISOString() : saved?.created_at || null,
  });
}

export default async function handler(req,res) {
  if (!['GET','POST'].includes(req.method)) return methodNotAllowed(res,['GET','POST']);
  res.setHeader('Cache-Control','private, no-store');
  const user = await requireUser(req,res); if (!user) return;
  try {
    const ctx = await gwContext(user.id);
    if (!canSell(ctx) || !canAccessEightEngerDirectory(ctx) || ctx.employee?.status !== 'active')
      return json(res,403,{error:'forbidden'});
    const db = admin();
    const membership = await membershipFor(db, user.id);
    if (membership && (membership.status !== 'active' || membership.membership_type !== 'internal' || membership.partner_organization_id))
      return json(res,403,{error:'forbidden'});
    return await runReadiness(req,res,{db,sb:userClient(req),ctx,user});
  } catch (error) {
    console.error('[sales-proposal-readiness]',error?.code || 'unavailable');
    return json(res,503,{error:'assessment_unavailable',hint:'成約分析を取得・保存できませんでした。'});
  }
}
