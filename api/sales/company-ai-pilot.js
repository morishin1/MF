// GET: ten-company review list. POST: owner-only single company analysis (max 10 allowlisted IDs).
// The API never sends outreach, creates ENGER jobs, or changes matching scores.
import { requireUser } from '../../lib/auth.js';
import { gwContext, canSell, isOwner } from '../../lib/gw.js';
import { userClient, admin } from '../../lib/supabase.js';
import { json, readJson, methodNotAllowed } from '../../lib/http.js';
import { COMPANY_AI_PILOT, pilotFor, safePilotUrl, collectPublicWebsite, analyzeCompanyWithCloud } from '../../lib/sales-company-ai-pilot.js';
import { fetchGbizCompany, sameCompanyName } from '../../lib/sales-company-gbiz.js';

export const config = { maxDuration: 60 };
const TABLE = 'gw_sales_company_summaries';
const FIELDS = 'company_id,status,summary,markdown,facts,hypotheses,match_signals,sources,unknowns,next_actions,model,token_usage,prompt_version,attempt_count,last_error,requested_at,processed_at,updated_at';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx)) return json(res, 403, { error:'forbidden' });
  res.setHeader('Cache-Control','private, no-store');
  if (req.method === 'GET') return readPilot(req, res, ctx);
  if (req.method === 'POST') {
    if (!isOwner(ctx)) return json(res, 403, { error:'owner_only' });
    if (process.env.ENGER_COMPANY_AI_PILOT !== 'enabled')
      return json(res, 403, { error:'pilot_disabled' });
    return runOne(req, res, ctx);
  }
  return methodNotAllowed(res, ['GET','POST']);
}

async function readPilot(req, res, ctx) {
  const sb = userClient(req);
  const ids = COMPANY_AI_PILOT.map(x=>x.companyId);
  const [names, summaries, links] = await Promise.all([
    sb.from('gw_sales_companies').select('id,name,site_url,status,tenant_id')
      .eq('tenant_id',ctx.tenantId).in('id',ids),
    sb.from(TABLE).select(FIELDS).eq('tenant_id',ctx.tenantId).in('company_id',ids),
    sb.from('gw_sales_company_links').select('company_id').eq('tenant_id',ctx.tenantId).in('company_id',ids)
  ]);
  if (names.error) return json(res, 503, {error:'company_list_unavailable'});
  if (summaries.error) return json(res, 503, {error:'summary_storage_unavailable',hint:'db/162_enger_company_ai_summaries.sql の適用状況を確認してください'});
  if (links.error) return json(res, 503, {error:'company_links_unavailable'});
  const nameById = new Map((names.data||[]).map(x=>[x.id,x]));
  const summaryById = new Map((summaries.data||[]).map(x=>[x.company_id,x]));
  const linkCount = new Map();
  for (const l of links.data||[]) linkCount.set(l.company_id,(linkCount.get(l.company_id)||0)+1);
  const rows = COMPANY_AI_PILOT.map(p=>{
    const c = nameById.get(p.companyId);
    const a = summaryById.get(p.companyId);
    return {
      companyId:p.companyId, name:c?.name||'登録企業が見つかりません',
      siteUrl:c?.site_url||null, salesStatus:c?.status||null,
      engerLinkRecordCount:linkCount.get(p.companyId)||0,
      analysis:a||null
    };
  });
  return json(res,200,{pilot:'company-matching-10',limit:10,featureEnabled:process.env.ENGER_COMPANY_AI_PILOT === 'enabled',rows});
}

async function runOne(req, res, ctx) {
  const payload = await readJson(req);
  const selected = pilotFor(payload?.companyId);
  if (!selected) return json(res,400,{error:'not_in_ten_company_pilot'});
  if (!process.env.ANTHROPIC_API_KEY) return json(res,503,{error:'cloud_ai_key_missing'});

  const sb = admin();
  const companyRead = await sb.from('gw_sales_companies').select('id,tenant_id,name,site_url,hidden_at,ng_reason')
    .eq('id',selected.companyId).eq('tenant_id',ctx.tenantId).maybeSingle();
  if (companyRead.error) return json(res,503,{error:'company_unavailable'});
  const company = companyRead.data;
  if (!company) return json(res,404,{error:'company_not_found'});
  if (company.hidden_at) return json(res,409,{error:'company_hidden'});
  if (!safePilotUrl(company.site_url, selected.domain)) return json(res,409,{error:'official_domain_mismatch',hint:'Sales登録URLと実証対象の公式ドメインを確認してください'});

  // Claim before paying the AI. Unique (tenant_id,company_id) prevents duplicate first runs.
  const current = await sb.from(TABLE).select('status,attempt_count')
    .eq('company_id',selected.companyId).eq('tenant_id',ctx.tenantId).maybeSingle();
  if (current.error) return json(res,503,{error:'pilot_storage_not_ready'});
  let attempt = 1;
  if (current.data) {
    if (current.data.status === 'completed') return json(res,200,{ok:true,alreadyCompleted:true,companyId:selected.companyId});
    if (current.data.status !== 'failed' || current.data.attempt_count >= 3)
      return json(res,409,{error:'already_running_or_review_required',status:current.data.status});
    attempt = current.data.attempt_count+1;
    const claim = await sb.from(TABLE).update({
      status:'processing',attempt_count:attempt,requested_at:new Date().toISOString(),last_error:null
    }).eq('company_id',selected.companyId).eq('tenant_id',ctx.tenantId)
      .eq('status','failed').eq('attempt_count',current.data.attempt_count).select('company_id').maybeSingle();
    if (claim.error || !claim.data) return json(res,409,{error:'claim_conflict'});
  } else {
    const claim = await sb.from(TABLE).insert({
      company_id:selected.companyId,tenant_id:ctx.tenantId,
      status:'processing',attempt_count:1
    });
    if (claim.error) return json(res,claim.error.code==='23505'?409:503,{
      error:claim.error.code==='23505'?'already_claimed':'claim_failed'
    });
  }

  try {
    const [pages, sent, linked] = await Promise.all([
      collectPublicWebsite(company.site_url,selected.domain),
      sb.from('gw_sales_approaches').select('id',{count:'exact',head:true})
        .eq('tenant_id',ctx.tenantId).eq('company_id',selected.companyId).not('sent_at','is',null),
      sb.from('gw_sales_company_links').select('source_system,source_company_id')
        .eq('tenant_id',ctx.tenantId).eq('company_id',selected.companyId).limit(10),
    ]);
    if (sent.error || linked.error) throw new Error('internal_evidence_unavailable');
    // Read corporate numbers ONLY via an existing same-tenant ENGER company-ID link.
    // Never merge a company using a name-only search.
    let registry = null;
    const engIds = (linked.data || []).filter(x => x.source_system === 'enger' &&
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(x.source_company_id || '')))
      .map(x => x.source_company_id);
    if (engIds.length === 1) {
      const eng = await sb.schema('enger').from('companies')
        .select('id,name,website,corporate_number').eq('id',engIds[0]).maybeSingle();
      if (!eng.error && eng.data && safePilotUrl(eng.data.website,selected.domain)) {
        const official = await fetchGbizCompany(eng.data.corporate_number);
        if (official) registry = {
          ...official,
          identityStatus: sameCompanyName(company.name,official.name) &&
            sameCompanyName(eng.data.name,official.name) ?
              'registry_name_domain_match' : 'name_or_identity_review_required'
        };
      }
    }
    const answer = await analyzeCompanyWithCloud({
      name:company.name,companyId:company.id,pages,
      activityCount:sent.count||0,links:(linked.data||[]).length,registry
    });
    const saved = await sb.from(TABLE).update({
      ...answer, token_usage:answer.token_usage,
      processed_at:new Date().toISOString(),updated_at:new Date().toISOString(),last_error:null
    }).eq('tenant_id',ctx.tenantId).eq('company_id',selected.companyId)
      .eq('status','processing').eq('attempt_count',attempt).select('company_id').maybeSingle();
    if (saved.error || !saved.data) throw new Error('summary_save_failed');
    return json(res,200,{ok:true,companyId:selected.companyId,status:answer.status,
      summary:answer.summary,demandHypotheses:answer.match_signals.demand_hypotheses.length,
      sourceCount:answer.sources.length,tokenUsage:answer.token_usage});
  } catch (err) {
    const message = String(err?.message||'unknown_error').slice(0,200);
    await sb.from(TABLE).update({
      status:'failed',last_error:message,updated_at:new Date().toISOString()
    }).eq('tenant_id',ctx.tenantId).eq('company_id',selected.companyId)
      .eq('status','processing').eq('attempt_count',attempt);
    return json(res,502,{error:'company_analysis_failed',reason:message,companyId:selected.companyId});
  }
}
