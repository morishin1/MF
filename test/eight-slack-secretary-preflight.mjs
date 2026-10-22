// 送信前の事前確認（Slack はモックを注入。実 Slack には接続しない）、送信 OFF 既定、自動回答 OFF 既定、
// 代表DMの解決。ID はすべて架空（T000TEST / U000OWNER など）。
import assert from 'node:assert/strict';
import { mock } from 'node:test';
let activeDb, aiResult, aiInputs = [];
mock.module('../lib/auth.js', { namedExports: { getMemberships: async () => [] } });
mock.module('../lib/supabase.js', { namedExports: { admin: () => activeDb } });
mock.module('../lib/ai-assistant.js', { namedExports: { askAssistant: async input => { aiInputs.push(input); return aiResult; } } });
const { secretaryPreflight, secretaryConfig, processSlackEvent, processQueuedEvents } = await import('../lib/eight-slack-secretary.js');
const { createSecretaryCronHandler } = await import('../api/cron/eight-secretary.js');

const TEAM = 'T000TEST', OWNER = 'U000OWNER', BOT = 'U000BOT', PBOT = 'U000PBOT', DM = 'D000OWNER', MEMBER = 'U000MEMBER';
const TENANT = 'tenant-test';
const env = (extra = {}) => ({
  SLACK_AI_TENANT_ID: TENANT, SLACK_AI_TEAM_ID: TEAM, SLACK_AI_BOT_TOKEN: 'fake-token-for-tests',
  SLACK_AI_OWNER_USER_ID: OWNER, SLACK_AI_BOT_USER_ID: BOT, SLACK_P_BOT_USER_ID: PBOT, CRON_SECRET: 'cron-test', ...extra,
});

let sent = [];
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://slack.com/api/chat.postMessage', 'only chat.postMessage may reach fetch (mocked)');
  const body = JSON.parse(options.body); sent.push(body);
  return { ok: true, json: async () => ({ ok: true, ts: '1700000000.000900', channel: body.channel }) };
};

function database() {
  const tables = {
    gw_slack_ai_users: [
      { tenant_id: TENANT, slack_team_id: TEAM, slack_user_id: OWNER, employee_id: 'emp-owner' },
      { tenant_id: TENANT, slack_team_id: TEAM, slack_user_id: MEMBER, employee_id: 'emp-member' },
    ],
    gw_employees: [
      { id: 'emp-owner', tenant_id: TENANT, status: 'active', user_id: 'user-owner', display_name: 'Owner' },
      { id: 'emp-member', tenant_id: TENANT, status: 'active', user_id: 'user-member', display_name: 'Member' },
    ],
    gw_role_grants: [{ employee_id: 'emp-owner', role: 'owner' }], gw_app_grants: [],
    gw_ai_knowledge: [{ id: 'k-all', tenant_id: TENANT, is_active: true, access_scope: 'all', title: '経費精算の手順', content: '経費精算の手順は月末締め' }],
    gw_slack_ai_escalations: [], gw_slack_ai_events: [],
  };
  const db = { tables, from(table) {
    const filters = []; let mode = 'select', values, single = false, limit = Infinity;
    const q = {
      select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; }, in(k, v) { filters.push(r => v.includes(r[k])); return q; },
      order() { return q; }, limit(n) { limit = n; return q; },
      insert(v) { mode = 'insert'; values = v; return q; }, update(v) { mode = 'update'; values = v; return q; },
      single() { single = true; return q; }, maybeSingle() { single = true; return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        let rows = tables[table].filter(r => filters.every(f => f(r))).slice(0, limit);
        if (mode === 'insert') { rows = [{ id: 'esc-' + tables[table].length, status: 'pending', ...values }]; tables[table].push(...rows); }
        if (mode === 'update') rows.forEach(r => Object.assign(r, values));
        if (single && rows.length > 1) return { data: null, error: new Error('multiple_rows') };
        return { data: single ? rows[0] || null : rows, error: null };
      }).then(resolve, reject); },
    }; return q;
  } };
  activeDb = db; return db;
}

// 正常な workspace を返すモック Slack（読み取りのみ。postMessage は持たせない）
function slack(over = {}) {
  const calls = [];
  const responses = {
    'auth.test': { ok: true, team_id: TEAM, user_id: BOT, bot_id: 'B000BOT' },
    'users.info': { ok: true, user: { id: OWNER, team_id: TEAM, deleted: false, is_bot: false, is_restricted: false, is_ultra_restricted: false } },
    'conversations.open': { ok: true, channel: { id: DM, is_im: true, user: OWNER } },
    ...over,
  };
  return { calls, call: async (method, params) => {
    calls.push([method, params]);
    assert.ok(method in responses, 'unexpected Slack method ' + method);
    const r = responses[method];
    if (r instanceof Error) throw r;
    return structuredClone(r);
  } };
}
let n = 0; const ok = label => { n++; console.log('  ok ' + label); };

// ---- 設定の既定値 ----
{
  const c = secretaryConfig(env());
  assert.equal(c.sendingEnabled, false, 'sending is OFF by default');
  assert.equal(c.autoAnswer, false, 'automatic member answers are OFF by default');
  assert.equal(c.ownerDmChannel, null, 'owner DM is unresolved until preflight');
  assert.equal(secretaryConfig(env({ SLACK_AI_SENDING_ENABLED: 'yes' })).sendingEnabled, false, 'only the exact value true enables sending');
  ok('config: sending and auto-answer default OFF; owner DM unresolved');
}

// ---- 事前確認 ----
{
  const db = database(); const s = slack();
  const r = await secretaryPreflight(s, db, secretaryConfig(env()));
  assert.deepEqual(r, { ok: true, ownerDmChannel: DM, botUserId: BOT });
  assert.deepEqual(s.calls.map(c => c[0]), ['auth.test', 'users.info', 'conversations.open']);
  assert.deepEqual(s.calls[2][1], { users: OWNER, return_im: true }, 'DM is opened for the owner alone');
  assert.equal(sent.length, 0, 'preflight sends no message');
  ok('preflight: passes and resolves this bot\'s own 1:1 DM with the owner');
}
const im = extra => ({ ok: true, channel: { id: DM, is_im: true, user: OWNER, ...extra } });
for (const [label, over, envExtra, dbChange, reason] of [
  ['other workspace token', { 'auth.test': { ok: true, team_id: 'T000OTHER', user_id: BOT, bot_id: 'B1' } }, {}, null, 'team_mismatch'],
  ['different bot identity', { 'auth.test': { ok: true, team_id: TEAM, user_id: 'U000OTHERBOT', bot_id: 'B1' } }, {}, null, 'bot_identity_mismatch'],
  ['existing P bot token reused', { 'auth.test': { ok: true, team_id: TEAM, user_id: PBOT, bot_id: 'B1' } }, { SLACK_AI_BOT_USER_ID: PBOT }, null, 'existing_p_bot_token'],
  ['user token instead of bot', { 'auth.test': { ok: true, team_id: TEAM, user_id: BOT } }, {}, null, 'bot_identity_mismatch'],
  ['bot user not configured', {}, { SLACK_AI_BOT_USER_ID: '' }, null, 'bot_user_not_configured'],
  ['auth.test fails', { 'auth.test': { ok: false, error: 'invalid_auth' } }, {}, null, 'auth_test_failed'],
  ['owner in other workspace', { 'users.info': { ok: true, user: { id: OWNER, team_id: 'T000OTHER' } } }, {}, null, 'owner_other_team'],
  ['owner deactivated', { 'users.info': { ok: true, user: { id: OWNER, team_id: TEAM, deleted: true } } }, {}, null, 'owner_not_active_member'],
  ['owner is a guest', { 'users.info': { ok: true, user: { id: OWNER, team_id: TEAM, is_restricted: true } } }, {}, null, 'owner_not_active_member'],
  ['owner lookup missing scope', { 'users.info': { ok: false, error: 'missing_scope' } }, {}, null, 'owner_lookup_failed'],
  ['owner not linked in GW', {}, {}, db => { db.tables.gw_slack_ai_users.shift(); }, 'owner_gw_mapping_invalid'],
  ['owner link revoked', {}, {}, db => { db.tables.gw_slack_ai_users[0].revoked_at = '2026-01-01T00:00:00Z'; }, 'owner_gw_mapping_invalid'],
  ['owner lacks GW owner role', {}, {}, db => { db.tables.gw_role_grants = []; }, 'owner_gw_mapping_invalid'],
  ['configured owner is a member', {}, { SLACK_AI_OWNER_USER_ID: MEMBER }, null, 'owner_mismatch'],
  ['DM open not permitted', { 'conversations.open': { ok: false, error: 'missing_scope' } }, {}, null, 'owner_dm_open_failed'],
  ['resolved to a group DM', { 'conversations.open': im({ is_im: false, is_mpim: true }) }, {}, null, 'owner_dm_not_one_to_one'],
  ['resolved DM is with someone else', { 'conversations.open': im({ user: MEMBER }) }, {}, null, 'owner_dm_not_one_to_one'],
  ['configured DM ID belongs elsewhere (e.g. P bot DM)', {}, { SLACK_AI_OWNER_DM_CHANNEL_ID: 'D000PBOTDM' }, null, 'owner_dm_id_mismatch'],
  ['Slack network error', { 'auth.test': new Error('network') }, {}, null, 'preflight_error'],
]) {
  const db = database(); if (dbChange) dbChange(db);
  const cfg = secretaryConfig(env(envExtra));
  if (label === 'configured owner is a member') {
    // 設定の代表IDと Slack 上の利用者が一致しない（users.info は別人を返す）
    const r = await secretaryPreflight(slack({ 'users.info': { ok: true, user: { id: OWNER, team_id: TEAM } } }), db, cfg);
    assert.equal(r.ok, false); assert.equal(r.reason, 'owner_mismatch', label);
  } else {
    const r = await secretaryPreflight(slack(over), db, cfg);
    assert.equal(r.ok, false, label); assert.equal(r.reason, reason, label);
  }
  assert.equal(sent.length, 0, label + ' sends nothing');
  ok('preflight refuses: ' + label);
}
{
  const r = await secretaryPreflight(slack(), database(), secretaryConfig(env({ SLACK_AI_OWNER_DM_CHANNEL_ID: DM })));
  assert.equal(r.ok, true); assert.equal(r.ownerDmChannel, DM);
  ok('preflight: a configured DM ID is accepted only when it is this bot\'s DM with the owner');
}

// ---- Cron: OFF 既定、事前確認失敗で保留 ----
function cronRequest(handler) {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = v; } };
  return handler({ method: 'GET', headers: { authorization: 'Bearer cron-test' } }, res).then(() => ({ ...res, json: JSON.parse(res.body) }));
}
const queued = db => { db.tables.gw_slack_ai_events = [{ event_id: 'Ev1', state: 'queued', event_payload: { team_id: TEAM, event: {
  type: 'message', channel_type: 'im', user: MEMBER, channel: 'D000MEMBER', ts: '1700000000.000100', text: '経費精算の手順は？' } } }]; };
{
  const db = database(); queued(db); let slackMade = 0;
  const res = await cronRequest(createSecretaryCronHandler({ getAdmin: () => db, env: () => env(), slackClient: () => { slackMade++; return slack(); } }));
  assert.equal(res.json.disabled, 'sending_disabled'); assert.equal(slackMade, 0);
  assert.equal(db.tables.gw_slack_ai_events[0].state, 'queued'); assert.equal(sent.length, 0);
  ok('cron: sending OFF by default → no Slack call, queue untouched');
}
{
  const db = database(); queued(db);
  db.tables.gw_slack_ai_escalations = [{ id: 'esc-held', tenant_id: TENANT, status: 'approved_pending_delivery' }];
  const res = await cronRequest(createSecretaryCronHandler({ getAdmin: () => db, env: () => env({ SLACK_AI_SENDING_ENABLED: 'true' }),
    slackClient: () => slack({ 'conversations.open': im({ user: MEMBER }) }) }));
  assert.equal(res.statusCode, 503); assert.equal(res.json.reason, 'owner_dm_not_one_to_one');
  assert.equal(db.tables.gw_slack_ai_events[0].state, 'queued'); assert.equal(db.tables.gw_slack_ai_escalations[0].status, 'approved_pending_delivery');
  assert.equal(sent.length, 0);
  ok('cron: preflight failure holds events and approved answers, sends nothing');
}
{
  const db = database(); queued(db); aiResult = { confident: true, usedKnowledgeIds: ['k-all'], answer: '月末締めです' }; aiInputs = [];
  const res = await cronRequest(createSecretaryCronHandler({ getAdmin: () => db, env: () => env({ SLACK_AI_SENDING_ENABLED: 'true' }), slackClient: () => slack() }));
  assert.equal(res.statusCode, 200); assert.equal(res.json.processed, 1);
  // 自動回答 OFF（既定）：資料で答えられても社員には送らず、代表DMへ回答案と宛先を出して承認を待つ
  const esc = db.tables.gw_slack_ai_escalations[0];
  assert.equal(esc.ai_draft_answer, '月末締めです'); assert.equal(esc.owner_dm_channel, DM); assert.equal(esc.status, 'pending');
  const ownerMsg = sent.find(m => m.channel === DM);
  assert.match(ownerMsg.text, /AI回答案/); assert.match(ownerMsg.text, /質問者: Member/);
  assert.equal(sent.some(m => m.channel === OWNER), false, 'never posts to the owner user ID / another app DM');
  assert.equal(sent.some(m => m.channel === 'D000MEMBER' && /AI回答|社長確認済み/.test(m.text)), false, 'no member-facing answer before approval');
  // 承認（宛先＋本文）後にだけ社員へ送る
  sent = [];
  await processSlackEvent(db, { team_id: TEAM, event: { type: 'message', channel_type: 'im', user: OWNER, channel: DM,
    ts: '1700000001.000000', thread_ts: esc.owner_dm_ts, text: '承認: 月末締めです' } }, { ...secretaryConfig(env()), ownerDmChannel: DM, approvalHoldMs: 0 });
  assert.equal(esc.status, 'answered');
  assert.deepEqual(sent.filter(m => m.channel === 'D000MEMBER').map(m => m.text), ['【社長確認済み】\n月末締めです']);
  ok('auto-answer OFF: draft goes to the owner DM only; member gets it only after approval');
}
{
  sent = [];
  const db = database();
  db.tables.gw_slack_ai_escalations = [{ id: 'esc-x', tenant_id: TENANT, status: 'pending', owner_dm_ts: '1700000000.000900', owner_dm_channel: DM }];
  // 代表本人でも、この Bot との検証済みDM以外（例: 別 App の DM）での「承認:」は承認にならない
  await processSlackEvent(db, { team_id: TEAM, event: { type: 'message', channel_type: 'im', user: OWNER, channel: 'D000PBOTDM',
    ts: '1700000001.000000', thread_ts: '1700000000.000900', text: '承認: x' } }, { ...secretaryConfig(env()), ownerDmChannel: DM, approvalHoldMs: 0 });
  assert.equal(db.tables.gw_slack_ai_escalations[0].status, 'pending'); assert.equal(sent.length, 0);
  await assert.rejects(processQueuedEvents(db, secretaryConfig(env({ SLACK_AI_SENDING_ENABLED: 'true' }))), /owner_dm_unresolved/);
  await assert.rejects(processQueuedEvents(db, { ...secretaryConfig(env()), ownerDmChannel: DM }), /sending_disabled/);
  ok('owner path: approvals only in the verified bot DM; worker refuses without preflight or with sending OFF');
}
console.log('PASS: preflight / sending-off / auto-answer-off, ' + n + ' mock-only cases');
