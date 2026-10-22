// Slack bot for employee-facing EIGHT secretary. Service-role DB access is strictly limited.
// Unlike the owner's Dots, this bot only sees knowledge in the requesting employee's
// existing GW-authorized scopes.
import crypto from 'node:crypto';
import { gwContext, canManageHr, canAccessOffice } from './gw.js';
import { allowedKnowledgeScopes, searchKnowledge } from './ai-knowledge.js';
import { askAssistant } from './ai-assistant.js';

export function verifySlackSignature(raw, headers, secret, now = Date.now()) {
  const ts = String(headers['x-slack-request-timestamp'] || '');
  const sig = String(headers['x-slack-signature'] || '');
  if (!secret || !/^\d+$/.test(ts) || !/^v0=[0-9a-f]{64}$/i.test(sig)) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const digest = 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + ts + ':' + raw).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
}

export async function slackPost(token, channel, text, threadTs) {
  const body = {
    channel,
    text,
    mrkdwn: false,
    parse: 'none',
    unfurl_links: false,
    unfurl_media: false,
  };
  if (threadTs) body.thread_ts = threadTs;
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('slack_http_' + response.status);
  const json = await response.json();
  if (!json.ok || !json.ts) throw new Error('slack_' + (json.error || 'send_failed'));
  return json;
}

export function requiresOwnerDecision(question) {
  return /承認|決裁|値引|割引|採用|内定|給与|昇給|賞与|人事評価|契約(?!書の場所)|発注|受注|購入|支払|振込|返金|解雇|退職|人事異動|顧客情報|個人情報|森田|社長|社外公開|公開許可|経営判断|法的判断|訴訟/.test(String(question || ''));
}

export function approvedReply(text) {
  const m = String(text || '').match(/^\s*承認\s*[:：]\s*([\s\S]{1,3000})\s*$/);
  const answer = m?.[1]?.trim();
  return answer || null;
}

async function requireLinkedEmployee(sb, teamId, slackUserId, tenantId) {
  const { data: link, error } = await sb.from('gw_slack_ai_users')
    .select('tenant_id, employee_id').eq('slack_team_id', teamId)
    .eq('slack_user_id', slackUserId).maybeSingle();
  if (error) throw error;
  if (!link || link.tenant_id !== tenantId) return null;
  const { data: emp, error: empError } = await sb.from('gw_employees')
    .select('id, display_name, tenant_id, status, user_id')
    .eq('id', link.employee_id).eq('tenant_id', tenantId).maybeSingle();
  if (empError) throw empError;
  if (!emp || emp.status !== 'active' || !emp.user_id) return null;
  const ctx = await gwContext(emp.user_id);
  if (ctx.tenantId !== tenantId || ctx.employee?.id !== emp.id) return null;
  return {
    ...emp,
    knowledgeScopes: allowedKnowledgeScopes(ctx, canManageHr, canAccessOffice),
  };
}

async function processApproval(sb, event, config) {
  const answer = approvedReply(event.text);
  if (!answer || !event.thread_ts) return false;
  const { data: esc, error } = await sb.from('gw_slack_ai_escalations')
    .select('id, requester_channel, requester_thread_ts, status')
    .eq('tenant_id', config.tenantId).eq('owner_dm_ts', event.thread_ts)
    .eq('status', 'pending').maybeSingle();
  if (error) throw error;
  if (!esc) return false;
  const { data: changed, error: updateError } = await sb.from('gw_slack_ai_escalations')
    .update({ status: 'approved_pending_delivery', approved_answer: answer })
    .eq('id', esc.id).eq('status', 'pending').select('id').maybeSingle();
  if (updateError) throw updateError;
  if (!changed) return true;
  // The human's explicit '承認:' is the only route to a CEO-approved answer.
  await deliverApproval(sb, esc.id, config);
  return true;
}

async function deliverApproval(sb, id, config) {
  const { data: row, error } = await sb.from('gw_slack_ai_escalations')
    .update({ status: 'delivery_attempted', delivery_attempted_at: new Date().toISOString() })
    .eq('tenant_id', config.tenantId).eq('id', id)
    .eq('status', 'approved_pending_delivery')
    .select('id, requester_channel, requester_thread_ts, approved_answer').maybeSingle();
  if (error) throw error;
  if (!row) return;
  try {
    await slackPost(config.botToken, row.requester_channel,
      '【社長確認済み】\n' + row.approved_answer, row.requester_thread_ts);
  } catch (sendError) {
    // A failed HTTP response can be ambiguous: Slack may have accepted the message.
    // Keep it out of the automatic retry path and require an operator to reconcile it.
    await sb.from('gw_slack_ai_escalations').update({
      status: 'delivery_uncertain',
      delivery_error: String(sendError?.message || sendError).slice(0, 150),
    }).eq('id', row.id).eq('status', 'delivery_attempted');
    throw sendError;
  }
  const { error: e } = await sb.from('gw_slack_ai_escalations').update({
    status: 'answered', answered_at: new Date().toISOString(),
  }).eq('id', row.id).eq('status', 'delivery_attempted');
  if (e) throw e;
}

export async function processSlackEvent(sb, outer, config) {
  const e = outer.event || {};
  if (e.type !== 'message' || e.channel_type !== 'im' || !e.user || !e.channel || !e.ts || e.subtype || e.bot_id) return;
  if (outer.team_id !== config.teamId) return;
  if (e.user === config.ownerSlackId && approvedReply(e.text)) {
    if (e.thread_ts && await processApproval(sb, e, config)) return;
    await slackPost(config.botToken, e.channel,
      '承認する場合は、EIGHT秘書から届いた社長判断依頼のスレッド内で「承認: 回答本文」と返信してください。',
      e.thread_ts || e.ts);
    return; // Stray approvals are never mistaken for ordinary questions.
  }
  const employee = await requireLinkedEmployee(sb, outer.team_id, e.user, config.tenantId);
  if (!employee) {
    await slackPost(config.botToken, e.channel, 'EIGHT秘書です。GWの在籍社員として本人確認が完了していません。管理者にSlack連携を依頼してください。', e.thread_ts || e.ts);
    return;
  }
  if (e.too_long || String(e.text || '').length > 4000) {
    await slackPost(config.botToken, e.channel,
      '質問が長すぎます。4,000文字以内に分けて送ってください。', e.thread_ts || e.ts);
    return;
  }
  const question = String(e.text || '').trim();
  if (!question) return;
  // Reuse the requester's existing GW role-derived knowledge scopes. Never query other employees' records.
  const knowledge = await searchKnowledge(sb, { tenantId: config.tenantId, scopes: employee.knowledgeScopes, query: question, limit: 5 });
  let result = { confident: false, usedKnowledgeIds: [], answer: '' };
  if (knowledge.length && !requiresOwnerDecision(question)) {
    try { result = await askAssistant({ question, knowledgeRows: knowledge, suggestImprovements: true }); }
    catch { result = { confident: false, usedKnowledgeIds: [], answer: '' }; }
  }
  if (result.confident && result.usedKnowledgeIds?.length && !requiresOwnerDecision(question)) {
    const refs = knowledge.filter(k => result.usedKnowledgeIds.includes(k.id)).map(k => k.title).slice(0, 3);
    const reference = refs.length ? '\n参考: ' + refs.join('、') : '';
    await slackPost(config.botToken, e.channel, '【EIGHT秘書・AI回答】\n' + String(result.answer).slice(0, 3000) + reference, e.thread_ts || e.ts);
    return;
  }
  // Fail closed: unknown company policy or judgment calls wait for a person.
  const { data: esc, error: escError } = await sb.from('gw_slack_ai_escalations').insert({
    tenant_id: config.tenantId, employee_id: employee.id, requester_slack_user_id: e.user,
    requester_channel: e.channel, requester_thread_ts: e.thread_ts || e.ts, question,
  }).select('id').single();
  if (escError) throw escError;
  const owner = await slackPost(config.botToken, config.ownerSlackId,
    '【EIGHT秘書｜社長判断待ち】\n質問者: ' + employee.display_name
      + '\n質問: ' + question
      + '\n\n回答する場合は、このメッセージのスレッドで「承認: 回答本文」と送ってください。未承認の間は社員へ正式回答しません。');
  const { error: updateErr } = await sb.from('gw_slack_ai_escalations')
    .update({ owner_dm_ts: owner.ts }).eq('id', esc.id);
  if (updateErr) throw updateErr;
  await slackPost(config.botToken, e.channel, '【EIGHT秘書】\n社内資料だけでは判断できないため、社長へ確認を依頼しました。回答が届くまでお待ちください。', e.thread_ts || e.ts);
}

export async function processQueuedEvents(sb, config, limit = 10) {
  const { data: events, error } = await sb.from('gw_slack_ai_events')
    .select('event_id, event_payload').eq('state', 'queued')
    .order('received_at', { ascending: true }).limit(limit);
  if (error) throw error;
  let processed = 0, failed = 0;
  for (const item of events || []) {
    const { data: claimed, error: claimError } = await sb.from('gw_slack_ai_events')
      .update({ state: 'processing' }).eq('event_id', item.event_id).eq('state', 'queued')
      .select('event_id').maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;
    try {
      await processSlackEvent(sb, item.event_payload, config);
      await sb.from('gw_slack_ai_events').update({ state: 'done', processed_at: new Date().toISOString(), event_payload: {} }).eq('event_id', item.event_id);
      processed++;
    } catch (err) {
      // Failures remain inspectable; do not auto-retry a potentially delivered message.
      await sb.from('gw_slack_ai_events').update({ state: 'failed', last_error: String(err?.message || err).slice(0, 150) }).eq('event_id', item.event_id);
      failed++;
    }
  }
  // Recover approvals that have not yet attempted a delivery. Attempted deliveries are never
  // retried automatically because a timeout can occur after Slack accepted the message.
  const { data: undelivered, error: retryError } = await sb.from('gw_slack_ai_escalations')
    .select('id').eq('tenant_id', config.tenantId)
    .eq('status', 'approved_pending_delivery').limit(10);
  if (retryError) throw retryError;
  for (const row of undelivered || []) {
    try { await deliverApproval(sb, row.id, config); }
    catch (err) { console.warn('[slack-secretary] approved delivery pending:', String(err?.message || err).slice(0,100)); }
  }
  return { processed, failed };
}

export function secretaryConfig(env = process.env) {
  const cfg = { tenantId: env.SLACK_AI_TENANT_ID, teamId: env.SLACK_AI_TEAM_ID, botToken: env.SLACK_AI_BOT_TOKEN, ownerSlackId: env.SLACK_AI_OWNER_USER_ID };
  if (Object.values(cfg).some(v => !v)) throw new Error('slack_ai_not_configured');
  return cfg;
}
