// Slack Events API receiver. Signs BEFORE JSON parsing; ACK quickly and enqueue.
// The cron worker performs AI work, so Slack's 3-second deadline is not blocked.
import { json, methodNotAllowed } from '../../lib/http.js';
import { admin } from '../../lib/supabase.js';
import { verifySlackSignature } from '../../lib/eight-slack-secretary.js';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!process.env.SLACK_AI_SIGNING_SECRET || !process.env.SLACK_AI_TEAM_ID) {
    return json(res, 503, { error: 'slack_ai_not_configured' });
  }
  let raw, payload;
  try { raw = await rawRequest(req); } catch {
    return json(res, 413, { error: 'invalid_body' });
  }
  if (!verifySlackSignature(raw, req.headers, process.env.SLACK_AI_SIGNING_SECRET)) {
    return json(res, 401, { error: 'invalid_signature' });
  }
  try { payload = JSON.parse(raw); } catch {
    return json(res, 400, { error: 'invalid_json' });
  }
  if (payload.team_id !== process.env.SLACK_AI_TEAM_ID) {
    return json(res, 403, { error: 'wrong_workspace' });
  }
  if (payload.type === 'url_verification') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(String(payload.challenge || ''));
  }
  if (payload.type !== 'event_callback' || !payload.event_id) return json(res, 200, { ok: true });
  const event = payload.event || {};
  // MVP accepts DMs only; app mentions / public channels cannot leak private answers.
  if (event.type !== 'message' || event.channel_type !== 'im' || !event.user
      || event.bot_id || event.subtype || !event.text || !event.channel) {
    return json(res, 200, { ok: true, ignored: true });
  }
  try {
    const { error } = await admin().from('gw_slack_ai_events').insert({
      event_id: payload.event_id,
      slack_team_id: payload.team_id,
      event_payload: { team_id: payload.team_id, event },
    });
    if (error && error.code !== '23505') throw error;
    return json(res, 200, { ok: true, queued: true });
  } catch {
    // Non-2xx signals Slack to retry: losing an event is worse than a retry.
    return json(res, 503, { error: 'queue_unavailable' });
  }
}
