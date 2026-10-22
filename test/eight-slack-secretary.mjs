// Security regression tests for EIGHT Slack AI secretary.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySlackSignature, requiresOwnerDecision, approvedReply } from '../lib/eight-slack-secretary.js';

const raw = JSON.stringify({ type: 'event_callback', team_id: 'T123' });
const ts = Math.floor(Date.now() / 1000).toString();
const secret = 'local-test-secret';
const sig = 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + ts + ':' + raw).digest('hex');

assert.equal(verifySlackSignature(raw, {
  'x-slack-request-timestamp': ts, 'x-slack-signature': sig,
}, secret), true, 'valid Slack signature passes');
assert.equal(verifySlackSignature(raw + ' ', {
  'x-slack-request-timestamp': ts, 'x-slack-signature': sig,
}, secret), false, 'tampered payload rejected');
assert.equal(verifySlackSignature(raw, {
  'x-slack-request-timestamp': String(Number(ts) - 301), 'x-slack-signature': sig,
}, secret), false, 'replay rejected');
assert.equal(verifySlackSignature(raw, {
  'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=nope',
}, secret), false, 'invalid digest rejected');
assert.equal(requiresOwnerDecision('値引きを承認してください'), true);
assert.equal(requiresOwnerDecision('今日の日報の書き方は？'), false);
assert.equal(approvedReply('承認: この条件でお願いします'), 'この条件でお願いします');
assert.equal(approvedReply('了解です'), null);
assert.equal(approvedReply('承認: '), null);
console.log('ok - Slack authentication and CEO approval rules');
