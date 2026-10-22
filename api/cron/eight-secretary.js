// Vercel Cron: deliver Slack direct-message questions from the durable queue.
// Never expose this endpoint publicly without a CRON_SECRET.
// 送信は既定で OFF（SLACK_AI_SENDING_ENABLED=true のときだけ動く）。動く前に毎回、読み取りの
// 事前確認（secretaryPreflight）を行い、失敗したらキューにも承認済み回答にも触れない（保留のまま）。
import { json, methodNotAllowed } from '../../lib/http.js';
import { admin } from '../../lib/supabase.js';
import { processQueuedEvents, secretaryConfig, secretaryPreflight, createSlackClient } from '../../lib/eight-slack-secretary.js';

export function createSecretaryCronHandler({ getAdmin = admin, env = () => process.env, slackClient = createSlackClient } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const vars = env();
    const secret = vars.CRON_SECRET;
    if (!secret || req.headers.authorization !== 'Bearer ' + secret) {
      return json(res, 401, { error: 'unauthorized' });
    }
    let config;
    try { config = secretaryConfig(vars); } catch {
      return json(res, 503, { error: 'slack_ai_not_configured' });
    }
    if (!config.sendingEnabled) return json(res, 200, { ok: true, disabled: 'sending_disabled' });
    try {
      const sb = getAdmin();
      const pre = await secretaryPreflight(slackClient(config.botToken), sb, config);
      if (!pre.ok) {
        console.error('[slack-secretary-preflight]', pre.reason);
        return json(res, 503, { error: 'preflight_failed', reason: pre.reason });
      }
      const out = await processQueuedEvents(sb, { ...config, ownerDmChannel: pre.ownerDmChannel }, 5);
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      console.error('[slack-secretary-worker]', e?.message || e);
      return json(res, 503, { error: 'processing_failed' });
    }
  };
}

export default createSecretaryCronHandler();
