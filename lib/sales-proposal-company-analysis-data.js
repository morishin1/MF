// Read-only inputs for enterprise proposal analysis. The caller must first pass
// the Eight tenant / active internal membership gate used by readiness.js.
// Sales rows always use the requesting user's client, tenant and RLS.
import { isUuid } from './sales-proposals.js';

export const COMPANY_ANALYSIS_LIMITS = Object.freeze({
  pageSize: 1000,
  proposals: 20000,
  companies: 50000,
  history: 100000,
  pageRequests: 1001,
});

const SALES_PROPOSAL_FIELDS = 'id,tenant_id,source_system,source_proposal_id,source_company_id,company_id,company_name,service,title,job_title,talent_initials,sales_owner_id,proposal_owner_id,matched_at,sent_at,status,close_reason,close_note,closed_at,meeting_at,archived_at,created_at,updated_at';
const ENGER_PROPOSAL_FIELDS = 'id,company_id,company,job_id,candidate_id,job_title,candidate_name,business_category,stage,pre_lost_stage,created_at,updated_at,proposed_at,stage_updated_at,deleted_at,lost_phase,lost_reason,lost_reason_category,lost_detail_reason,lost_reason_note,dx2_lost_side,lost_related_conditions,meeting_date,meeting_time,meeting_status,meeting_date_2,meeting_time_2,job_action_type,cand_action_type,mail_sent_at,dx2_is_blast,match_evaluation_id,confirm_notified_at';
const ACTIVITY_FIELDS = 'id,tenant_id,proposal_id,kind,result,outcome,evidence,occurred_at,created_at,source_event,employee_id';
const STAGE_FIELDS = 'id,action,target_type,target_id,created_at,detail';
const ROUND_FIELDS = 'id,proposal_id,side,opens_round,sent_at';
const REACTION_FIELDS = 'id,proposal_id,side,round_id,result,reason_code,reason_label,answered_at,recorded_at';

export class CompanyAnalysisReadError extends Error {
  constructor(code, source) {
    super(code);
    this.name = 'CompanyAnalysisReadError';
    this.code = code;
    this.source = source;
  }
}

const readError = source => new CompanyAnalysisReadError('analysis_data_unavailable', source);
const limitError = source => new CompanyAnalysisReadError('analysis_data_limit', source);

/**
 * Keyset pages end only on an empty result. A short PostgREST page can be a
 * server row cap, so treating it as EOF would silently lose historical results.
 * Every source has a unique, selected key. Assessment revisions instead use
 * their composite (proposal_id, revision) key and an offset that advances by
 * the actual received row count. One extra row detects the exact cap;
 * malformed/nonadvancing pages and every read error fail the whole aggregate.
 */
export async function readCompanyAnalysisRows(makeQuery, {
  source = 'history', key = 'id', maxRows = COMPANY_ANALYSIS_LIMITS.history,
  pageSize = COMPANY_ANALYSIS_LIMITS.pageSize,
  maxPages = COMPANY_ANALYSIS_LIMITS.pageRequests,
} = {}) {
  const keys = Array.isArray(key) ? key : [key];
  const rows = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    let result;
    try {
      let query = makeQuery();
      for (const column of keys) query = query.order(column, { ascending: true });
      const size = Math.min(pageSize, maxRows - rows.length + 1);
      if (keys.length === 1) {
        if (cursor !== null) query = query.gt(keys[0], cursor[0]);
        result = await query.limit(size);
      } else result = await query.range(rows.length, rows.length + size - 1);
    } catch {
      throw readError(source);
    }
    if (!result || result.error || !Array.isArray(result.data)) throw readError(source);
    if (!result.data.length) return rows;
    for (const row of result.data) {
      const next = keys.map(column => row?.[column]);
      if (next.some(value => !(typeof value === 'string' && value || Number.isSafeInteger(value)))) throw readError(source);
      if (cursor !== null) {
        const different = next.findIndex((value, index) => value !== cursor[index]);
        if (different === -1 || next[different] <= cursor[different]) throw readError(source);
      }
      rows.push(row);
      cursor = next;
      if (rows.length > maxRows) throw limitError(source);
    }
  }
  throw limitError(source);
}

async function readByIds(ids, makeQuery, options = {}) {
  const uniqueIds = [...new Set(ids.filter(isUuid))];
  const rows = [];
  const maxRows = options.maxRows ?? COMPANY_ANALYSIS_LIMITS.history;
  for (let start = 0; start < uniqueIds.length; start += 100) {
    const part = uniqueIds.slice(start, start + 100);
    const data = await readCompanyAnalysisRows(() => makeQuery(part), {
      ...options, maxRows: maxRows - rows.length,
    });
    rows.push(...data);
  }
  return rows;
}

const scoped = (sb, tenant, table, fields) => sb.from(table).select(fields).eq('tenant_id', tenant);

export async function loadCompanyAnalysisData({ db, sb, tenantId }) {
  const en = db.schema('enger');
  const [salesProposals, engerProposals, salesCompanies, engerCompanies, companyLinks, employees] = await Promise.all([
    readCompanyAnalysisRows(() => scoped(sb, tenantId, 'gw_sales_proposals', SALES_PROPOSAL_FIELDS), {
      source: 'sales_proposals', maxRows: COMPANY_ANALYSIS_LIMITS.proposals,
    }),
    // Keep source tombstones in the model input so stale Sales copies cannot
    // resurrect a deleted source. The model excludes them from all results.
    readCompanyAnalysisRows(() => en.from('proposals').select(ENGER_PROPOSAL_FIELDS), {
      source: 'enger_proposals', maxRows: COMPANY_ANALYSIS_LIMITS.proposals,
    }),
    readCompanyAnalysisRows(() => scoped(sb, tenantId, 'gw_sales_companies', 'id,tenant_id,name,hidden_at'), {
      source: 'sales_companies', maxRows: COMPANY_ANALYSIS_LIMITS.companies,
    }),
    readCompanyAnalysisRows(() => en.from('companies').select('id,name,deleted_at').is('deleted_at', null), {
      source: 'enger_companies', maxRows: COMPANY_ANALYSIS_LIMITS.companies,
    }),
    readCompanyAnalysisRows(() => scoped(sb, tenantId, 'gw_sales_company_links', 'id,tenant_id,source_system,source_company_id,company_id')
      .eq('source_system', 'enger'), { source: 'company_links', maxRows: COMPANY_ANALYSIS_LIMITS.companies }),
    readCompanyAnalysisRows(() => scoped(sb, tenantId, 'gw_employees', 'id,tenant_id,display_name'), {
      source: 'employees', maxRows: COMPANY_ANALYSIS_LIMITS.companies,
    }),
  ]);

  const salesIds = salesProposals.map(row => row.id);
  const visibleSalesIds = new Set(salesIds);
  const sourceProposals = engerProposals.filter(row => !row.deleted_at);
  const sourceIds = new Set(sourceProposals.map(row => row.id));
  const sourceJobIds = new Set(sourceProposals.map(row => row.job_id).filter(isUuid));
  const [salesActivities, assessments, stages, rounds, reactions, historyLinks] = await Promise.all([
    readCompanyAnalysisRows(() => scoped(sb, tenantId, 'gw_sales_proposal_activities', ACTIVITY_FIELDS), {
      source: 'sales_activities',
    }),
    // The latest-results view omits time and revision. Read just the projected
    // outcome from the service-only assessment table, constrained to caller-RLS
    // proposal IDs, so an outcome after a reopened proposal remains usable.
    readByIds(salesIds, ids => scoped(db, tenantId, 'gw_sales_proposal_assessments',
      'tenant_id,proposal_id,revision,created_at,interview_result:facts->>interviewResult')
      .in('proposal_id', ids), { source: 'latest_results', key: ['proposal_id', 'revision'] }),
    // Full-history access was checked before this loader. Read each compact
    // source once instead of issuing many empty requests per 100 proposals,
    // then retain only records belonging to the loaded live proposals below.
    readCompanyAnalysisRows(() => en.from('activity_logs').select(STAGE_FIELDS)
      .eq('target_type', 'proposal').eq('action', 'ステージ変更'), { source: 'stage_history' }),
    readCompanyAnalysisRows(() => en.from('dx2_proposal_email_rounds').select(ROUND_FIELDS), { source: 'email_rounds' }),
    readCompanyAnalysisRows(() => en.from('dx2_proposal_email_reactions').select(REACTION_FIELDS), { source: 'email_reactions' }),
    readCompanyAnalysisRows(() => en.from('dx2_sales_company_history_links')
      .select('id,tenant_id,company_id,entity_type,entity_id,source_kind,linked_at')
      .eq('tenant_id', tenantId).in('entity_type', ['proposal', 'job']), { source: 'confirmed_history_links' }),
  ]);
  const latest = new Map();
  for (const assessment of assessments) {
    const previous = latest.get(assessment.proposal_id);
    if (!previous || assessment.revision > previous.revision) latest.set(assessment.proposal_id, assessment);
  }
  const latestResults = [...latest.values()];
  const activities = salesActivities.filter(row => visibleSalesIds.has(row.proposal_id));
  const stageHistory = stages.filter(row => sourceIds.has(row.target_id));
  const emailRounds = rounds.filter(row => sourceIds.has(row.proposal_id));
  const emailReactions = reactions.filter(row => sourceIds.has(row.proposal_id));
  const confirmedHistoryLinks = historyLinks.filter(row => row.entity_type === 'proposal'
    ? sourceIds.has(row.entity_id) : sourceJobIds.has(row.entity_id));
  return {
    engerProposals, salesProposals, activities, latestResults, stageHistory,
    companyLinks, confirmedHistoryLinks,
    emailRounds, emailReactions, engerCompanies, salesCompanies, employees,
    engerAvailable: true, tenantId,
  };
}
