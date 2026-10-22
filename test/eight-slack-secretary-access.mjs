// In-memory DB and mocked Slack/AI only: never sends real messages.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
let aiResult, aiInputs, activeDb, onAi;
mock.module('../lib/auth.js', { namedExports: { getMemberships: async () => activeDb.memberships || [] } });
mock.module('../lib/supabase.js', { namedExports: { admin: () => activeDb } });
mock.module('../lib/ai-assistant.js', { namedExports: { askAssistant: async input => { aiInputs.push(input); if (onAi) onAi(); return aiResult; } } });
const { processSlackEvent, processQueuedEvents, slackPost } = await import('../lib/eight-slack-secretary.js');
const config = { tenantId: 'tenant', teamId: 'T1', ownerSlackId: 'Uowner', botToken: 'mock-only', approvalHoldMs: 0 };
const toRequester = () => sent.filter(m => m.channel === 'D1');
const toOwner = () => sent.filter(m => m.channel === 'Downer' || m.channel === 'Uowner');
let sent = [], failure;
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://slack.com/api/chat.postMessage');
  sent.push(JSON.parse(options.body));
  if (failure === 'timeout') throw new Error('timeout after possible acceptance');
  if (failure === 'reject') return { ok: true, json: async () => ({ ok: false, error: 'channel_not_found' }) };
  const body = JSON.parse(options.body);
  return { ok: true, json: async () => ({ ok: true, ts: 'owner-ts', channel: body.channel === 'Uowner' ? 'Downer' : body.channel }) };
};
function database() {
  const tables = {
    gw_slack_ai_users: [{ tenant_id: 'tenant', slack_team_id: 'T1', slack_user_id: 'U1', employee_id: 'emp' }],
    gw_employees: [{ id: 'emp', tenant_id: 'tenant', status: 'active', user_id: 'user', display_name: 'Test' }],
    gw_role_grants: [], gw_app_grants: [], gw_ai_knowledge: [], gw_slack_ai_escalations: [], gw_slack_ai_events: [],
  };
  const db = { tables, calls: [], failAnswered: false, failDone: false,
    from(table) {
      const filters = []; let mode = 'select', values, single = false, limit = Infinity;
      const q = {
        select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); db.calls.push([table, k, v]); return q; },
        in(k, v) { filters.push(r => v.includes(r[k])); db.calls.push([table, k, v]); return q; },
        order() { return q; }, limit(n) { limit = n; return q; },
        insert(v) { mode = 'insert'; values = v; return q; }, update(v) { mode = 'update'; values = v; return q; },
        single() { single = true; return q; }, maybeSingle() { single = true; return q; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          if (db.failTable === table) return { data:null, error:new Error('mock_read_failed') };
          if (mode === 'update' && ((db.failAnswered && values.status === 'answered') || (db.failDone && values.state === 'done') || (db.failFailed && values.state === 'failed'))) return { data: null, error: new Error('mock_db_write_failed') };
          let rows = tables[table].filter(r => filters.every(f => f(r))).slice(0, limit);
          if (mode === 'insert') { rows = [{ id: 'esc-' + tables[table].length, status: 'pending', ...values }]; tables[table].push(...rows); }
          if (mode === 'update') rows.forEach(r => Object.assign(r, values));
          if (single && rows.length > 1) return { data: null, error: new Error('multiple_rows') };
          return { data: single ? rows[0] || null : rows, error: null };
        }).then(resolve, reject); },
      }; return q;
    },
  }; activeDb = db; return db;
}
const event = (text, user = 'U1', extra = {}) => ({ team_id: 'T1', event: { type: 'message', channel_type: 'im', channel: user === 'Uowner' ? 'Downer' : 'D1', user, ts: 'q-ts', text, ...extra } });
const pending = () => ({ id: 'esc', tenant_id: 'tenant', requester_channel: 'D1', requester_thread_ts: 'q-ts', owner_dm_ts: 'owner-ts', owner_dm_channel: 'Downer', status: 'pending' });
const reset = () => { sent = []; aiInputs = []; onAi = null; failure = null; aiResult = { confident: true, usedKnowledgeIds: ['k1'], answer: '公開資料による回答' }; };

let checked = 0;
const seedKnowledge = db => {
  db.tables.gw_ai_knowledge = ['all', 'hr', 'finance', 'admin'].map(scope => ({
    id: scope, tenant_id: 'tenant', is_active: true, access_scope: scope, title: '手順の確認', content: '手順の確認 ' + scope,
  }));
  db.tables.gw_ai_knowledge.push({ id: 'other-tenant', tenant_id: 'other', is_active: true, access_scope: 'all', title: '手順の確認', content: 'hidden' });
  db.tables.gw_ai_knowledge.push({ id: 'inactive', tenant_id: 'tenant', is_active: false, access_scope: 'all', title: '手順の確認', content: 'hidden' });
};
for (const [roles, apps, membership, expected] of [
  [[], [], [], ['all']],
  [['hr'], ['office'], [], ['all','hr']],
  [['hr'], [], [], ['all']],
  [['finance'], ['office'], [], ['all','finance']],
  [['finance'], [], [], ['all']],
  [['owner'], [], [], ['all','hr','finance','admin']],
  [[], [], [{ tenant_id:'tenant', role:'admin' }], ['all','hr','admin']],
]) {
  reset(); const db = database(); db.memberships = membership;
  db.tables.gw_role_grants = roles.map(role => ({ employee_id:'emp', role }));
  db.tables.gw_app_grants = apps.map(app_key => ({ employee_id:'emp', app_key }));
  seedKnowledge(db); aiResult.usedKnowledgeIds = expected;
  await processSlackEvent(db, event('手順の確認'), config);
  assert.deepEqual(aiInputs[0].knowledgeRows.map(k => k.id).sort(), expected.slice().sort(), roles + ' scopes');
  assert.equal(sent.length, 1); checked++;
}
for (const [label, change] of [
  ['unlinked', db => db.tables.gw_slack_ai_users = []],
  ['retired', db => db.tables.gw_employees[0].status = 'left'],
  ['inactive', db => db.tables.gw_employees[0].status = 'inactive'],
  ['missing GW account', db => db.tables.gw_employees[0].user_id = null],
  ['link tenant mismatch', db => db.tables.gw_slack_ai_users[0].tenant_id = 'other'],
  ['employee tenant mismatch', db => db.tables.gw_employees[0].tenant_id = 'other'],
  ['context tenant mismatch', db => db.memberships = [{ tenant_id:'other', role:'admin' }]],
  ['context employee mismatch', db => db.tables.gw_employees.unshift({ ...db.tables.gw_employees[0], id:'other-emp' })],
]) {
  reset(); const db = database(); seedKnowledge(db); change(db);
  await processSlackEvent(db, event('手順の確認'), config);
  assert.equal(aiInputs.length, 0, label);
  assert.equal(db.calls.some(([t]) => t === 'gw_ai_knowledge'), false, label);
  assert.equal(sent.length, 1); assert.match(sent[0].text, /本人確認が完了していません/); checked++;
}
reset();
{
  const db = database(); db.tables.gw_slack_ai_escalations = [pending()];
  await processSlackEvent(db, event('承認: test', 'U1', { thread_ts:'owner-ts' }), config);
  assert.equal(db.tables.gw_slack_ai_escalations[0].status, 'pending');
  assert.equal(sent.some(m => m.text.includes('社長確認済み')), false); checked++;
}
console.log('PASS: cf4c385 actual gwContext + actual scope/search pipeline, ' + checked + ' mock-only cases');

let deliveryChecks = 0;
for (const [label, change, reason] of [
  ['retired after question', db => db.tables.gw_employees[0].status = 'left', 'requester_access_changed'],
  ['unlinked after question', db => db.tables.gw_slack_ai_users = [], 'requester_access_changed'],
  ['relinked after question', db => db.tables.gw_slack_ai_users[0].employee_id = 'different-person', 'requester_access_changed'],
  ['scope reduced', db => db.tables.gw_slack_ai_escalations[0].requester_knowledge_scopes = ['all','hr'], 'requester_scopes_reduced'],
  ['legacy snapshot absent', db => delete db.tables.gw_slack_ai_escalations[0].requester_knowledge_scopes, 'requester_scope_snapshot_missing'],
  ['link read fails', db => db.failTable = 'gw_slack_ai_users', 'requester_access_check_failed'],
]) {
  reset(); const db = database();
  db.tables.gw_slack_ai_escalations = [{ ...pending(), employee_id:'emp', requester_slack_user_id:'U1', requester_knowledge_scopes:['all'] }];
  change(db);
  await processSlackEvent(db, event('承認: test', 'Uowner', { thread_ts:'owner-ts' }), config);
  assert.equal(toRequester().length, 0, label + ' must not send');
  assert.equal(toOwner().length, 1, label + ' owner is told in the owner DM');
  assert.match(toOwner()[0].text, /送信停止/);
  assert.equal(db.tables.gw_slack_ai_escalations[0].status, 'review_required', label);
  assert.equal(db.tables.gw_slack_ai_escalations[0].delivery_error, reason, label);
  // Restoration must not silently send an old approval to anyone.
  db.failTable = null;
  db.tables.gw_employees[0].status = 'active';
  db.tables.gw_slack_ai_users = [{ tenant_id:'tenant', slack_team_id:'T1', slack_user_id:'U1', employee_id:'emp' }];
  await processQueuedEvents(db, config);
  assert.equal(toRequester().length, 0, label + ' must not auto-retry');
  deliveryChecks++;
}
reset();
{
  const db = database();
  db.tables.gw_slack_ai_escalations = [{ ...pending(), employee_id:'emp', requester_slack_user_id:'U1', requester_knowledge_scopes:['all'] }];
  await processSlackEvent(db, event('承認: test', 'Uowner', { thread_ts:'owner-ts' }), config);
  assert.equal(sent.length, 1); assert.equal(sent[0].channel, 'D1');
  assert.equal(db.tables.gw_slack_ai_escalations[0].status, 'answered'); deliveryChecks++;
}
console.log('PASS: delivery revalidation, ' + deliveryChecks + ' mock-only cases');

reset();
{
  const db = database();
  db.tables.gw_role_grants = [{ employee_id:'emp', role:'hr' }];
  db.tables.gw_app_grants = [{ employee_id:'emp', app_key:'office' }];
  seedKnowledge(db); aiResult.confident = false;
  await processSlackEvent(db, event('手順の確認'), config);
  const escalation = db.tables.gw_slack_ai_escalations[0];
  assert.deepEqual(escalation.requester_knowledge_scopes, ['all','hr']);
  assert.equal(sent.length, 2, 'question escalated with scope snapshot');
  sent = []; db.tables.gw_role_grants = [];
  await processSlackEvent(db, event('承認: 人事向け回答', 'Uowner', { thread_ts:'owner-ts' }), config);
  assert.equal(toRequester().length, 0); assert.equal(escalation.status, 'review_required');
  assert.equal(escalation.delivery_error, 'requester_scopes_reduced');
}
for (const [label, change] of [
  ['role reduced during AI', db => db.tables.gw_role_grants = []],
  ['retired during AI', db => db.tables.gw_employees[0].status = 'left'],
  ['unlinked during AI', db => db.tables.gw_slack_ai_users = []],
  ['lookup fails after AI', db => db.failTable = 'gw_slack_ai_users'],
]) {
  reset(); const db = database();
  db.tables.gw_role_grants = [{ employee_id:'emp', role:'hr' }];
  db.tables.gw_app_grants = [{ employee_id:'emp', app_key:'office' }];
  seedKnowledge(db); aiResult.usedKnowledgeIds = ['hr']; onAi = () => change(db);
  db.tables.gw_slack_ai_events = [{ event_id:'E-ai', state:'queued', event_payload:event('手順の確認') }];
  assert.deepEqual(await processQueuedEvents(db, config), { processed:0, failed:1 }, label);
  assert.equal(sent.length, 0, label); assert.equal(db.tables.gw_slack_ai_events[0].state, 'failed');
}
console.log('PASS: question-to-snapshot-to-downgrade-to-approval and four immediate-answer rechecks');

// A failed persistence step must never be reported as successful processing.
for (const failFailed of [false, true]) {
  reset(); const db = database();
  seedKnowledge(db); aiResult.usedKnowledgeIds = ['all'];
  db.failDone = true; db.failFailed = failFailed;
  db.tables.gw_slack_ai_events = [{ event_id:'E-write', state:'queued', event_payload:event('手順の確認') }];
  if (failFailed) {
    await assert.rejects(processQueuedEvents(db, config), /mock_db_write_failed/);
    assert.equal(db.tables.gw_slack_ai_events[0].state, 'processing');
  } else {
    assert.deepEqual(await processQueuedEvents(db, config), { processed:0, failed:1 });
    assert.equal(db.tables.gw_slack_ai_events[0].state, 'failed');
  }
  assert.equal(sent.length, 1);
  await processQueuedEvents(db, config);
  assert.equal(sent.length, 1, 'failed/uncertain persistence must not cause automatic resend');
}
console.log('PASS: two queue persistence failure regressions');
