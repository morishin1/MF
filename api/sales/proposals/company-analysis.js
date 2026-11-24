// GET: company-level history and outcome analysis. No writes, synchronization,
// mail delivery or workflow changes are performed by this endpoint.
import { requireUser } from '../../../lib/auth.js';
import { gwContext, canSell } from '../../../lib/gw.js';
import { admin, userClient } from '../../../lib/supabase.js';
import { membershipFor } from '../../../lib/enger-agent-role.js';
import { canAccessEightEngerDirectory } from '../../../lib/sales-enger-scope.js';
import { isUuid } from '../../../lib/sales-proposals.js';
import { json, methodNotAllowed } from '../../../lib/http.js';
import { buildCompanyAnalysis, selectCompanyAnalysis } from '../../../lib/sales-proposal-company-analysis.js';
import { loadCompanyAnalysisData } from '../../../lib/sales-proposal-company-analysis-data.js';

import { readReviews, applyReviewSummary } from '../../../lib/sales-outcome-data.js';

const PARAMETERS = new Set(['period', 'q', 'service', 'owner', 'focus', 'sort', 'company', 'page', 'pageSize', 'refresh']);
const PERIODS = new Set(['all', 'this_week', 'last_week', 'this_month', 'last_month']);
const FOCUSES = new Set(['all', 'passed', 'loss', 'waiting', 'unlinked', 'improvement']);
const SORTS = new Set(['recent', 'sent', 'meeting', 'passed', 'company']);
const badFilter = () => Object.assign(new Error('bad_filter'), { status: 400, code: 'bad_filter' });
const controlCharacters = /[\u0000-\u001f\u007f]/;

export function companyAnalysisFilters(url, ctx) {
  let query;
  try { query = new URL(url || '/', 'http://localhost').searchParams; }
  catch { throw badFilter(); }
  for (const key of query.keys()) {
    if (!PARAMETERS.has(key) || query.getAll(key).length !== 1) throw badFilter();
  }
  const text = (key, fallback, max) => {
    const value = query.get(key) || fallback;
    if (value.length > max || controlCharacters.test(value)) throw badFilter();
    return value.trim();
  };
  const integer = (key, fallback, max) => {
    const value = query.get(key);
    if (value === null) return fallback;
    if (!/^[1-9]\d*$/.test(value)) throw badFilter();
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result > max) throw badFilter();
    return result;
  };
  const filters = {
    period: text('period', 'all', 20), q: text('q', '', 200),
    service: text('service', 'all', 100), owner: text('owner', 'all', 50),
    focus: text('focus', 'all', 20), sort: text('sort', 'recent', 20),
    company: text('company', '', 1024) || null,
    page: integer('page', 1, 10000), pageSize: integer('pageSize', 20, 50),
  };
  if (!PERIODS.has(filters.period) || !FOCUSES.has(filters.focus) || !SORTS.has(filters.sort)
      || !['all', 'none', 'me'].includes(filters.owner) && !isUuid(filters.owner)
      || query.has('refresh') && !['0', '1'].includes(query.get('refresh'))) throw badFilter();
  if (filters.owner === 'me') {
    if (!isUuid(ctx.employee?.id)) throw badFilter();
    filters.owner = ctx.employee.id;
  }
  return filters;
}

export async function runCompanyAnalysis(req, res, { db, sb, ctx, now = new Date().toISOString() }) {
  const filters = companyAnalysisFilters(req.url, ctx);
  const input = await loadCompanyAnalysisData({ db, sb, tenantId: ctx.tenantId });
  const model = buildCompanyAnalysis({ ...input, now });
  const reviews = await readReviews(db, ctx.tenantId, ['affiliation','feedback','meeting','terms'],
    'id,kind,entity_key,cycle:payload->>cycle,status:payload->>status,grade:payload->>grade,category:payload->>category,side:payload->>side,quote:payload->>quote,observed:payload->>observed,channel:payload->>channel');
  applyReviewSummary(model,reviews);
  const result = selectCompanyAnalysis(model, filters);
  return json(res, 200, result);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const ctx = await gwContext(user.id);
    if (!canSell(ctx) || !canAccessEightEngerDirectory(ctx) || ctx.employee?.status !== 'active')
      return json(res, 403, { error: 'forbidden' });
    const db = admin();
    const membership = await membershipFor(db, user.id);
    // Same legacy-compatible membership policy as readiness: a known external,
    // inactive or partner membership can never read the complete ENGER history.
    if (membership && (membership.status !== 'active' || membership.membership_type !== 'internal' || membership.partner_organization_id))
      return json(res, 403, { error: 'forbidden' });
    return await runCompanyAnalysis(req, res, { db, sb: userClient(req), ctx });
  } catch (error) {
    if (error?.status === 400) return json(res, 400, {
      error: 'bad_filter', hint: '期間・絞り込みの指定を確認してください。',
    });
    if (error?.status === 404) return json(res, 404, {
      error: 'company_not_found', hint: '指定された企業の提案履歴が見つかりません。',
    });
    const limited = error?.code === 'analysis_data_limit';
    console.error('[sales-company-analysis]', limited ? 'data_limit' : 'unavailable');
    return json(res, 503, {
      error: limited ? 'analysis_data_limit' : 'analysis_data_unavailable',
      hint: limited
        ? '履歴が取得上限を超えたため、正確な集計を表示できません。管理者に確認してください。'
        : '企業・提案の履歴を確認できませんでした。時間をおいて再度お試しください。',
    });
  }
}
