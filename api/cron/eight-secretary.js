// Vercel Cron: deliver Slack direct-message questions from the durable queue.
// Never expose this endpoint publicly without a CRON_SECRET.
import { json, methodNotAllowed } from '../../lib/http.js';
import { admin } from '../../lib/supabase.js';
import { processQueuedEvents, secretaryConfig } from '../../lib/eight-slack-secretary.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) {
    return json(res, 401, { error: 'unauthorized' });
  }
  let config;
  try { config = secretaryConfig(); } catch {
    return json(res, 503, { error: 'slack_ai_not_configured' });
  }
  try {
    const out = await processQueuedEvents(admin(), config, 5);
    return json(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[slack-secretary-worker]', e?.message || e);
    return json(res, 503, { error: 'processing_failed' });
  }
}
