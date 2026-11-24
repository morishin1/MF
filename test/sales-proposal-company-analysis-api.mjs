import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMemDb } from './_memdb.mjs';

const path = name => fileURLToPath(new URL('../' + name, import.meta.url));
const tenant = '4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const actor = { id: id(5) };
const salesTable = 'gw_sales_proposals';
const sourceTable = 'enger.proposals';
const membersTable = 'enger.organization_memberships';
const assessmentsTable = 'gw_sales_proposal_assessments';
const reads = [];
let ctx, signedIn, hiddenTables, serverCap;
const mem = createMemDb({ rls: table => !hiddenTables.has(table) });

function client(asUser = false) {
  const original = asUser ? mem.userClient('tester') : mem.admin();
  return {
    from(table) {
      const query = original.from(table);
      const record = { table, asUser, filters: [], fields: [], orders: [], projections: [] };
      reads.push(record);
      let proxy;
      proxy = new Proxy(query, {
        get(target, property) {
          if (property === 'then') return (resolve, reject) => {
            // _memdb supports one order column; these reads also exercise the
            // assessment table's real composite key and PostgREST JSON alias.
            const originalRows = mem.rows[table];
            if (originalRows && record.orders.length) mem.rows[table] = [...originalRows].sort((a, b) => {
              for (const [column, options] of record.orders) {
                const compare = a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0;
                if (compare) return compare * (options?.ascending === false ? -1 : 1);
              }
              return 0;
            });
            let pending;
            try { pending = target.then(result => {
              if (!result.error && record.projections.length) result.data = result.data.map(row => {
                const projected = { ...row };
                for (const [alias, column, key] of record.projections) {
                  projected[alias] = row[column]?.[key] ?? null;
                  if (!record.fields.includes(column)) delete projected[column];
                }
                return projected;
              });
              return result;
            }); } finally { if (originalRows) mem.rows[table] = originalRows; }
            return pending.then(resolve, reject);
          };
          const method = target[property];
          if (typeof method !== 'function') return method;
          return (...args) => {
            if (['insert', 'update', 'delete', 'upsert', 'rpc'].includes(property))
              throw Error('read_only_endpoint_must_not_write');
            if (property === 'select') {
              record.fields = String(args[0]).split(',');
              args[0] = record.fields.map(field => {
                const match = /^([a-z_]+):([a-z_]+)->>(\w+)$/.exec(field);
                if (!match) return field;
                record.projections.push(match.slice(1));
                return match[2];
              }).join(',');
            }
            if (property === 'order') { record.orders.push(args); return proxy; }
            if (['eq', 'in', 'is', 'gt'].includes(property)) record.filters.push([property, ...args]);
            if (property === 'limit' && serverCap) args[0] = Math.min(args[0], serverCap);
            if (property === 'range' && serverCap) args[1] = Math.min(args[1], args[0] + serverCap - 1);
            method.apply(target, args);
            return proxy;
          };
        },
      });
      return proxy;
    },
    schema(schema) { return { from: table => this.from(schema + '.' + table) }; },
  };
}

mock.module(path('lib/supabase.js'), { namedExports: { admin: () => client(), userClient: () => client(true) } });
mock.module(path('lib/auth.js'), { namedExports: { requireUser: async (_req, res) => {
  if (signedIn) return actor;
  res.statusCode = 401; res.end('{}'); return null;
} } });
mock.module(path('lib/gw.js'), { namedExports: {
  gwContext: async () => ctx, canSell: context => context.roles.includes('sales'),
} });

const { default: handler, companyAnalysisFilters, runCompanyAnalysis } = await import('../api/sales/proposals/company-analysis.js');
const { loadCompanyAnalysisData, readCompanyAnalysisRows } = await import('../lib/sales-proposal-company-analysis-data.js');

function reset() {
  for (const table of Object.keys(mem.rows)) delete mem.rows[table];
  reads.length = 0;
  mem.state.log.length = 0;
  mem.state.missing = null;
  signedIn = true;
  hiddenTables = new Set();
  serverCap = null;
  ctx = { tenantId: tenant, employee: { id: id(6), status: 'active' }, roles: ['sales'] };
  mem.rows[membersTable] = [];
  mem.rows[salesTable] = [{
    id: id(1), tenant_id: tenant, source_system: 'enger', source_proposal_id: id(2),
    company_id: id(10), source_company_id: id(11), company_name: 'Example Inc.',
    sales_owner_id: id(6), job_title: 'Backend engineer', talent_initials: 'T.K.',
    service: 'ses', status: 'sent', sent_at: '2026-11-01T01:00:00Z',
    contact_email: 'private@example.invalid', source_url: 'https://unsafe.invalid',
  }];
  mem.rows[sourceTable] = [{
    id: id(2), company_id: id(11), company: 'Example Inc.', job_id: id(12),
    job_title: 'Backend engineer', candidate_name: 'T.K.', business_category: 'SES',
    stage: '面談', proposed_at: '2026-11-01T01:00:00Z',
    created_at: '2026-10-30T00:00:00Z', deleted_at: null,
    meeting_date: '2026-11-03', meeting_status: '完了',
    contact_email: 'source-private@example.invalid', mail_body: 'PRIVATE EMAIL BODY',
  }, {
    // A real historical outcome does not require a Sales synchronization row.
    id: id(3), company_id: id(11), company: 'Example Inc.',
    job_title: 'Historical success', candidate_name: 'A.B.', business_category: null,
    stage: '合格', created_at: '2025-01-01T00:00:00Z',
    stage_updated_at: '2025-01-10T00:00:00Z', deleted_at: null,
  }];
  mem.rows['enger.companies'] = [{ id: id(11), name: 'Example Inc.', deleted_at: null }];
  mem.rows.gw_sales_companies = [{ id: id(10), tenant_id: tenant, name: 'Example Inc.' }];
  mem.rows.gw_sales_company_links = [{
    id: id(13), tenant_id: tenant, source_system: 'enger', source_company_id: id(11), company_id: id(10),
  }];
  mem.rows.gw_employees = [{ id: id(6), tenant_id: tenant, display_name: '担当者' }];
  mem.rows.gw_sales_proposal_activities = [{
    id: id(20), tenant_id: tenant, proposal_id: id(1), kind: 'meeting', result: 'done',
    occurred_at: '2026-11-03T03:00:00Z', note: 'PRIVATE SALES NOTE', detail: 'PRIVATE SALES DETAIL',
  }];
  mem.rows[assessmentsTable] = [{ tenant_id: tenant, proposal_id: id(1), revision: 1,
    created_at: '2026-11-04T00:00:00Z', facts: { interviewResult: 'passed', notes: 'PRIVATE ASSESSMENT FACTS' } }];
  mem.rows['enger.activity_logs'] = [{
    id: id(21), target_type: 'proposal', target_id: id(3), action: 'ステージ変更',
    detail: JSON.stringify({ from: '面談', to: '合格' }), created_at: '2025-01-10T00:00:00Z',
  }];
  mem.rows['enger.dx2_proposal_email_rounds'] = [{
    id: id(22), proposal_id: id(2), side: 'job', opens_round: true,
    sent_at: '2026-11-01T01:00:00Z', body: 'PRIVATE ROUND BODY',
  }];
  mem.rows['enger.dx2_proposal_email_reactions'] = [{
    id: id(23), proposal_id: id(2), side: 'job', round_id: id(22), result: 'proceed',
    answered_at: '2026-11-02T00:00:00Z', recorded_at: '2026-11-02T00:00:00Z',
    memo: 'PRIVATE REACTION MEMO', wishes: 'PRIVATE REACTION WISHES',
  }];
  mem.rows['enger.dx2_sales_company_history_links'] = [{
    id: id(24), tenant_id: tenant, company_id: id(11), entity_type: 'proposal',
    entity_id: id(3), source_kind: 'historical_proposal', linked_at: '2026-10-01T00:00:00Z',
  }, {
    id: id(25), tenant_id: tenant, company_id: id(11), entity_type: 'job',
    entity_id: id(12), source_kind: 'company_name', linked_at: '2026-10-01T00:00:00Z',
  }];
}

const response = () => ({
  statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; },
  end(value) { this.body = JSON.parse(value); },
});
async function call(query = '', method = 'GET') {
  const res = response();
  await handler({ method, url: '/api/sales/proposals/company-analysis' + query }, res);
  return res;
}
const load = () => loadCompanyAnalysisData({ db: client(), sb: client(true), tenantId: tenant });

test('only authenticated active internal Eight Sales may read full ENGER history; legacy null membership is preserved', async () => {
  reset();
  signedIn = false;
  assert.equal((await call()).statusCode, 401);
  assert.equal(reads.length, 0);
  signedIn = true;
  const forbidden = [
    () => { ctx.tenantId = id(99); },
    () => { ctx.roles = []; },
    () => { ctx.employee.status = 'inactive'; },
    () => { ctx.employee = null; },
    () => { mem.rows[membersTable] = [{ user_id: actor.id, status: 'active', membership_type: 'external' }]; },
    () => { mem.rows[membersTable] = [{ user_id: actor.id, status: 'inactive', membership_type: 'internal' }]; },
    () => { mem.rows[membersTable] = [{ user_id: actor.id, status: 'active', membership_type: 'internal', partner_organization_id: id(99) }]; },
  ];
  for (const setup of forbidden) {
    reset(); setup();
    assert.equal((await call()).statusCode, 403);
    assert.equal(reads.some(row => row.table !== membersTable), false);
  }
  reset();
  assert.equal((await call()).statusCode, 200);
  mem.rows[membersTable] = [{ user_id: actor.id, status: 'active', membership_type: 'internal' }];
  assert.equal((await call()).statusCode, 200);
  assert.deepEqual(mem.state.log, []);
});

test('all Sales reads retain caller RLS and tenant; service-only latest results cannot broaden readable Sales proposals', async () => {
  reset();
  mem.rows[salesTable].push({ ...mem.rows[salesTable][0], id: id(80), tenant_id: id(90), company_name: 'Other tenant secret' });
  mem.rows[assessmentsTable].push(
    { tenant_id: id(90), proposal_id: id(1), revision: 2, facts: { interviewResult: 'failed' } },
    { tenant_id: tenant, proposal_id: id(81), revision: 1, facts: { interviewResult: 'failed' } },
  );
  mem.rows.gw_sales_proposal_activities.push({ id: id(82), tenant_id: tenant, proposal_id: id(81), kind: 'meeting', result: 'done' });
  mem.rows['enger.dx2_sales_company_history_links'].push({
    id: id(83), tenant_id: id(90), company_id: id(99), entity_type: 'proposal', entity_id: id(3), source_kind: 'company_name',
  });
  const input = await load();
  assert.deepEqual(input.salesProposals.map(row => row.id), [id(1)]);
  assert.deepEqual(input.latestResults.map(row => row.interview_result), ['passed']);
  assert.deepEqual(input.activities.map(row => row.id), [id(20)]);
  assert.equal(input.confirmedHistoryLinks.length, 2);
  for (const read of reads.filter(row => row.table.startsWith('gw_'))) {
    assert.ok(read.filters.some(([op, key, value]) => op === 'eq' && key === 'tenant_id' && value === tenant));
    assert.equal(read.asUser, read.table !== assessmentsTable);
  }
  hiddenTables.add(salesTable);
  reads.length = 0;
  const hidden = await load();
  assert.equal(hidden.salesProposals.length, 0);
  assert.equal(hidden.latestResults.length, 0);
  assert.equal(reads.some(row => row.table === assessmentsTable), false);
  assert.equal(hidden.engerProposals.length, 2, 'independent full ENGER history remains authorized by the internal gate');
});

test('required reads fail closed without partial summaries, raw database errors or fabricated zero counts', async () => {
  const sources = [membersTable, salesTable, sourceTable, 'gw_sales_companies', 'enger.companies',
    'gw_sales_company_links', 'gw_employees', 'gw_sales_proposal_activities', assessmentsTable,
    'enger.activity_logs', 'enger.dx2_proposal_email_rounds', 'enger.dx2_proposal_email_reactions',
    'enger.dx2_sales_company_history_links'];
  const quiet = mock.method(console, 'error', () => {});
  try {
    for (const source of sources) {
      reset(); mem.state.missing = source;
      const result = await call();
      assert.equal(result.statusCode, 503, source);
      assert.equal(result.body.error, 'analysis_data_unavailable');
      assert.equal(result.body.summary, undefined);
      assert.doesNotMatch(JSON.stringify(result.body), /PGRST|schema cache|gw_sales|organization_memberships/);
    }
    reset();
    mem.rows[membersTable] = [
      { user_id: actor.id, status: 'active', membership_type: 'internal' },
      { user_id: actor.id, status: 'active', membership_type: 'internal' },
    ];
    assert.equal((await call()).statusCode, 503);
    assert.equal(reads.some(row => row.table !== membersTable), false);
  } finally { quiet.mock.restore(); }
});

test('complete paging crosses server row caps, preserves source tombstones, and never fetches contact or email bodies', async () => {
  reset();
  serverCap = 1;
  mem.rows[sourceTable].push({ id: id(9), stage: '合格', deleted_at: '2026-11-20T00:00:00Z' });
  mem.rows['enger.activity_logs'].push({ id: id(29), target_type: 'proposal', target_id: id(9), action: 'ステージ変更', detail: '{}' });
  mem.rows['enger.dx2_proposal_email_rounds'].push({ id: id(30), proposal_id: id(9), side: 'job', sent_at: '2026-11-01T00:00:00Z' });
  mem.rows['enger.dx2_proposal_email_reactions'].push({ id: id(31), proposal_id: id(99), side: 'job', result: 'pass' });
  mem.rows['enger.dx2_sales_company_history_links'].push({
    id: id(32), tenant_id: tenant, company_id: id(11), entity_type: 'proposal', entity_id: id(99), source_kind: 'company_name',
  }, {
    id: id(33), tenant_id: tenant, company_id: id(11), entity_type: 'job', entity_id: id(99), source_kind: 'company_name',
  });
  const input = await load();
  assert.deepEqual(input.engerProposals.map(row => row.id), [id(2), id(3), id(9)]);
  assert.deepEqual(input.stageHistory.map(row => row.id), [id(21)]);
  assert.deepEqual(input.emailRounds.map(row => row.id), [id(22)]);
  assert.deepEqual(input.emailReactions.map(row => row.id), [id(23)]);
  assert.equal(input.confirmedHistoryLinks.length, 2);
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE|private@|unsafe\.invalid/);
  const forbidden = new Set(['contact_email', 'email', 'phone', 'body', 'mail_body', 'source_url', 'note', 'memo', 'wishes']);
  for (const read of reads) assert.equal(read.fields.some(field => forbidden.has(field)), false, read.table);
  assert.deepEqual(mem.state.log, []);
});

test('timestamped latest assessment handles reopened proposals and a newer cleared result without reading all facts', async () => {
  reset();
  mem.rows['enger.activity_logs'].push({
    id: id(41), target_type: 'proposal', target_id: id(2), action: 'ステージ変更',
    detail: JSON.stringify({ from: '失注', to: '面談' }), created_at: '2026-11-10T00:00:00Z',
  });
  mem.rows[assessmentsTable].push({ tenant_id: tenant, proposal_id: id(1), revision: 2,
    created_at: '2026-11-12T00:00:00Z', facts: { interviewResult: 'failed', privateNote: 'PRIVATE ASSESSMENT FACTS' } });
  // Different proposal IDs and unsorted revisions exercise the table's
  // composite primary key across smaller-than-requested server pages.
  mem.rows[salesTable].push({ id: id(42), tenant_id: tenant, source_system: 'manual', company_name: 'Other company' });
  mem.rows[assessmentsTable].unshift(
    { tenant_id: tenant, proposal_id: id(42), revision: 2, created_at: '2026-11-12T00:00:00Z', facts: { interviewResult: 'failed' } },
    { tenant_id: tenant, proposal_id: id(42), revision: 1, created_at: '2026-11-01T00:00:00Z', facts: { interviewResult: 'passed' } },
  );
  serverCap = 1;
  const input = await load();
  assert.equal(input.latestResults.length, 2);
  assert.deepEqual(input.latestResults.find(row => row.proposal_id === id(1)), {
    tenant_id: tenant, proposal_id: id(1), revision: 2,
    created_at: '2026-11-12T00:00:00Z', interview_result: 'failed',
  });
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE|privateNote|"facts"/);
  const result = await call();
  assert.equal(result.statusCode, 200);
  const company = result.body.companies.find(row => row.engerCompanyId === id(11));
  assert.equal(company.metrics.failed, 1);
  mem.rows[assessmentsTable].push({ tenant_id: tenant, proposal_id: id(1), revision: 3,
    created_at: '2026-11-14T00:00:00Z', facts: { interviewResult: 'unknown' } });
  assert.equal((await load()).latestResults.find(row => row.proposal_id === id(1)).interview_result, 'unknown');
});

test('complete paging accepts its exact bound, rejects overflow and malformed/nonadvancing pages', async () => {
  reset();
  mem.rows.fixture = Array.from({ length: 3 }, (_, index) => ({ id: id(index + 1) }));
  const make = () => client().from('fixture').select('id');
  assert.equal((await readCompanyAnalysisRows(make, { maxRows: 3, pageSize: 2 })).length, 3);
  await assert.rejects(() => readCompanyAnalysisRows(make, { maxRows: 2, pageSize: 2 }), { code: 'analysis_data_limit' });
  await assert.rejects(() => readCompanyAnalysisRows(make, { maxRows: 3, pageSize: 1, maxPages: 1 }), { code: 'analysis_data_limit' });
  const broken = () => ({ order() { return this; }, gt() { return this; }, limit() {
    return Promise.resolve({ data: [{ id: id(1) }], error: null });
  } });
  await assert.rejects(() => readCompanyAnalysisRows(broken), { code: 'analysis_data_unavailable' });
});

test('API source overflow returns unavailable instead of a truncated company aggregate', async () => {
  reset();
  mem.rows[sourceTable] = Array.from({ length: 20001 }, (_, index) => ({
    id: id(index + 1000), company_id: id(11), company: 'Example Inc.', stage: '合格', deleted_at: null,
  }));
  const quiet = mock.method(console, 'error', () => {});
  try {
    const result = await call();
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.error, 'analysis_data_limit');
    assert.equal(result.body.summary, undefined);
    assert.deepEqual(mem.state.log, []);
  } finally { quiet.mock.restore(); }
});

test('GET rejects invalid filters before reading history; me resolves only to the current Sales employee', async () => {
  reset();
  assert.equal(companyAnalysisFilters('/?owner=me', ctx).owner, id(6));
  for (const query of [
    '?period=today', '?period=all&period=this_month', '?page=0', '?page=-1', '?page=1.5', '?page=10001',
    '?pageSize=51', '?pageSize=0', '?pageSize=', '?sort=probability', '?focus=lost', '?owner=manager',
    '?tenant_id=' + id(99), '?from=2026-11-01', '?refresh=true', '?q=%00', '?q=' + 'x'.repeat(201),
  ]) {
    reads.length = 0;
    const result = await call(query);
    assert.equal(result.statusCode, 400, query);
    assert.equal(reads.some(row => row.table !== membersTable), false, query);
  }
  assert.equal((await call('?service=not-a-recorded-service')).statusCode, 400);
  ctx.employee.id = id(99);
  const mine = await call('?owner=me');
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.body.summary.proposals, 0);
  assert.equal((await call('?company=missing-company-key')).statusCode, 404);
  const method = await call('', 'POST');
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.Allow, 'GET');
  assert.deepEqual(mem.state.log, []);
});

test('API includes ENGER-only historical successes separately from sent-cohort rates and returns validated evidence links', async () => {
  reset();
  const res = response();
  await runCompanyAnalysis({ url: '/?period=all' }, res, {
    db: client(), sb: client(true), ctx, now: '2026-11-24T03:00:00Z',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.proposals, 2);
  assert.equal(res.body.summary.unknownSent, 1);
  assert.equal(res.body.companies.length, 1);
  assert.equal(res.body.companies[0].history.passed, 2);
  assert.equal(res.body.companies[0].metrics.sent, 1);
  assert.equal(res.body.companies[0].metrics.passed, 1);
  const detail = await call('?company=' + encodeURIComponent(res.body.companies[0].key) + '&pageSize=1');
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.company.proposals.length, 1);
  assert.equal(detail.body.company.detailPagination.total, 2);
  assert.match(detail.body.company.proposals[0].href, /^https:\/\/dx\.enger\.jp\/proposals\/[0-9a-f-]+$/);
  assert.equal(detail.headers['Cache-Control'], 'private, no-store');
  assert.doesNotMatch(JSON.stringify(detail.body), /PRIVATE|private@|unsafe\.invalid/);
  assert.deepEqual(mem.state.log, []);
});
