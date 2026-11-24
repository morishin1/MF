// Read-only company analytics. ENGER owns proposal/outcome facts; Sales contributes
// confirmed sending and follow-up evidence. No score here predicts a future result.
import { proposalFlow, improvementSignal, currentAnswers } from './sales-proposal-flow.js';
import { createHash } from 'node:crypto';
import { resolveProposalPeriod } from './sales-proposal-period.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PERIODS = new Set(['all', 'this_week', 'last_week', 'this_month', 'last_month', 'custom']);
const FOCUSES = new Set(['all', 'passed', 'loss', 'waiting', 'unlinked', 'improvement']);
const SORTS = new Set(['recent', 'sent', 'meeting', 'passed', 'company']);
const ACTIVE_STAGES = new Set(['提案中', '確認中', '所属確認', '面談', '面談調整', '面談設定']);
const LOSS_STAGES = new Set(['失注', '見送り']);
const CLOSED_SALES = new Set(['won', 'lost', 'stopped', 'closed_no_reply']);
const SALES_STAGE = { proposal_wait: '提案準備', call_wait: '連絡待ち', mail_wait: '送付待ち', reply_wait: '回答待ち',
  meeting_adjust: '面談調整', meeting_done: '面談実施済み', considering: '検討中', reproposal: '再提案',
  won: '成約', lost: '失注', stopped: '連絡停止', closed_no_reply: '無回答で終了' };
const CLOSE_REASON = { client_declined: '企業見送り', talent_declined: '人材辞退', filled: '募集充足',
  sales_hold: '対応保留', client_considering: '企業検討中', other_candidate: '他候補決定',
  no_reply: '無回答で終了', contact_stop: '連絡停止', other: 'その他' };
const PHASES = new Map([
  ['1. 接触前失注', { code: 'before_contact', label: '接触前' }],
  ['2. 接触後失注', { code: 'contact', label: '接触後' }],
  ['3. 提案後失注', { code: 'proposal', label: '提案後' }],
  ['4. 面談後失注', { code: 'interview', label: '面談後' }],
]);
const SIDES = new Map([
  ['案件側', { code: 'job', label: '案件側' }], ['人材側', { code: 'talent', label: '人材側' }],
  ['双方', { code: 'both', label: '双方' }], ['外部要因', { code: 'external', label: '外部要因' }],
]);
const UNKNOWN = Object.freeze({ code: 'unknown', label: '未確認' });
const INTERVIEW_FAILURE = new Set(['面談不合格', '面談で不合格', '面談結果：不合格', '面談結果:不合格', '不合格']);
const text = (value, max = 200) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';
// Identity comparisons use the complete trimmed value. Display limits must never
// merge two long legal names which differ after the visible prefix.
const fullName = value => typeof value === 'string' ? value.trim() : '';
const id = value => UUID.test(text(value, 40)) ? text(value, 40).toLowerCase() : null;
const list = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const searchText = value => text(value, 2000).normalize('NFKC').toLocaleLowerCase('ja-JP');
const percent = (numerator, denominator) => denominator ? Math.round(numerator / denominator * 1000) / 10 : null;
const ms = value => value ? Date.parse(value) : -Infinity;

function error(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function day(value) {
  const valueText = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText)) return null;
  const date = new Date(valueText + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === valueText ? valueText : null;
}

function instant(value) {
  const valueText = text(value, 60);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(valueText)
    || !day(valueText.slice(0, 10))) return null;
  const valueMs = Date.parse(valueText);
  return Number.isFinite(valueMs) ? new Date(valueMs).toISOString() : null;
}

function meetingDate(date, time) {
  const value = day(date);
  if (!value) return null;
  const clock = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(text(time, 8)) ? text(time, 8) : '00:00';
  return instant(value + 'T' + clock + '+09:00');
}

function byId(rows) {
  const result = new Map();
  for (const row of list(rows)) {
    const key = id(row.id);
    if (!key) continue;
    const previous = result.get(key);
    if (!previous || ms(instant(row.updated_at || row.created_at)) > ms(instant(previous.updated_at || previous.created_at))) {
      result.set(key, row);
    }
  }
  return result;
}

function group(rows, keyFor) {
  const result = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
}

function withinScope(row, tenantId) {
  return !tenantId || !row.tenant_id || id(row.tenant_id) === tenantId;
}

function strictStageEvents(rows, now) {
  const result = [];
  const seen = new Set();
  for (const row of list(rows)) {
    // Only the known audit event format is accepted. A note mentioning 合格 is
    // neither a stage transition nor an interview outcome.
    if (row.action !== 'ステージ変更' || row.target_type !== 'proposal') continue;
    const proposalId = id(row.target_id), at = instant(row.created_at);
    if (!proposalId || !at || ms(at) > ms(now)) continue;
    let detail;
    try { detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail; } catch { continue; }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail) || typeof detail.to !== 'string') continue;
    const to = text(detail.to, 40), from = text(detail.from, 40) || null;
    if (!new Set([...ACTIVE_STAGES, ...LOSS_STAGES, '合格', '稼働']).has(to)) continue;
    const eventKey = id(row.id) || [proposalId, from, to, at].join(':');
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    result.push({ key: eventKey, proposalId, from, to, at });
  }
  return group(result, row => row.proposalId);
}

function companyResolver({ engerCompanies, salesCompanies, companyLinks, confirmedHistoryLinks, tenantId }) {
  const enger = byId(engerCompanies), sales = byId(salesCompanies);
  const names = group([...enger.entries()].filter(([, row]) => !row.deleted_at), ([, row]) => fullName(row.name));
  const links = group(list(companyLinks).filter(row => withinScope(row, tenantId) && row.source_system === 'enger'
    && id(row.source_company_id) && id(row.company_id)), row => id(row.company_id));
  const verified = group(list(confirmedHistoryLinks).filter(row => withinScope(row, tenantId)
    && ['proposal', 'job'].includes(row.entity_type) && id(row.company_id) && id(row.entity_id)),
  row => row.entity_type + ':' + id(row.entity_id));
  const known = (engerId, salesId, fallback, kind = 'id') => ({
    key: engerId ? 'enger:' + engerId : 'sales:' + salesId,
    name: text(enger.get(engerId)?.name || sales.get(salesId)?.name || fallback) || '企業名未登録',
    engerCompanyId: engerId, salesCompanyId: salesId,
    identity: { kind, label: kind === 'name' ? '企業名の完全一致' : '企業IDで確認' },
  });
  return (source, sale, proposalKey) => {
    const completeName = fullName(source?.company) || fullName(sale?.company_name);
    const name = text(completeName) || '企業名未登録';
    const salesId = id(sale?.company_id);
    if (id(source?.company_id)) return known(id(source.company_id), salesId, name);
    const confirmed = [...(verified.get('proposal:' + id(source?.id)) || []), ...(verified.get('job:' + id(source?.job_id)) || [])];
    const confirmedIds = [...new Set(confirmed.map(row => id(row.company_id)))];
    if (confirmedIds.length === 1) return known(confirmedIds[0], salesId, name);
    if (confirmedIds.length > 1) return { key: 'ambiguous:' + proposalKey, name, salesCompanyId: salesId, engerCompanyId: null,
      identity: { kind: 'ambiguous', label: '企業の紐付けを確認' } };
    if (sale?.source_system === 'enger' && id(sale.source_company_id)) return known(id(sale.source_company_id), salesId, name);
    if (salesId) {
      const candidates = [...new Set((links.get(salesId) || []).map(row => id(row.source_company_id)))];
      if (candidates.length === 1) return known(candidates[0], salesId, name);
      // Distinct explicit IDs must not be merged because their names happen to match.
      const result = known(null, salesId, name);
      if (candidates.length > 1) result.identity = { kind: 'ambiguous', label: 'ENGER企業の紐付けを確認' };
      return result;
    }
    const matches = names.get(completeName) || [];
    if (matches.length === 1) return known(matches[0][0], null, name, 'name');
    if (matches.length > 1) return { key: 'ambiguous:' + proposalKey, name, salesCompanyId: null, engerCompanyId: null,
      identity: { kind: 'ambiguous', label: '同名企業が複数・未確認' } };
    return { key: !completeName ? 'missing:' + proposalKey : 'unlinked:' + hash(completeName), name,
      salesCompanyId: null, engerCompanyId: null, identity: { kind: 'missing', label: '企業の紐付け未確認' } };
  };
}

const activityLabel = row => ({ sent: row.result === 'resent' ? '提案を再送' : '提案を送付',
  reply: '回答を記録', call: '電話対応', mail: 'メール対応', meeting: row.result === 'done' ? '面談を実施'
    : row.result === 'canceled' ? '面談予定を取消' : '面談の記録', result: '結果を記録',
  memo: 'メモを記録', handoff: '担当へ引継ぎ', assign: '担当を変更', decision: '対応方針を記録' })[row.kind] || '対応を記録';
const outcomeLabel = value => ({ passed: '合格', failed: '不合格', considering: '検討中', declined: '見送り',
  connected: '会話できた', no_answer: '不在・未応答', callback: '折返し待ち', meeting: '面談の相談',
  scheduled: '日程設定', done: '実施済み', canceled: '予定取消', won: '成約', lost: '失注',
  stopped: '連絡停止', reproposal: '再提案', closed_no_reply: '無回答で終了', ...CLOSE_REASON })[value] || '';

/** Build normalized immutable facts once; selection and aggregation do no I/O. */
export function buildCompanyAnalysis({ engerProposals = [], salesProposals = [], activities = [], latestResults = [],
  stageHistory = [], companyLinks = [], confirmedHistoryLinks = [], emailRounds = [], emailReactions = [],
  engerCompanies = [], salesCompanies = [], employees = [], engerAvailable = true, now = new Date().toISOString(),
  tenantId = null, complete = true } = {}) {
  const observedAt = instant(now);
  if (!observedAt) throw error('bad_now', '集計日時を確認できません。', 500);
  if (!complete) throw error('analysis_incomplete', '企業分析のデータを最後まで取得できませんでした。', 503);
  if (tenantId !== null && !id(tenantId)) throw error('analysis_scope', '企業分析の対象を確認できません。', 500);
  const tenants = new Set([...list(salesProposals), ...list(companyLinks)].map(row => id(row.tenant_id)).filter(Boolean));
  const scope = id(tenantId) || (tenants.size === 1 ? [...tenants][0] : null);
  if (!scope && tenants.size > 1) throw error('analysis_scope', '企業分析の対象を確認できません。', 500);
  const sourceRows = byId(engerAvailable ? engerProposals : []);
  const saleRows = [...byId(salesProposals).values()].filter(row => withinScope(row, scope));
  const sourceSales = group(saleRows, row => row.source_system === 'enger' && id(row.source_proposal_id)
    ? 'enger:' + id(row.source_proposal_id) : 'sales:' + id(row.id));
  const keys = new Set([...sourceRows.keys()].map(key => 'enger:' + key));
  for (const key of sourceSales.keys()) keys.add(key);
  const actMap = group(list(activities).filter(row => withinScope(row, scope)), row => id(row.proposal_id));
  const resultMap = group(list(latestResults).filter(row => withinScope(row, scope)), row => id(row.proposal_id));
  const stageMap = strictStageEvents(stageHistory, observedAt);
  const roundMap = group(list(emailRounds), row => id(row.proposal_id));
  const reactionMap = group(list(emailReactions), row => id(row.proposal_id));
  const employeeMap = byId(employees);
  const resolveCompany = companyResolver({ engerCompanies, salesCompanies, companyLinks, confirmedHistoryLinks, tenantId: scope });
  const validPast = value => { const at = instant(value); return at && ms(at) <= ms(observedAt) ? at : null; };
  const rows = [], notes = [];
  let missingSource = 0, unparsedStageEvents = 0;
  for (const key of [...keys].sort()) {
    const sourceId = key.startsWith('enger:') ? key.slice(6) : null;
    const source = sourceRows.get(sourceId) || null;
    if (source?.deleted_at) continue;
    const sales = (sourceSales.get(key) || []).slice().sort((a, b) => Number(Boolean(a.archived_at)) - Number(Boolean(b.archived_at))
      || ms(instant(b.updated_at || b.created_at)) - ms(instant(a.updated_at || a.created_at)) || a.id.localeCompare(b.id));
    const sale = sales[0] || null;
    if (!source && !sale) continue;
    const sourceMissing = Boolean(sourceId && !source);
    if (sourceMissing && engerAvailable) missingSource++;
    const company = resolveCompany(source, sale, key);
    const proposalActs = sales.flatMap(item => actMap.get(id(item.id)) || []).filter(row => validPast(row.occurred_at || row.created_at));
    const stageEvents = stageMap.get(sourceId) || [];
    const lastReopen = stageEvents.filter(event => (LOSS_STAGES.has(event.from) || ['合格', '稼働'].includes(event.from))
      && ACTIVE_STAGES.has(event.to)).sort((a, b) => ms(b.at) - ms(a.at))[0]?.at || null;
    const currentCycle = at => !lastReopen || (at && ms(at) >= ms(lastReopen));
    const sourceStage = text(source?.stage, 40);
    const isLost = source ? LOSS_STAGES.has(sourceStage) : !sourceMissing && sale?.status === 'lost';
    const phase = PHASES.get(text(source?.lost_phase, 80)) || UNKNOWN;
    const side = SIDES.get(text(source?.dx2_lost_side, 40)) || UNKNOWN;
    const category = text(source?.lost_reason_category, 100);
    const reason = category || text(source?.lost_reason, 200) || (!sourceId ? CLOSE_REASON[sale?.close_reason] : '') || '';
    const lossDetail = [...new Set([text(source?.lost_detail_reason, 400), text(source?.lost_reason_note, 600)].filter(Boolean))].join('\n');
    const sourceAt = validPast(source?.stage_updated_at || source?.updated_at || source?.created_at);
    // dx2_email_sent records confirmed SMTP sends even when opens_round=false:
    // an answer received during SMTP must remain current without losing the send evidence.
    const sends = [source?.mail_sent_at, ...sales.map(row => row.sent_at),
      ...proposalActs.filter(row => row.kind === 'sent' && ['sent', 'resent'].includes(row.result)).map(row => row.occurred_at),
      ...(roundMap.get(sourceId) || []).filter(row => row.side === 'job').map(row => row.sent_at)]
      .map(validPast).filter(Boolean).sort((a, b) => ms(a) - ms(b));
    const sentAt = sends[0] || null;
    const resultFacts = [];
    const addResult = (value, at, priority) => {
      if (['passed', 'failed'].includes(value) && currentCycle(at)) resultFacts.push({ value, at, priority });
    };
    for (const event of stageEvents) if (event.to === '合格') addResult('passed', event.at, 1);
    for (const activity of proposalActs) if (['result', 'meeting'].includes(activity.kind)) {
      addResult(activity.result, validPast(activity.occurred_at || activity.created_at), 1);
    }
    const latest = sales.flatMap(row => resultMap.get(id(row.id)) || []).slice().sort((a, b) => (b.revision || 0) - (a.revision || 0)
      || ms(instant(b.created_at)) - ms(instant(a.created_at)))[0];
    if (latest) addResult(latest.interview_result || latest.facts?.interviewResult,
      validPast(latest.created_at || latest.updated_at), 2);
    // Source current outcomes take precedence over stale Sales snapshots.
    if (sourceStage === '合格') addResult('passed', sourceAt || lastReopen, 4);
    if (isLost && phase.code === 'interview' && side.code === 'job'
      && [source?.lost_reason, source?.lost_detail_reason].some(value => INTERVIEW_FAILURE.has(text(value)))) {
      addResult('failed', sourceAt || lastReopen, 4);
    }
    resultFacts.sort((a, b) => (a.priority === 4 || b.priority === 4 ? b.priority - a.priority : 0)
      || (a.at && b.at ? ms(b.at) - ms(a.at) : 0) || b.priority - a.priority || ms(b.at) - ms(a.at));
    const interviewResult = resultFacts[0]?.value || null;
    const historicalPass = sourceStage === '合格' || stageEvents.some(event => event.to === '合格')
      || proposalActs.some(row => ['result', 'meeting'].includes(row.kind) && row.result === 'passed')
      || (!sourceMissing && latest && (latest.interview_result || latest.facts?.interviewResult) === 'passed');
    const historicalWon = sourceStage === '稼働' || stageEvents.some(event => event.to === '稼働')
      || (!sourceId && sale?.status === 'won');
    const heldDates = proposalActs.filter(row => row.kind === 'meeting' && ['done', 'held', 'completed'].includes(row.result))
      .map(row => validPast(row.occurred_at || row.created_at)).filter(Boolean);
    const actualHeldAt = heldDates.filter(currentCycle).sort((a,b) => ms(a)-ms(b))[0] || null;
    if (isLost && phase.code === 'interview' && sourceAt) heldDates.push(sourceAt);
    if (!sourceId && sale?.status === 'meeting_done') {
      const completedAt = validPast(sale.updated_at || sale.meeting_at || sale.created_at);
      if (completedAt) heldDates.push(completedAt);
    }
    for (const fact of resultFacts) if (fact.at) heldDates.push(fact.at);
    const held = heldDates.length > 0 || Boolean(interviewResult) || Boolean(historicalPass);
    const performedAt = heldDates.filter(currentCycle).sort((a, b) => ms(a) - ms(b))[0] || null;
    const currentSend = sends.find(currentCycle) || null;
    const currentHeld = Boolean(interviewResult) || heldDates.some(currentCycle);
    const schedules = [meetingDate(source?.meeting_date, source?.meeting_time), meetingDate(source?.meeting_date_2, source?.meeting_time_2),
      ...sales.map(row => instant(row.meeting_at))].filter(Boolean);
    const meetingActivity = proposalActs.filter(row => row.kind === 'meeting').sort((a, b) => ms(b.occurred_at || b.created_at) - ms(a.occurred_at || a.created_at))[0];
    const scheduled = Boolean(schedules.length || meetingActivity?.result === 'scheduled') && meetingActivity?.result !== 'canceled';
    const active = source ? ACTIVE_STAGES.has(sourceStage) : !sourceMissing && !sale?.archived_at && !CLOSED_SALES.has(sale?.status);
    const ownerId = id(sale?.sales_owner_id);
    const ownerName = text(employeeMap.get(ownerId)?.display_name || employeeMap.get(ownerId)?.name || source?.owner || source?.proposer) || '担当未登録';
    const service = text(source ? source.business_category : (sourceMissing ? '' : sale?.service), 100) || 'unknown';
    const interactions = [];
    const addInteraction = (eventKey, at, label, detail = '') => {
      if (!at) return;
      interactions.push({ key: eventKey, at, label, detail: text(detail, 600), sourceProposalId: sourceId, salesProposalId: id(sale?.id) });
    };
    for (const event of stageEvents) addInteraction('stage:' + event.key, event.at, 'ENGERのステージ変更',
      [event.from || '新規', event.to].join(' → '));
    const eventKeys = new Set();
    for (const activity of proposalActs) {
      const eventKey = text(activity.source_event, 120) || id(activity.id) || hash(JSON.stringify([
        activity.proposal_id, activity.kind, activity.result, activity.outcome, activity.occurred_at]));
      if (eventKeys.has(eventKey)) continue;
      eventKeys.add(eventKey);
      addInteraction('sales:' + eventKey, validPast(activity.occurred_at || activity.created_at), activityLabel(activity),
        [...new Set([outcomeLabel(activity.result), outcomeLabel(activity.outcome)].filter(Boolean))].join('・'));
    }
    for (const reaction of reactionMap.get(sourceId) || []) {
      const at = validPast(reaction.answered_at || reaction.recorded_at);
      if (!['job', 'cand'].includes(reaction.side) || !['proceed', 'pass'].includes(reaction.result)) continue;
      addInteraction('reaction:' + (id(reaction.id) || hash(JSON.stringify([sourceId, reaction.side, at, reaction.result]))), at,
        (reaction.side === 'job' ? '案件側' : '人材側') + 'が回答',
        (reaction.result === 'proceed' ? '興味あり' : '見送り') + (reaction.reason_label ? '：' + text(reaction.reason_label, 200) : ''));
    }
    if (sentAt && !interactions.some(item => item.label === '提案を送付' && item.at === sentAt)) {
      addInteraction('sent:' + key, sentAt, '提案を送付');
    }
    if (source && sourceAt) addInteraction('source:' + key, sourceAt,
      !validPast(source.stage_updated_at) ? 'ENGERの現在状態（記録更新）'
        : isLost ? 'ENGERで' + sourceStage : sourceStage === '合格' ? 'ENGERで合格を確認'
          : sourceStage === '稼働' ? 'ENGERで稼働を確認' : 'ENGERの提案情報',
      isLost ? [sourceStage, phase.label, side.label, reason || '理由未確認'].join(' / ') : sourceStage);
    const last = interactions.slice().sort((a, b) => ms(b.at) - ms(a.at) || a.key.localeCompare(b.key))[0]
      || { at: validPast(source?.created_at || sale?.created_at), label: '提案を登録' };
    rows.push({ key, sourceProposalId: sourceId, salesProposalId: id(sale?.id), company,
      companyName: company.name, jobTitle: text(source?.job_title || sale?.job_title || sale?.title) || '案件名未登録',
      talentName: text(source?.candidate_name || sale?.talent_initials, 100) || '人材名未登録',
      flow: proposalFlow({ source: source || {}, sale: sale || {}, activities: proposalActs, sentAt: currentSend, interviewResult, currentHeld, reopenedAt: lastReopen,
        answers: currentAnswers(roundMap.get(sourceId) || [], reactionMap.get(sourceId) || [], lastReopen, observedAt) }),
      sentAt, proposedAt: day(source?.proposed_at), currentStage: source ? sourceStage || '未確認'
        : sourceMissing ? 'ENGERの現在状態を確認できません' : SALES_STAGE[sale?.status] || '未確認',
      meetingLabel: currentHeld ? '面談実施を確認' : scheduled ? '面談予定・実施未確認' : '実施記録なし',
      resultLabel: interviewResult === 'passed' ? '合格' : interviewResult === 'failed' ? '不合格'
        : currentHeld ? '合否未確認' : '合否記録なし',
      lossReason: reason || '未確認', lossPhase: phase.label, lossSide: side.label, lossDetail,
      lossCategory: category || null, lossPhaseRaw: text(source?.lost_phase, 80) || null,
      lossSideRaw: text(source?.dx2_lost_side, 40) || null,
      relatedConditions: Array.isArray(source?.lost_related_conditions) ? source.lost_related_conditions.map(value => text(value, 100)).filter(Boolean) : [],
      lossIsCurrent: isLost, ownerId, ownerName, service,
      href: sourceId ? 'https://dx.enger.jp/proposals/' + sourceId : id(sale?.id)
        ? 'https://gw.8grp.co.jp/sales/proposals.html?id=' + id(sale.id) : null,
      source: sourceId ? 'enger' : 'sales', unknownSent: !sentAt, sourceMissing,
      facts: { active, passed: Boolean(historicalPass), won: Boolean(historicalWon), lost: isLost,
        held, scheduled, interviewResult, resultDue: currentHeld, resultPending: currentHeld && !interviewResult,
        archived: Boolean(sale?.archived_at), phase, side, lastReopen, currentSend, performedAt, actualHeldAt,
        blast: source?.dx2_is_blast ?? null, jobId: id(source?.job_id),
        sentBy: id(proposalActs.find(a => a.kind === 'sent' && a.result === 'sent' && validPast(a.occurred_at) === currentSend)?.employee_id),
        cause: { code: category ? 'category:' + category : reason ? 'reason:' + reason : 'unknown', label: reason || '理由未確認' } },
      latest: last.at ? { at: last.at, label: last.label } : null, interactions,
    });
  }
  for (const row of list(stageHistory)) {
    if (row.action === 'ステージ変更' && row.target_type === 'proposal') {
      try { const parsed = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.to !== 'string') unparsedStageEvents++;
      } catch { unparsedStageEvents++; }
    }
  }
  if (!engerAvailable) notes.push('ENGERの履歴を取得していないため、合否に関する率は算出していません。');
  if (missingSource) notes.push('ENGERの元提案を確認できない履歴が' + missingSource + '件あります。現在の進捗は未確認です。');
  if (rows.some(row => row.unknownSent)) notes.push('送信確認日時がない過去の実績は履歴に表示し、送付期間の率には含めていません。');
  if (unparsedStageEvents) notes.push('旧形式のステージ履歴は合否の自動集計に使わず、確認できる現在の結果を表示しています。');
  if (rows.some(row => ['ambiguous', 'missing'].includes(row.company.identity.kind))) notes.push('企業の紐付けが未確認の履歴を含みます。同名企業を自動で統合していません。');
  return { rows, now: observedAt, engerAvailable: Boolean(engerAvailable), notes,
    filters: { services: [...new Set(rows.map(row => row.service))].sort((a, b) => a.localeCompare(b, 'ja')),
      owners: [...new Map(rows.filter(row => row.ownerId).map(row => [row.ownerId, { id: row.ownerId, name: row.ownerName }])).values()]
        .sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id)) } };
}

function counts(rows, key) {
  const result = new Map();
  for (const row of rows.filter(row => row.facts.lost)) {
    const value = row.facts[key];
    const previous = result.get(value.code) || { ...value, count: 0 };
    previous.count++;
    result.set(value.code, previous);
  }
  return [...result.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ja'));
}

function inCohort(row, period) {
  return Boolean(row.sentAt) && (period.key === 'all'
    || (ms(row.sentAt) >= ms(period.sinceIso) && ms(row.sentAt) < ms(period.untilIso)));
}

function publicProposal(row) {
  const { company, facts, interactions, latest, ownerId, ...proposal } = row;
  return { ...proposal, identity: { ...company.identity } };
}

function summarizeCompany(rows, period, available, now, allCompanyRows) {
  const baseIdentity = rows.find(row => row.company.identity.kind === 'id')?.company || rows[0].company;
  const basisCounts = { id: 0, name: 0, ambiguous: 0, missing: 0 };
  for (const row of rows) basisCounts[row.company.identity.kind]++;
  const identity = { ...baseIdentity, identity: { ...baseIdentity.identity, basisCounts } };
  if (basisCounts.name) identity.identity = { kind: 'name', basisCounts,
    label: basisCounts.id ? '一部の履歴を企業名の完全一致で照合' : '企業名の完全一致' };
  const cohort = rows.filter(row => inCohort(row, period));
  const count = (items, predicate) => items.filter(predicate).length;
  const history = { total: rows.length, active: count(rows, row => row.facts.active), passed: count(rows, row => row.facts.passed),
    won: count(rows, row => row.facts.won), lost: count(rows, row => row.facts.lost), unknownSent: count(rows, row => row.unknownSent) };
  const metrics = { sent: cohort.length, meetings: count(cohort, row => row.facts.held), scheduled: count(cohort, row => row.facts.scheduled),
    passed: count(cohort, row => row.facts.interviewResult === 'passed'), failed: count(cohort, row => row.facts.interviewResult === 'failed'),
    resultKnown: count(cohort, row => Boolean(row.facts.interviewResult)), resultDue: count(cohort, row => row.facts.resultDue),
    resultPending: count(cohort, row => row.facts.resultPending) };
  metrics.meetingRate = available ? percent(metrics.meetings, metrics.sent) : null;
  metrics.passRate = available ? percent(metrics.passed, metrics.resultKnown) : null;
  metrics.resultCoverage = available ? percent(metrics.resultKnown, metrics.resultDue) : null;
  const latest = rows.map(row => row.latest).filter(Boolean).sort((a, b) => ms(b.at) - ms(a.at) || a.label.localeCompare(b.label, 'ja'))[0] || null;
  const target = rows.find(row => row.facts.resultPending) || rows.find(row => row.facts.lost && row.facts.cause.code === 'unknown')
    || rows.find(row => row.facts.lost) || rows.find(row => row.facts.active) || rows[0];
  const destination = target?.sourceProposalId ? 'ENGER' : 'Sales';
  const next = target ? { label: target.facts.resultPending ? destination + 'で面談結果を確認'
    : target.facts.lost ? destination + 'で見送り理由を確認' : target.facts.active ? destination + 'で提案の進捗を確認' : destination + 'の過去実績を確認',
    detail: target.facts.resultPending ? '合否が未記録の面談があります。'
      : target.facts.lost ? [target.lossPhase, target.lossSide, target.lossReason].join(' / ') : target.currentStage,
    sourceProposalId: target.sourceProposalId, salesProposalId: target.salesProposalId } : null;
  return { ...identity, history, metrics, improvement: { ...improvementSignal(allCompanyRows, now), status: rows[0].facts.improvementStatus || null }, tradeGrade: rows[0].facts.tradeGrade || null, latestFlow: rows.slice().sort((a,b)=>ms(b.latest?.at)-ms(a.latest?.at))[0]?.flow || null, causes: counts(rows, 'cause'), phases: counts(rows, 'phase'),
    sides: counts(rows, 'side'), latest, next };
}

function positiveInteger(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw error('bad_filter', 'ページの指定が正しくありません。');
  }
  return Number(value);
}

/** Select company groups while keeping all-time history separate from a sent cohort. */
export function selectCompanyAnalysis(model, { period: periodKey = 'all', from, to, q = '', service = 'all', owner = 'all',
  focus = 'all', sort = 'recent', company = null, page = 1, pageSize = 20 } = {}) {
  if (!PERIODS.has(periodKey) || !FOCUSES.has(focus) || !SORTS.has(sort)
    || typeof q !== 'string' || q.length > 200 || typeof service !== 'string' || typeof owner !== 'string'
    || (service !== 'all' && !model.filters.services.includes(service))
    || (!['all', 'none'].includes(owner) && !id(owner))) {
    throw error('bad_filter', '絞り込み条件を選び直してください。');
  }
  if ((from || to) && periodKey !== 'custom') throw error('bad_filter', '期間指定には開始日と終了日を指定してください。');
  const period = resolveProposalPeriod(periodKey, { from, to }, new Date(model.now));
  if (period.error) throw error('bad_filter', period.hint);
  const selectedPage = positiveInteger(page, 1, 100000), selectedSize = positiveInteger(pageSize, 20, 50);
  if (company !== null && (typeof company !== 'string' || !company.length || company.length > 240)) {
    throw error('bad_filter', '企業の指定が正しくありません。');
  }
  const needle = searchText(q);
  const ownerId = id(owner);
  const rows = model.rows.filter(row => (!needle || searchText([row.companyName, row.jobTitle, row.talentName].join(' ')).includes(needle))
    && (service === 'all' || row.service === service) && (owner === 'all' || (owner === 'none' ? !row.ownerId : row.ownerId === ownerId)));
  const grouped = group(rows, row => row.company.key);
  const allCompanies = group(model.rows, row => row.company.key);
  let companies = [...grouped.values()].map(items => summarizeCompany(items, period, model.engerAvailable, model.now, allCompanies.get(items[0].company.key)));
  companies = companies.filter(item => focus === 'all' || (focus === 'passed' ? item.history.passed > 0 || item.history.won > 0
    : focus === 'improvement' ? item.improvement.suggested : focus === 'loss' ? item.history.lost > 0 : focus === 'waiting' ? item.metrics.resultPending > 0 || item.history.active > 0
      : ['ambiguous', 'missing'].includes(item.identity.kind)));
  const comparison = (a, b) => sort === 'company' ? a.name.localeCompare(b.name, 'ja')
    : sort === 'sent' ? b.metrics.sent - a.metrics.sent : sort === 'meeting' ? b.metrics.meetings - a.metrics.meetings
      : sort === 'passed' ? b.history.passed - a.history.passed || b.history.won - a.history.won
        : ms(b.latest?.at) - ms(a.latest?.at);
  companies.sort((a, b) => comparison(a, b) || a.name.localeCompare(b.name, 'ja') || a.key.localeCompare(b.key));
  const summary = { companies: companies.length, proposals: 0, sent: 0, meetings: 0, passed: 0, won: 0, lost: 0, resultPending: 0, unknownSent: 0 };
  for (const item of companies) {
    summary.proposals += item.history.total;
    for (const key of ['passed', 'won', 'lost', 'unknownSent']) summary[key] += item.history[key];
    for (const key of ['sent', 'meetings', 'resultPending']) summary[key] += item.metrics[key];
  }
  let selectedCompany = null;
  const notes = [...model.notes];
  if (company) {
    const found = companies.find(item => item.key === company);
    if (!found) throw error('company_not_found', 'この条件の企業履歴が見つかりません。', 404);
    const companyRows = [...grouped.get(company)].sort((a, b) => ms(b.latest?.at) - ms(a.latest?.at) || a.key.localeCompare(b.key));
    const interactions = [...new Map(companyRows.flatMap(row => row.interactions).map(row => [row.key, row])).values()]
      .sort((a, b) => ms(b.at) - ms(a.at) || a.key.localeCompare(b.key));
    selectedCompany = { ...found, proposals: companyRows.slice((selectedPage - 1) * selectedSize, selectedPage * selectedSize).map(publicProposal),
      interactions: interactions.slice(0, 30), interactionsTotal: interactions.length, interactionsLimited: interactions.length > 30,
      detailPagination: { page: selectedPage, pageSize: selectedSize, total: companyRows.length, pages: Math.ceil(companyRows.length / selectedSize) } };
    if (interactions.length > 30) notes.push('最近の履歴は新しい順に30件を表示しています。各提案の全履歴はENGERで確認できます。');
  }
  return { companies: companies.slice((selectedPage - 1) * selectedSize, selectedPage * selectedSize), summary,
    filters: model.filters, period: { key: period.key, label: period.label, from: period.from, to: period.to },
    pagination: { page: selectedPage, pageSize: selectedSize, total: companies.length, pages: Math.ceil(companies.length / selectedSize) },
    dataStatus: { engerAvailable: model.engerAvailable, notes, observedAt: model.now }, company: selectedCompany };
}
