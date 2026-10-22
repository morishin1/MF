// Slack Events API receiver. Signs BEFORE JSON parsing; ACK quickly and enqueue.
// The cron worker performs AI work, so Slack's 3-second deadline is not blocked.
import { json, methodNotAllowed } from '../../lib/http.js';
import { admin } from '../../lib/supabase.js';
import { verifySlackSignature, approvedReply } from '../../lib/eight-slack-secretary.js';

async function rawRequest(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new Error('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createSlackEventsHandler({ getAdmin = admin, env = () => process.env } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    const config = env();
    if (!config.SLACK_AI_SIGNING_SECRET || !config.SLACK_AI_TEAM_ID) {
      return json(res, 503, { error: 'slack_ai_not_configured' });
    }
    let raw, payload;
    try { raw = await rawRequest(req); } catch {
      return json(res, 413, { error: 'invalid_body' });
    }
    if (!verifySlackSignature(raw, req.headers, config.SLACK_AI_SIGNING_SECRET)) {
      return json(res, 401, { error: 'invalid_signature' });
    }
    try { payload = JSON.parse(raw); } catch {
      return json(res, 400, { error: 'invalid_json' });
    }
    if (payload.type === 'url_verification') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(typeof payload.challenge === 'string' ? payload.challenge : '');
    }
    if (payload.team_id !== config.SLACK_AI_TEAM_ID) {
      return json(res, 403, { error: 'wrong_workspace' });
    }
    if (payload.type !== 'event_callback' || !payload.event_id) return json(res, 200, { ok: true });
    const event = payload.event || {};
    let safeEvent;
    if (event.type === 'message' && event.channel_type === 'im' && event.channel && event.ts
        && (event.subtype === 'message_changed' || event.subtype === 'message_deleted')) {
      // 編集・削除は「代表が自分の承認メッセージを変えた」判定にだけ使う。
      // 社員の編集や本文は保存しない（代表IDが未設定なら受け付けない）。
      const after = event.message || {};
      const before = event.previous_message || {};
      const author = event.subtype === 'message_deleted' ? before.user : (after.user || before.user);
      const editedTs = event.subtype === 'message_deleted' ? (event.deleted_ts || before.ts) : (after.ts || before.ts);
      if (!config.SLACK_AI_OWNER_USER_ID || author !== config.SLACK_AI_OWNER_USER_ID || !editedTs
          || after.bot_id || before.bot_id) {
        return json(res, 200, { ok: true, ignored: true });
      }
      safeEvent = {
        type: 'message',
        subtype: event.subtype,
        channel_type: 'im',
        user: author,
        channel: event.channel,
        ts: event.ts,
        edited_ts: String(editedTs),
        thread_ts: after.thread_ts || before.thread_ts || null,
        text_changed: event.subtype === 'message_deleted' || String(after.text || '') !== String(before.text || ''),
        was_approval: !!approvedReply(before.text),
        is_approval: event.subtype === 'message_changed' && !!approvedReply(after.text),
      };
    } else {
      // MVP accepts DMs only; app mentions / public channels cannot leak private answers.
      if (event.type !== 'message' || event.channel_type !== 'im' || !event.user
          || event.bot_id || event.subtype || typeof event.text !== 'string' || !event.text
          || !event.channel || !event.ts) {
        return json(res, 200, { ok: true, ignored: true });
      }
      const tooLong = event.text.length > 4000;
      safeEvent = {
        type: 'message',
        channel_type: 'im',
        user: event.user,
        channel: event.channel,
        ts: event.ts,
        thread_ts: event.thread_ts || null,
        text: tooLong ? '' : event.text,
        too_long: tooLong,
      };
    }
    try {
      const { error } = await getAdmin().from('gw_slack_ai_events').insert({
        event_id: payload.event_id,
        slack_team_id: payload.team_id,
        // 同じメッセージが別の event_id で再配信されても1回しか処理しない（db/147 の一意索引）。
        message_key: safeEvent.channel + ':' + safeEvent.ts,
        event_payload: { team_id: payload.team_id, event: safeEvent },
      });
      if (error && error.code !== '23505') throw error;
      return json(res, 200, { ok: true, queued: true });
    } catch {
      // Non-2xx signals Slack to retry: losing an event is worse than a retry.
      return json(res, 503, { error: 'queue_unavailable' });
    }
  };
}

export default createSlackEventsHandler();
