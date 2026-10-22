// Slack bot for employee-facing EIGHT secretary. Service-role DB access is strictly limited.
// Unlike the owner's Dots, this bot only sees knowledge in the requesting employee's
// existing GW-authorized scopes.
import crypto from 'node:crypto';
import { gwContext, canManageHr, canAccessOffice } from './gw.js';
import { allowedKnowledgeScopes, searchKnowledge } from './ai-knowledge.js';
import { askAssistant } from './ai-assistant.js';

// 代表の「承認:」を受けてから社員へ送るまでの待ち時間。この間に承認メッセージが
// 編集・削除されたら承認を取り消す（送信しない）。Cron は1分周期なので実際は1〜2分。
export const DEFAULT_APPROVAL_HOLD_MS = 60_000;

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

// Slack の ts（"1700000000.000100"）を比較する。数値にすると桁落ちするので秒と端数で比べる。
export function compareSlackTs(a, b) {
  const parse = v => {
    const m = String(v || '').match(/^(\d+)(?:\.(\d{1,6}))?$/);
    return m ? [BigInt(m[1]), BigInt((m[2] || '').padEnd(6, '0'))] : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  return 0;
}

// 承認を「どの質問者へ・どの質問への・どの本文で・どの承認メッセージで」に結び付ける。
// 承認後にこのどれかが DB 上で変わったら、送信直前の再計算が一致せず送信しない。
export function approvalBindingHash(row) {
  const bound = [
    row.id, row.tenant_id, row.employee_id, row.requester_slack_user_id,
    row.requester_channel, row.requester_thread_ts,
    Array.isArray(row.requester_knowledge_scopes) ? row.requester_knowledge_scopes : null,
    row.question, row.owner_dm_channel, row.owner_dm_ts, row.approval_ts, row.approved_answer,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}

const ESCALATION_FIELDS = 'id, tenant_id, employee_id, requester_slack_user_id, requester_channel, '
  + 'requester_thread_ts, requester_knowledge_scopes, question, owner_dm_channel, owner_dm_ts, status, '
  + 'approved_answer, approval_ts, approved_at, approval_hash, approval_invalidated_ts';

const CLEARED_APPROVAL = { approved_answer: null, approval_ts: null, approved_at: null, approval_hash: null };

const STATUS_LABEL = {
  pending: '承認待ち',
  approved_pending_delivery: '承認済み・送信待ち',
  delivery_attempted: '送信処理中',
  delivery_uncertain: '送信結果不明（自動再送しません）',
  review_required: '送信停止・管理者確認待ち',
  answered: '回答送信済み',
};

function holdMs(config) {
  const v = Number(config.approvalHoldMs);
  return config.approvalHoldMs != null && Number.isFinite(v) && v >= 0 ? v : DEFAULT_APPROVAL_HOLD_MS;
}

// 代表向けの報告は代表のSlack DM（判断依頼のスレッド）だけに送る。通知の失敗で
// 承認状態を変えたり、社員へ送ったりはしない。
async function notifyOwner(config, esc, text) {
  try {
    await slackPost(config.botToken, esc?.owner_dm_channel || requireOwnerDm(config), text, esc?.owner_dm_ts || undefined);
  } catch (err) {
    console.warn('[slack-secretary] owner notice failed:', String(err?.message || err).slice(0, 100));
  }
}

// 代表への報告先は、この Bot 自身と代表の1対1 DM（事前確認 secretaryPreflight で解決・検証したもの）だけ。
// 既存の P Bot など別 App の DM ID や、代表のユーザーIDへの直接送信には頼らない。
function requireOwnerDm(config) {
  if (!config.ownerDmChannel) throw new Error('owner_dm_unresolved');
  return config.ownerDmChannel;
}

async function requireLinkedEmployee(sb, teamId, slackUserId, tenantId) {
  const { data: link, error } = await sb.from('gw_slack_ai_users')
    .select('tenant_id, employee_id, revoked_at').eq('slack_team_id', teamId)
    .eq('slack_user_id', slackUserId).maybeSingle();
  if (error) throw error;
  // 明示した Slack ID ↔ GW 社員の紐付けだけを使う。表示名では決めない。失効済みは拒否。
  if (!link || link.tenant_id !== tenantId || link.revoked_at) return null;
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
    roles: Array.isArray(ctx.roles) ? ctx.roles : [],
  };
}

async function findEscalationByOwnerThread(sb, config, channel, threadTs) {
  const { data: esc, error } = await sb.from('gw_slack_ai_escalations')
    .select(ESCALATION_FIELDS)
    .eq('tenant_id', config.tenantId).eq('owner_dm_ts', threadTs).maybeSingle();
  if (error) throw error;
  // 判断依頼を送った代表DMのスレッドでなければ承認として扱わない。
  if (!esc || !esc.owner_dm_channel || esc.owner_dm_channel !== channel) return null;
  return esc;
}

// 承認を取り消して「承認待ち」に戻す。invalidTs 以前の承認メッセージは以後も受け付けない。
async function invalidateApproval(sb, esc, fromStatus, reason, invalidTs) {
  const prev = esc.approval_invalidated_ts;
  const latest = prev && compareSlackTs(prev, invalidTs) === 1 ? prev : invalidTs;
  let query = sb.from('gw_slack_ai_escalations').update({
    status: 'pending', ...CLEARED_APPROVAL, approval_invalidated_ts: latest, delivery_error: reason,
  }).eq('id', esc.id).eq('status', fromStatus);
  if (esc.approval_hash) query = query.eq('approval_hash', esc.approval_hash);
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw error;
  return !!data;
}

async function processApproval(sb, event, config) {
  const answer = approvedReply(event.text);
  if (!answer || !event.thread_ts) return false;
  const esc = await findEscalationByOwnerThread(sb, config, event.channel, event.thread_ts);
  if (!esc) return false;
  if (esc.approval_invalidated_ts && compareSlackTs(event.ts, esc.approval_invalidated_ts) !== 1) {
    await notifyOwner(config, esc, '【EIGHT秘書】この承認メッセージは編集・削除または重複により取り消し済みです。社員へは送信していません。改めてこのスレッドに新しく「承認: 回答本文」を送ってください。');
    return true;
  }
  if (esc.status === 'approved_pending_delivery') {
    if (esc.approval_ts === event.ts) return true; // 同じ承認メッセージの再処理
    // 送信前に別の承認が届いた：どちらが最終か判断できないので両方取り消して送らない。
    const laterTs = compareSlackTs(event.ts, esc.approval_ts) === 1 ? event.ts : esc.approval_ts;
    if (await invalidateApproval(sb, esc, 'approved_pending_delivery', 'approval_conflict', laterTs)) {
      await notifyOwner(config, esc, '【EIGHT秘書｜承認取消】\n同じ依頼に承認が複数届いたため、どちらも社員へ送信していません。最終の回答を1件だけ、このスレッドに新しく「承認: 回答本文」で送ってください。');
    }
    return true;
  }
  if (esc.status !== 'pending') {
    await notifyOwner(config, esc, '【EIGHT秘書】この依頼は既に「' + (STATUS_LABEL[esc.status] || esc.status)
      + '」です。今回の承認は社員へ送信していません。訂正が必要な場合は管理者に連絡してください。');
    return true;
  }
  const approvalHash = approvalBindingHash({ ...esc, approved_answer: answer, approval_ts: event.ts });
  const { data: changed, error: updateError } = await sb.from('gw_slack_ai_escalations')
    .update({
      status: 'approved_pending_delivery', approved_answer: answer, approval_ts: event.ts,
      approved_at: new Date().toISOString(), approval_hash: approvalHash, delivery_error: null,
    })
    .eq('id', esc.id).eq('status', 'pending').select('id').maybeSingle();
  if (updateError) throw updateError;
  if (!changed) return true;
  // The human's explicit '承認:' is the only route to a CEO-approved answer.
  if (holdMs(config) === 0) {
    await deliverApproval(sb, esc.id, config);
  } else {
    await notifyOwner(config, esc, '【EIGHT秘書】承認を受け付けました。約1〜2分後に質問者へ送信します。'
      + 'それまでにこの承認メッセージを編集・削除すると承認を取り消し、送信しません。');
  }
  return true;
}

// 代表が承認メッセージを編集・削除したとき：送信前なら承認を取り消す。送信後なら代表へ知らせる。
async function processOwnerApprovalEdit(sb, e, config) {
  if (!e.edited_ts) return;
  if (e.subtype === 'message_changed' && !e.text_changed) return; // 本文が同じ（リンク展開など）
  const verb = e.subtype === 'message_deleted' ? '削除' : '編集';
  const { data: byApproval, error } = await sb.from('gw_slack_ai_escalations')
    .select(ESCALATION_FIELDS)
    .eq('tenant_id', config.tenantId).eq('owner_dm_channel', e.channel)
    .eq('approval_ts', e.edited_ts).maybeSingle();
  if (error) throw error;
  if (byApproval && byApproval.owner_dm_channel === e.channel) {
    if (byApproval.status === 'approved_pending_delivery') {
      const reason = e.subtype === 'message_deleted' ? 'approval_deleted' : 'approval_edited';
      if (await invalidateApproval(sb, byApproval, 'approved_pending_delivery', reason, e.edited_ts)) {
        await notifyOwner(config, byApproval, '【EIGHT秘書｜承認取消】\n承認メッセージが' + verb
          + 'されたため承認を取り消しました。社員へは送信していません。送る場合は、このスレッドに新しく「承認: 回答本文」を送ってください。');
      }
      return;
    }
    if (['delivery_attempted', 'delivery_uncertain', 'answered'].includes(byApproval.status)) {
      await notifyOwner(config, byApproval, '【EIGHT秘書】承認メッセージが' + verb + 'されましたが、既に「'
        + STATUS_LABEL[byApproval.status] + '」のため' + verb + '後の内容は社員へ送っていません。'
        + '訂正が必要な場合は、管理者が送信内容を確認したうえで対応してください。');
    }
    return;
  }
  // 承認がまだ処理されていない（または処理に失敗した）スレッド：編集前の承認を後から使わない。
  if (!e.thread_ts || !(e.was_approval || e.is_approval)) return;
  const esc = await findEscalationByOwnerThread(sb, config, e.channel, e.thread_ts);
  if (!esc || esc.status !== 'pending') return;
  if (esc.approval_invalidated_ts && compareSlackTs(esc.approval_invalidated_ts, e.edited_ts) !== -1) return;
  const { data: marked, error: markError } = await sb.from('gw_slack_ai_escalations')
    .update({ approval_invalidated_ts: e.edited_ts, delivery_error: 'approval_edited' })
    .eq('id', esc.id).eq('status', 'pending').select('id').maybeSingle();
  if (markError) throw markError;
  if (marked) {
    await notifyOwner(config, esc, '【EIGHT秘書】' + verb + 'された承認メッセージは使いません。社員へは送信していません。'
      + '送る場合は、このスレッドに新しく「承認: 回答本文」を送ってください。');
  }
}

async function markReviewRequired(sb, row, reason, config) {
  const { error } = await sb.from('gw_slack_ai_escalations').update({
    status: 'review_required', delivery_error: reason,
  }).eq('id', row.id).eq('status', 'delivery_attempted');
  if (error) throw error;
  await notifyOwner(config, row, '【EIGHT秘書｜送信停止】\n承認済みの回答を質問者へ送信していません（理由: ' + reason
    + '）。自動再送はしません。管理者が質問者・宛先・回答内容を確認してください。');
}

async function deliverApproval(sb, id, config) {
  const { data: current, error: readError } = await sb.from('gw_slack_ai_escalations')
    .select(ESCALATION_FIELDS)
    .eq('tenant_id', config.tenantId).eq('id', id)
    .eq('status', 'approved_pending_delivery').maybeSingle();
  if (readError) throw readError;
  if (!current) return;
  const hold = holdMs(config);
  if (hold > 0) {
    const approvedAt = Date.parse(current.approved_at || '');
    // 承認時刻が読めない行は待たせず、下の結び付け確認で review_required にする。
    if (Number.isFinite(approvedAt) && Date.now() - approvedAt < hold) return; // まだ取消の猶予中
  }
  // 編集で取り消し→再承認された場合、古い読み取り結果では送らない（承認ハッシュで CAS）。
  let claim = sb.from('gw_slack_ai_escalations')
    .update({ status: 'delivery_attempted', delivery_attempted_at: new Date().toISOString() })
    .eq('tenant_id', config.tenantId).eq('id', id)
    .eq('status', 'approved_pending_delivery');
  if (current.approval_hash) claim = claim.eq('approval_hash', current.approval_hash);
  const { data: row, error } = await claim.select(ESCALATION_FIELDS).maybeSingle();
  if (error) throw error;
  if (!row) return;
  // 承認と、質問者・宛先・質問・回答本文の結び付けを送信直前に再計算する。
  if (!row.approval_hash || !row.approval_ts || !row.approved_answer) {
    return markReviewRequired(sb, row, 'approval_binding_missing', config);
  }
  if (approvalBindingHash(row) !== row.approval_hash) {
    return markReviewRequired(sb, row, 'approval_binding_mismatch', config);
  }
  // Approval can wait while a requester leaves, is relinked, or loses privileges.
  // Never redirect an old approval to a newly linked person/channel.
  let reviewReason = null;
  try {
    const employee = await requireLinkedEmployee(sb, config.teamId, row.requester_slack_user_id, config.tenantId);
    if (!employee || employee.id !== row.employee_id) reviewReason = 'requester_access_changed';
    else if (!Array.isArray(row.requester_knowledge_scopes) || !row.requester_knowledge_scopes.length) {
      reviewReason = 'requester_scope_snapshot_missing';
    } else if (row.requester_knowledge_scopes.some(scope => !employee.knowledgeScopes.includes(scope))) {
      reviewReason = 'requester_scopes_reduced';
    }
  } catch {
    reviewReason = 'requester_access_check_failed';
  }
  if (reviewReason) {
    // No send and no automatic retry, even if access is later restored.
    return markReviewRequired(sb, row, reviewReason, config);
  }
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
    await notifyOwner(config, row, '【EIGHT秘書｜送信結果不明】\n承認済みの回答の送信結果を確認できませんでした。'
      + '二重送信を避けるため自動再送はしません。管理者がSlack上で質問者DMへの到達を確認してください。');
    throw sendError;
  }
  const { error: e } = await sb.from('gw_slack_ai_escalations').update({
    status: 'answered', answered_at: new Date().toISOString(),
  }).eq('id', row.id).eq('status', 'delivery_attempted');
  if (e) throw e;
}

export async function processSlackEvent(sb, outer, config) {
  const e = outer.event || {};
  if (e.type !== 'message' || e.channel_type !== 'im' || !e.user || !e.channel || !e.ts || e.bot_id) return;
  if (outer.team_id !== config.teamId) return;
  if (e.subtype) {
    // 編集・削除は代表の承認メッセージの取消判定にだけ使う。社員の編集は質問として扱わない。
    if ((e.subtype === 'message_changed' || e.subtype === 'message_deleted') && e.user === config.ownerSlackId) {
      await processOwnerApprovalEdit(sb, e, config);
    }
    return;
  }
  if (e.user === config.ownerSlackId && approvedReply(e.text)) {
    // 承認は、この Bot と代表の検証済み1対1 DM の中だけで受け付ける。
    if (e.channel !== requireOwnerDm(config)) return;
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
  // 質問文・資料本文に「権限を付与」「管理者として」等が書かれていても、スコープは DB の権限からだけ決める。
  const knowledge = await searchKnowledge(sb, { tenantId: config.tenantId, scopes: employee.knowledgeScopes, query: question, limit: 5 });
  let result = { confident: false, usedKnowledgeIds: [], answer: '' };
  if (knowledge.length && !requiresOwnerDecision(question)) {
    try { result = await askAssistant({ question, knowledgeRows: knowledge, suggestImprovements: true }); }
    catch { result = { confident: false, usedKnowledgeIds: [], answer: '' }; }
  }
  const answerable = result.confident && result.usedKnowledgeIds?.length && !requiresOwnerDecision(question);
  if (answerable && config.autoAnswer === true) {
    // AI work can outlive a role/link change. Recheck before releasing its answer.
    // The queue records a failure for operator review; never disclose the answer
    // (or redirect it) when identity or the original scopes cannot be confirmed.
    const latest = await requireLinkedEmployee(sb, config.teamId, e.user, config.tenantId);
    if (!latest || latest.id !== employee.id || latest.user_id !== employee.user_id) {
      throw new Error('requester_access_changed');
    }
    if (employee.knowledgeScopes.some(scope => !latest.knowledgeScopes.includes(scope))) {
      throw new Error('requester_scopes_reduced');
    }
    const refs = knowledge.filter(k => result.usedKnowledgeIds.includes(k.id)).map(k => k.title).slice(0, 3);
    const reference = refs.length ? '\n参考: ' + refs.join('、') : '';
    await slackPost(config.botToken, e.channel, '【EIGHT秘書・AI回答】\n' + String(result.answer).slice(0, 3000) + reference, e.thread_ts || e.ts);
    return;
  }
  // Fail closed: unknown company policy or judgment calls wait for a person.
  // 自動回答が OFF（既定）のときは、資料で答えられた案も代表の承認（宛先＋本文）を経てから送る。
  const draft = answerable ? String(result.answer || '').slice(0, 3000) : null;
  const draftRefs = answerable
    ? knowledge.filter(k => result.usedKnowledgeIds.includes(k.id)).map(k => k.title).slice(0, 3) : [];
  const ownerDm = requireOwnerDm(config);
  const { data: esc, error: escError } = await sb.from('gw_slack_ai_escalations').insert({
    tenant_id: config.tenantId, employee_id: employee.id, requester_slack_user_id: e.user,
    requester_channel: e.channel, requester_thread_ts: e.thread_ts || e.ts,
    requester_knowledge_scopes: employee.knowledgeScopes, question,
    ...(draft ? { ai_draft_answer: draft } : {}),
  }).select('id').single();
  if (escError) throw escError;
  // 代表への判断依頼は代表のSlack DMだけに送る（チャンネルへは送らない）。
  const owner = await slackPost(config.botToken, ownerDm,
    '【EIGHT秘書｜社長判断待ち】\n質問者: ' + employee.display_name
      + '\n質問: ' + question
      + (draft ? '\n\nAI回答案（質問者の閲覧権限内の資料' + (draftRefs.length ? ': ' + draftRefs.join('、') : '') + '。未送信）:\n' + draft : '')
      + '\n\n回答する場合は、このメッセージのスレッドで「承認: 回答本文」と送ってください。未承認の間は社員へ正式回答しません。'
      + '承認メッセージを送信前に編集・削除した場合や、承認を複数送った場合は承認を取り消し、送信しません。');
  const { error: updateErr } = await sb.from('gw_slack_ai_escalations')
    .update({ owner_dm_ts: owner.ts, owner_dm_channel: owner.channel || ownerDm }).eq('id', esc.id);
  if (updateErr) throw updateErr;
  await slackPost(config.botToken, e.channel, '【EIGHT秘書】\n社内資料だけでは判断できないため、社長へ確認を依頼しました。回答が届くまでお待ちください。', e.thread_ts || e.ts);
}

export async function processQueuedEvents(sb, config, limit = 10) {
  // 送信は既定で OFF。事前確認（secretaryPreflight）で代表DMを解決していなければ何も処理しない。
  if (config.sendingEnabled === false) throw new Error('slack_ai_sending_disabled');
  requireOwnerDm(config);
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
      const { error: doneError } = await sb.from('gw_slack_ai_events').update({ state: 'done', processed_at: new Date().toISOString(), event_payload: {} }).eq('event_id', item.event_id);
      if (doneError) throw doneError;
      processed++;
    } catch (err) {
      // Failures remain inspectable; do not auto-retry a potentially delivered message.
      const { error: failedError } = await sb.from('gw_slack_ai_events').update({ state: 'failed', last_error: String(err?.message || err).slice(0, 150) }).eq('event_id', item.event_id);
      if (failedError) throw failedError;
      failed++;
    }
  }
  // Recover approvals that have not yet attempted a delivery (including those whose
  // edit-cancellation hold has now elapsed). Attempted deliveries are never retried
  // automatically because a timeout can occur after Slack accepted the message.
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
  return {
    ...cfg,
    approvalHoldMs: DEFAULT_APPROVAL_HOLD_MS,
    // 既定はすべて OFF / 未設定。値は Vercel の設定でだけ与え、コードに書かない。
    sendingEnabled: env.SLACK_AI_SENDING_ENABLED === 'true',
    autoAnswer: env.SLACK_AI_AUTO_ANSWER === 'true',
    botUserId: env.SLACK_AI_BOT_USER_ID || null,
    configuredOwnerDmChannel: env.SLACK_AI_OWNER_DM_CHANNEL_ID || null,
    excludedBotUserId: env.SLACK_P_BOT_USER_ID || null,
    ownerDmChannel: null, // secretaryPreflight が解決するまで未確定
  };
}

// 実 Slack の Web API クライアント。テストでは使わず、モックを注入する。
export function createSlackClient(token) {
  return {
    async call(method, params = {}) {
      const response = await fetch('https://slack.com/api/' + method, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('slack_http_' + response.status);
      return response.json();
    },
  };
}

/**
 * 送信を有効にする前の事前確認（メッセージは送らない）。どれか1つでも満たさなければ ok:false で、
 * 呼び出し側はキュー処理・承認済み回答の送信を一切しない（保留のまま）。
 *   1. auth.test: トークンの workspace が設定の team と一致し、Bot ユーザーが設定の Bot ユーザーと一致
 *      （既存 P Bot のトークン流用は拒否）
 *   2. users.info: 代表ユーザーが同じ workspace の実在・有効・非ゲスト・非Botの人で、設定の代表と一致
 *   3. GW: 代表の Slack ID が明示紐付けされた在籍社員で、GW の owner ロールを持つ
 *   4. conversations.open(return_im): この Bot と代表の1対1 DM（is_im かつ相手が代表だけ）。
 *      DM ID を設定している場合は、解決結果と一致すること
 * 必要な scope: users:read（2）、im:write（4）。auth.test は scope 不要。
 */
export async function secretaryPreflight(slack, sb, config) {
  const fail = reason => ({ ok: false, reason });
  try {
    if (!config.botUserId) return fail('bot_user_not_configured');
    const auth = await slack.call('auth.test');
    if (!auth?.ok) return fail('auth_test_failed');
    if (auth.team_id !== config.teamId) return fail('team_mismatch');
    if (!auth.user_id || auth.user_id !== config.botUserId || !auth.bot_id) return fail('bot_identity_mismatch');
    if (config.excludedBotUserId && auth.user_id === config.excludedBotUserId) return fail('existing_p_bot_token');
    if (auth.user_id === config.ownerSlackId) return fail('token_is_not_a_bot');

    const info = await slack.call('users.info', { user: config.ownerSlackId });
    const u = info?.user;
    if (!info?.ok || !u) return fail('owner_lookup_failed');
    if (u.id !== config.ownerSlackId) return fail('owner_mismatch');
    if (u.team_id && u.team_id !== config.teamId) return fail('owner_other_team');
    if (u.deleted || u.is_bot || u.is_restricted || u.is_ultra_restricted || u.is_app_user) return fail('owner_not_active_member');

    const owner = await requireLinkedEmployee(sb, config.teamId, config.ownerSlackId, config.tenantId);
    if (!owner || !owner.roles.includes('owner')) return fail('owner_gw_mapping_invalid');

    const opened = await slack.call('conversations.open', { users: config.ownerSlackId, return_im: true });
    const ch = opened?.channel;
    if (!opened?.ok || !ch?.id) return fail('owner_dm_open_failed');
    if (ch.is_im !== true || ch.user !== config.ownerSlackId || ch.is_mpim || ch.is_group || ch.is_channel) {
      return fail('owner_dm_not_one_to_one');
    }
    if (config.configuredOwnerDmChannel && config.configuredOwnerDmChannel !== ch.id) return fail('owner_dm_id_mismatch');
    return { ok: true, ownerDmChannel: ch.id, botUserId: auth.user_id };
  } catch {
    return fail('preflight_error');
  }
}
