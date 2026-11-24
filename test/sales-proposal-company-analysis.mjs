import assert from 'node:assert/strict';
import { buildCompanyAnalysis, selectCompanyAnalysis } from '../lib/sales-proposal-company-analysis.js';

const uuid = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const NOW = '2026-11-24T12:00:00Z', TENANT = uuid(900), OTHER_TENANT = uuid(901), COMPANY = uuid(1000);
const at = '2026-11-20T02:00:00Z';
const source = (number = 1, extra = {}) => ({ id: uuid(number), company: '株式会社テスト', stage: '提案中',
  job_title: '業務システム開発', candidate_name: 'T.K', created_at: at, updated_at: at, ...extra });
const sale = (number = 1, extra = {}) => ({ id: uuid(100 + number), tenant_id: TENANT, source_system: 'enger',
  source_proposal_id: uuid(number), company_name: '株式会社テスト', status: 'reply_wait', created_at: at, updated_at: at, ...extra });
const activity = (number = 1, extra = {}) => ({ id: uuid(300 + number), tenant_id: TENANT, proposal_id: uuid(101),
  kind: 'meeting', result: 'done', occurred_at: '2026-11-21T02:00:00Z', created_at: '2026-11-21T02:00:00Z', ...extra });
const stage = (number = 1, extra = {}) => ({ id: uuid(400 + number), action: 'ステージ変更', target_type: 'proposal',
  target_id: uuid(1), created_at: '2026-11-21T02:00:00Z', detail: JSON.stringify({ from: '面談', to: '合格' }), ...extra });
const base = extra => ({ now: NOW, tenantId: TENANT, engerCompanies: [{ id: COMPANY, name: '株式会社テスト' }], ...extra });
const model = extra => buildCompanyAnalysis(base(extra));
const selection = (extra, query = {}) => selectCompanyAnalysis(model(extra), query);
const detail = extra => { const built = model(extra); const first = selectCompanyAnalysis(built).companies[0];
  return selectCompanyAnalysis(built, { company: first.key }).company; };
let tested = 0;
function test(name, run) { run(); tested++; console.log('✓ ' + name); }
function frozen(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) frozen(child); }
  return value;
}

test('ENGER-only historical passes and active work remain visible without invented sent dates', () => {
  const result = selection({ engerProposals: [source(1, { stage: '合格' }), source(2, { stage: '合格' }), source(3, { stage: '稼働' })] });
  assert.equal(result.summary.proposals, 3);
  assert.equal(result.summary.passed, 2);
  assert.equal(result.summary.won, 1);
  assert.equal(result.summary.unknownSent, 3);
  assert.equal(result.summary.sent, 0);
  assert.equal(result.companies[0].metrics.passRate, null);
  assert.equal(result.companies[0].metrics.meetingRate, null);
  assert.equal(result.companies[0].history.active, 0);
});

test('source IDs deduplicate ENGER, repeated Sales imports and resend activities without mutating inputs', () => {
  const input = frozen(base({ engerProposals: [source()], salesProposals: [sale(1, { sent_at: at }),
    sale(1, { id: uuid(102), sent_at: '2026-11-22T00:00:00Z' })], activities: [activity(1, {
      kind: 'sent', result: 'resent', source_event: 'same-event', occurred_at: '2026-11-22T00:00:00Z' }),
    activity(2, { kind: 'sent', result: 'resent', source_event: 'same-event', occurred_at: '2026-11-22T00:00:00Z' })] }));
  const before = JSON.stringify(input), built = buildCompanyAnalysis(input), result = selectCompanyAnalysis(built);
  assert.equal(result.summary.proposals, 1);
  assert.equal(result.summary.sent, 1);
  assert.equal(built.rows[0].sentAt, new Date(at).toISOString());
  const company = selectCompanyAnalysis(built, { company: result.companies[0].key }).company;
  assert.equal(company.interactions.filter(row => row.key === 'sales:same-event').length, 1);
  assert.equal(JSON.stringify(input), before);
});

test('current ENGER loss replaces stale Sales open status and retains source loss evidence', () => {
  const input = { engerProposals: [source(1, { stage: '失注', lost_phase: '3. 提案後失注',
    lost_reason_category: 'スキル・経験アンマッチ', lost_reason: 'スキル不足', dx2_lost_side: '案件側',
    lost_detail_reason: '実務経験の確認', lost_reason_note: '次回は経験年数を確認', lost_related_conditions: ['必須スキル'] })],
  salesProposals: [sale(1, { sent_at: at, status: 'considering' })] };
  const company = detail(input);
  assert.equal(company.history.active, 0);
  assert.equal(company.history.lost, 1);
  assert.equal(company.metrics.failed, 0, 'proposal loss is not an interview failure');
  assert.equal(company.metrics.resultKnown, 0);
  assert.deepEqual(company.phases, [{ code: 'proposal', label: '提案後', count: 1 }]);
  assert.equal(company.sides[0].code, 'job');
  assert.equal(company.proposals[0].lossReason, 'スキル・経験アンマッチ');
  assert.equal(company.proposals[0].lossPhaseRaw, '3. 提案後失注');
  assert.deepEqual(company.proposals[0].relatedConditions, ['必須スキル']);
  assert.match(company.proposals[0].lossDetail, /実務経験/);
  assert.equal(company.proposals[0].href, 'https://dx.enger.jp/proposals/' + uuid(1));
});

test('missing ENGER loss reason is not filled from a stale Sales close reason', () => {
  const company = detail({ engerProposals: [source(1, { stage: '失注' })],
    salesProposals: [sale(1, { status: 'lost', close_reason: 'client_declined', sent_at: at })] });
  assert.equal(company.proposals[0].lossReason, '未確認');
  assert.deepEqual(company.causes, [{ code: 'unknown', label: '理由未確認', count: 1 }]);
  assert.equal(company.metrics.failed, 0);
});

test('no reply, cancellation and an interview-stage hint do not become failed interviews', () => {
  const result = selection({ engerProposals: [source(1, { stage: '失注', lost_reason_category: '連絡不通',
    pre_lost_stage: '面談' })], salesProposals: [sale(1, { sent_at: at, status: 'closed_no_reply', close_reason: 'no_reply' })],
  activities: [activity(1, { result: 'canceled' })] });
  assert.equal(result.companies[0].metrics.failed, 0);
  assert.equal(result.companies[0].metrics.resultDue, 0);
  assert.equal(result.companies[0].metrics.passRate, null);
  assert.equal(result.companies[0].phases[0].code, 'unknown');
});

test('proposed_at and candidate-side sending never substitute for confirmed company-side sending', () => {
  const input = { engerProposals: [source(1, { stage: '合格', proposed_at: '2026-11-20' })],
    emailRounds: [{ id: uuid(500), proposal_id: uuid(1), side: 'cand', sent_at: at, opens_round: true }] };
  assert.equal(selection(input).summary.sent, 0);
  const actual = selection({ ...input, emailRounds: [...input.emailRounds,
    { id: uuid(501), proposal_id: uuid(1), side: 'job', sent_at: at, opens_round: true }] });
  assert.equal(actual.summary.sent, 1);
  assert.equal(actual.companies[0].metrics.passed, 1);
  assert.equal(actual.companies[0].metrics.passRate, 100);
});

test('confirmed company-side SMTP sending remains evidence when an answer prevents opening a new round', () => {
  const result = selection({ engerProposals: [source()], emailRounds: [
    { id: uuid(501), proposal_id: uuid(1), side: 'job', sent_at: at, opens_round: false }
  ] });
  assert.equal(result.summary.sent, 1);
  assert.equal(result.summary.unknownSent, 0);
  assert.equal(result.companies[0].metrics.resultKnown, 0);
});

test('record update timestamps show current state without claiming a dated outcome event', () => {
  const company = detail({ engerProposals: [source(1, { stage: '合格' }), source(2, { stage: '失注' }),
    source(3, { stage: '合格', stage_updated_at: '2026-11-21T02:00:00Z' })] });
  const snapshot = number => company.interactions.find(row => row.key === 'source:enger:' + uuid(number));
  assert.equal(snapshot(1).label, 'ENGERの現在状態（記録更新）');
  assert.equal(snapshot(1).detail, '合格');
  assert.equal(snapshot(2).label, 'ENGERの現在状態（記録更新）');
  assert.match(snapshot(2).detail, /^失注/);
  assert.equal(snapshot(3).label, 'ENGERで合格を確認');
  assert.equal(company.history.passed, 2);
});

test('email reaction pass means 見送り, never interview success or failure', () => {
  const company = detail({ engerProposals: [source()], salesProposals: [sale(1, { sent_at: at })],
    emailReactions: [{ id: uuid(510), proposal_id: uuid(1), side: 'job', result: 'pass', answered_at: at, reason_label: '条件の確認' },
      { id: uuid(511), proposal_id: uuid(1), side: 'cand', result: 'proceed', answered_at: at }] });
  assert.equal(company.history.passed, 0);
  assert.equal(company.history.lost, 0, 'response and canonical workflow outcome stay separate');
  assert.equal(company.metrics.failed, 0);
  assert.equal(company.metrics.resultKnown, 0);
  assert.equal(company.interactions.filter(row => row.label === '案件側が回答')[0].detail, '見送り：条件の確認');
});

test('scheduled interviews, including past dates, are not assumed held or result due', () => {
  const result = selection({ engerProposals: [source(1, { meeting_date: '2026-11-26', meeting_status: '日程確定' }),
    source(2, { meeting_date: '2026-11-10', meeting_status: '日程確定' })], salesProposals: [sale(1, { sent_at: at }), sale(2, { sent_at: at })],
  activities: [activity(1, { result: 'scheduled' })] });
  const metrics = result.companies[0].metrics;
  assert.equal(metrics.sent, 2);
  assert.equal(metrics.scheduled, 2);
  assert.equal(metrics.meetings, 0);
  assert.equal(metrics.resultDue, 0);
  assert.equal(metrics.resultPending, 0);
  assert.equal(metrics.resultCoverage, null);
});

test('explicit meeting completion creates a result-recovery task without inventing failure', () => {
  const company = detail({ engerProposals: [source()], salesProposals: [sale(1, { sent_at: at })], activities: [activity()] });
  assert.equal(company.metrics.meetings, 1);
  assert.equal(company.metrics.resultDue, 1);
  assert.equal(company.metrics.resultPending, 1);
  assert.equal(company.metrics.resultCoverage, 0);
  assert.equal(company.metrics.passRate, null);
  assert.equal(company.next.label, 'ENGERで面談結果を確認');
});

test('post-interview loss proves a held meeting but alone does not prove interview failure', () => {
  const company = detail({ engerProposals: [source(1, { stage: '失注', lost_phase: '4. 面談後失注',
    dx2_lost_side: '人材側', lost_reason_category: '単価・条件アンマッチ' })], salesProposals: [sale(1, { sent_at: at })] });
  assert.equal(company.metrics.meetings, 1);
  assert.equal(company.metrics.failed, 0);
  assert.equal(company.metrics.resultPending, 1);
});

test('only explicit company-side post-interview failure counts as failed', () => {
  const result = selection({ engerProposals: [source(1, { stage: '失注', lost_phase: '4. 面談後失注',
    dx2_lost_side: '案件側', lost_reason: '面談不合格' })], salesProposals: [sale(1, { sent_at: at })] });
  assert.equal(result.companies[0].metrics.failed, 1);
  assert.equal(result.companies[0].metrics.passRate, 0);
  assert.equal(result.companies[0].metrics.resultCoverage, 100);
});

test('latest explicit interview assessment supplies the result and overrides older revisions', () => {
  const result = selection({ engerProposals: [source(1, { stage: '面談' })], salesProposals: [sale(1, { sent_at: at })],
    latestResults: [{ proposal_id: uuid(101), revision: 1, created_at: '2026-11-21T03:00:00Z', interview_result: 'passed' },
      { proposal_id: uuid(101), revision: 2, created_at: '2026-11-22T03:00:00Z', interview_result: 'failed' }] });
  assert.equal(result.companies[0].metrics.failed, 1);
  assert.equal(result.companies[0].metrics.passed, 0);
  assert.equal(result.companies[0].metrics.resultPending, 0);
});

test('current explicit ENGER pass is authoritative over stale Sales assessment', () => {
  const result = selection({ engerProposals: [source(1, { stage: '合格' })], salesProposals: [sale(1, { sent_at: at })],
    latestResults: [{ proposal_id: uuid(101), interview_result: 'failed' }] });
  assert.equal(result.companies[0].metrics.passed, 1);
  assert.equal(result.companies[0].metrics.failed, 0);
});

test('dated explicit results are chronological while a later correction wins', () => {
  const result = selection({ engerProposals: [source(1, { stage: '面談' })], salesProposals: [sale(1, { sent_at: at })],
    latestResults: [{ proposal_id: uuid(101), created_at: '2026-11-21T03:00:00Z', interview_result: 'failed' }],
    activities: [activity(1, { kind: 'result', result: 'passed', occurred_at: '2026-11-22T03:00:00Z' })] });
  assert.equal(result.companies[0].metrics.passed, 1);
  assert.equal(result.companies[0].metrics.failed, 0);
});

test('stage history parsing accepts structured transitions but never note substrings', () => {
  const result = selection({ engerProposals: [source(1, { stage: '失注' }), source(2, { stage: '失注' })],
    stageHistory: [stage(1), stage(2, { target_id: uuid(2), detail: '今回は合格できなかった。稼働時期が合わない。' }),
      stage(3, { target_id: uuid(2), detail: JSON.stringify({ to: '失注', note: '他社で合格・稼働' }) }),
      stage(4, { target_id: uuid(2), action: 'メモ: 連絡記録' })] });
  assert.equal(result.summary.passed, 1);
  assert.equal(result.summary.won, 0);
  assert.ok(result.dataStatus.notes.some(value => value.includes('旧形式')));
});

test('reopening preserves historical pass but does not reuse an undated old result or old loss', () => {
  const input = { engerProposals: [source(1, { stage: '提案中', lost_phase: '4. 面談後失注', lost_reason: '面談不合格', dx2_lost_side: '案件側' })],
    salesProposals: [sale(1, { sent_at: at, status: 'lost' })], stageHistory: [stage(1), stage(2, {
      created_at: '2026-11-23T02:00:00Z', detail: JSON.stringify({ from: '合格', to: '提案中' }) })],
    latestResults: [{ proposal_id: uuid(101), interview_result: 'failed' }] };
  const company = detail(input);
  assert.equal(company.history.passed, 1);
  assert.equal(company.history.active, 1);
  assert.equal(company.history.lost, 0);
  assert.equal(company.metrics.failed, 0);
  assert.equal(company.metrics.passed, 0);
  assert.equal(company.metrics.meetings, 1, 'the historical interview still happened');
  assert.equal(company.metrics.resultDue, 0, 'a new cycle has not yet held its interview');
  assert.equal(company.proposals[0].lossIsCurrent, false);
  assert.equal(company.proposals[0].lossReason, '面談不合格', 'retain old loss evidence without making it current');
});

test('a newly timestamped result after reopen is counted while the old assessment is not', () => {
  const input = { engerProposals: [source()], salesProposals: [sale(1, { sent_at: at })], stageHistory: [stage(1, {
    created_at: '2026-11-23T02:00:00Z', detail: JSON.stringify({ from: '失注', to: '提案中' }) })],
  latestResults: [{ proposal_id: uuid(101), created_at: '2026-11-21T03:00:00Z', interview_result: 'failed', revision: 1 }] };
  assert.equal(selection(input).companies[0].metrics.failed, 0);
  const updated = selection({ ...input, latestResults: [...input.latestResults,
    { proposal_id: uuid(101), created_at: '2026-11-24T03:00:00Z', interview_result: 'passed', revision: 2 }] });
  assert.equal(updated.companies[0].metrics.passed, 1);
  assert.equal(updated.companies[0].metrics.resultCoverage, 100);
});

test('Sales won remains contract history, not interview pass, and manual prompts stay in Sales', () => {
  const company = detail({ salesProposals: [sale(1, { source_system: 'manual', source_proposal_id: null,
    status: 'won', sent_at: at, service: 'SES' })] });
  assert.equal(company.history.won, 1);
  assert.equal(company.history.passed, 0);
  assert.equal(company.metrics.passed, 0);
  assert.equal(company.metrics.meetings, 0);
  assert.match(company.next.label, /^Sales/);
  assert.equal(company.proposals[0].source, 'sales');
  assert.equal(company.proposals[0].href, 'https://gw.8grp.co.jp/sales/proposals.html?id=' + uuid(101));
});

test('explicit manual meeting_done state is held, while archive is not a loss', () => {
  const company = detail({ salesProposals: [sale(1, { source_system: 'manual', source_proposal_id: null,
    status: 'meeting_done', sent_at: at, archived_at: '2026-11-23T00:00:00Z' })] });
  assert.equal(company.history.total, 1);
  assert.equal(company.history.active, 0);
  assert.equal(company.history.lost, 0);
  assert.equal(company.metrics.meetings, 1);
  assert.equal(company.metrics.resultPending, 1);
});

test('deleted source records suppress stale Sales copies, but missing sources remain explicitly unknown', () => {
  const result = selection({ engerProposals: [source(1, { deleted_at: at })],
    salesProposals: [sale(1, { sent_at: at }), sale(2, { sent_at: at })] });
  assert.equal(result.summary.proposals, 1);
  assert.equal(result.companies[0].history.active, 0);
  assert.ok(result.dataStatus.notes.some(value => value.includes('元提案')));
});

test('unique exact trimmed names resolve virtually without fuzzy corporate-name merging', () => {
  const result = selection({ engerProposals: [source(1, { company: ' 株式会社テスト ' }), source(2, { company: 'テスト' })] });
  assert.equal(result.summary.companies, 2);
  assert.equal(result.companies.find(value => value.engerCompanyId === COMPANY).identity.kind, 'name');
  assert.equal(result.companies.find(value => !value.engerCompanyId).identity.kind, 'missing');
});

test('ambiguous master names and distinct explicit IDs cannot silently merge', () => {
  const result = selection({ engerCompanies: [{ id: COMPANY, name: '株式会社テスト' }, { id: uuid(1001), name: '株式会社テスト' }],
    engerProposals: [source(1), source(2), source(3, { company_id: COMPANY }), source(4, { company_id: uuid(1001) })] });
  assert.equal(result.summary.companies, 4);
  assert.equal(result.companies.filter(value => value.identity.kind === 'ambiguous').length, 2);
  assert.equal(result.companies.filter(value => value.identity.kind === 'id').length, 2);
});

test('mixed ID-confirmed and virtual name-matched evidence keeps its confidence visible', () => {
  const company = detail({ engerProposals: [source(1, { company_id: COMPANY }), source(2)] });
  assert.equal(company.history.total, 2, 'the shared canonical company stays grouped');
  assert.equal(company.identity.kind, 'name');
  assert.match(company.identity.label, /一部の履歴/);
  assert.deepEqual(company.identity.basisCounts, { id: 1, name: 1, ambiguous: 0, missing: 0 });
  assert.deepEqual(new Set(company.proposals.map(row => row.identity.kind)), new Set(['id', 'name']));
});

test('complete long names determine exact matches and unlinked hashes, not their display prefixes', () => {
  const prefix = '長い企業名称'.repeat(50), first = prefix + '甲', second = prefix + '乙';
  const result = selection({ engerCompanies: [{ id: COMPANY, name: first }, { id: uuid(1001), name: second }],
    engerProposals: [source(1, { company: first }), source(2, { company: second })] });
  assert.equal(result.summary.companies, 2);
  assert.equal(result.companies.every(row => row.identity.kind === 'name'), true);
  assert.deepEqual(new Set(result.companies.map(row => row.engerCompanyId)), new Set([COMPANY, uuid(1001)]));
  const unmatched = selection({ engerCompanies: [], engerProposals: [source(1, { company: first }), source(2, { company: second })] });
  assert.equal(unmatched.summary.companies, 2);
  assert.equal(new Set(unmatched.companies.map(row => row.key)).size, 2);
});

test('explicit IDs, tenant-scoped company links and confirmed links take precedence over names', () => {
  const result = selection({ engerCompanies: [{ id: COMPANY, name: '正式企業' }, { id: uuid(1001), name: '株式会社テスト' }],
    engerProposals: [source(1, { company_id: COMPANY }), source(2), source(3)],
    salesProposals: [sale(2, { company_id: uuid(2000) })],
    companyLinks: [{ tenant_id: TENANT, source_system: 'enger', company_id: uuid(2000), source_company_id: COMPANY }],
    confirmedHistoryLinks: [{ tenant_id: TENANT, company_id: COMPANY, entity_type: 'proposal', entity_id: uuid(3) }] });
  assert.equal(result.summary.companies, 1);
  assert.equal(result.companies[0].name, '正式企業');
  assert.equal(result.companies[0].history.total, 3);
  assert.equal(result.companies[0].identity.kind, 'id');
});

test('tenant scoping rejects mixed implicit scopes and ignores foreign links/activities in an explicit scope', () => {
  assert.throws(() => buildCompanyAnalysis({ now: NOW, salesProposals: [sale(1), sale(2, { tenant_id: OTHER_TENANT })] }),
    value => value.code === 'analysis_scope');
  const result = selection({ engerProposals: [source()], salesProposals: [sale(1, { sent_at: at }), sale(2, { tenant_id: OTHER_TENANT })],
    activities: [activity(1, { tenant_id: OTHER_TENANT })], companyLinks: [{ tenant_id: OTHER_TENANT,
      source_system: 'enger', source_company_id: uuid(9999), company_id: uuid(2000) }] });
  assert.equal(result.summary.proposals, 1);
  assert.equal(result.summary.meetings, 0);
});

test('JST month boundaries select a sent cohort and keep all-time outcomes separate', () => {
  const result = selection({ engerProposals: [source(1, { stage: '合格' }), source(2, { stage: '合格' }), source(3, { stage: '合格' })],
    salesProposals: [sale(1, { sent_at: '2026-10-31T14:59:59.999Z' }), sale(2, { sent_at: '2026-10-31T15:00:00Z' })] }, { period: 'this_month' });
  assert.equal(result.summary.passed, 3, 'all historical passes stay visible');
  assert.equal(result.summary.sent, 1);
  assert.equal(result.companies[0].metrics.passed, 1);
  assert.equal(result.summary.unknownSent, 1);
  assert.equal(result.period.from, '2026-11-01');
  const earlier = selection({ engerProposals: [source(1, { stage: '合格' })],
    salesProposals: [sale(1, { sent_at: '2026-10-31T14:59:59.999Z' })] }, { period: 'this_month' });
  assert.equal(earlier.summary.companies, 1, 'a company with only historical evidence remains visible');
  assert.equal(earlier.companies[0].metrics.sent, 0);
  assert.equal(earlier.companies[0].metrics.passRate, null);
});

test('JST weeks start Monday and exclude future timestamps and malformed dates', () => {
  const result = selection({ engerProposals: [source(1), source(2), source(3)], salesProposals: [
    sale(1, { sent_at: '2026-11-22T14:59:59Z' }), sale(2, { sent_at: '2026-11-22T15:00:00Z' }),
    sale(3, { sent_at: '2026-11-26T00:00:00Z' })] }, { period: 'this_week' });
  assert.equal(result.summary.sent, 1);
  assert.equal(result.period.from, '2026-11-23');
  const malformed = selection({ engerProposals: [source()], salesProposals: [sale(1, { sent_at: '2026-02-30T01:00:00Z' })] });
  assert.equal(malformed.summary.sent, 0);
});

test('query, service and owner narrow facts before grouping; unknown service stays unknown', () => {
  const input = { engerProposals: [source(1, { business_category: 'SES', job_title: 'Java開発' }), source(2, { job_title: 'PMO支援' })],
    salesProposals: [sale(1, { sales_owner_id: uuid(700), service: 'ENGER' }), sale(2, { sales_owner_id: uuid(701), service: 'SES' })],
    employees: [{ id: uuid(700), display_name: '営業A' }, { id: uuid(701), display_name: '営業B' }] };
  assert.equal(selection(input, { q: 'java' }).summary.proposals, 1);
  assert.equal(selection(input, { service: 'unknown' }).summary.proposals, 1, 'ENGER label never invents a business category');
  assert.equal(selection(input, { owner: uuid(700) }).summary.proposals, 1);
  assert.equal(selection(input, { owner: uuid(799) }).summary.proposals, 0, 'valid me with no assignments returns empty');
  assert.equal(selection(input, { owner: 'none' }).summary.proposals, 0);
});

test('no percentages are fabricated on incomplete or unavailable evidence', () => {
  assert.throws(() => model({ complete: false }), value => value.status === 503 && value.code === 'analysis_incomplete');
  const result = selection({ engerAvailable: false, salesProposals: [sale(1, { sent_at: at })], activities: [activity()] });
  assert.equal(result.dataStatus.engerAvailable, false);
  assert.equal(result.companies[0].metrics.passRate, null);
  assert.equal(result.companies[0].metrics.meetingRate, null);
  assert.ok(result.dataStatus.notes.some(value => value.includes('取得していない')));
});

test('detail pagination and interaction limits are deterministic and explicit', () => {
  const sources = Array.from({ length: 25 }, (_, index) => source(index + 1));
  const sales = sources.map((_, index) => sale(index + 1, { sent_at: at }));
  const acts = Array.from({ length: 40 }, (_, index) => activity(index + 1, { proposal_id: uuid(101),
    kind: 'memo', result: null, occurred_at: '2026-11-21T02:' + String(index).padStart(2, '0') + ':00Z' }));
  const built = model({ engerProposals: sources, salesProposals: sales, activities: acts });
  const result = selectCompanyAnalysis(built, { company: 'enger:' + COMPANY, page: 2, pageSize: 20 });
  assert.equal(result.company.proposals.length, 5);
  assert.deepEqual(result.company.detailPagination, { page: 2, pageSize: 20, total: 25, pages: 2 });
  assert.equal(result.company.interactions.length, 30);
  assert.equal(result.company.interactionsLimited, true);
  assert.ok(result.company.interactionsTotal > 30);
  assert.ok(result.dataStatus.notes.some(value => value.includes('30件')));
  assert.deepEqual(selectCompanyAnalysis(built, { company: 'enger:' + COMPANY, page: 2, pageSize: 20 }), result);
});

test('links use validated first-party IDs and never copy an arbitrary source URL', () => {
  const malicious = 'javascript:alert(1)';
  const company = detail({ engerProposals: [source(1, { job_title: '<img src=x onerror=alert(1)>' })],
    salesProposals: [sale(1, { source_url: malicious })] });
  assert.equal(company.proposals[0].href, 'https://dx.enger.jp/proposals/' + uuid(1));
  assert.equal(company.proposals[0].jobTitle, '<img src=x onerror=alert(1)>', 'plain data is preserved for text-safe rendering by UI');
  assert.equal(JSON.stringify(company).includes(malicious), false);
});

test('invalid filters fail clearly instead of silently returning plausible zero metrics', () => {
  const built = model({ engerProposals: [source()] });
  for (const query of [{ period: 'forever' }, { focus: 'rank_a' }, { sort: 'probability' }, { service: 'guess' },
    { owner: 'invalid' }, { page: 0 }, { page: '1.5' }, { pageSize: 51 }, { q: 'a'.repeat(201) },
    { period: 'custom', from: '2026-02-30', to: '2026-11-01' }, { from: '2026-11-01' }, { company: 'x'.repeat(241) }]) {
    assert.throws(() => selectCompanyAnalysis(built, query), value => value.status === 400);
  }
  assert.throws(() => selectCompanyAnalysis(built, { company: 'enger:' + uuid(9999) }), value => value.status === 404);
});

console.log(`Sales company proposal analysis: ${tested} meaningful regressions passed`);
