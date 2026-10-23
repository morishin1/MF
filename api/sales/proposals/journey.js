// 読み取り専用。既存のSales閲覧権限・RLSを使用。新たなDB/権限/外部通信は不要。
import { json, methodNotAllowed, dbSetupHint } from '../../../lib/http.js';
import { requireUser } from '../../../lib/auth.js';
import { gwContext, canSell } from '../../../lib/gw.js';
import { userClient } from '../../../lib/supabase.js';
import { periodStartJst } from '../../../lib/sales.js';
import { loadPeople } from '../../../lib/sales-proposals-db.js';
import { proposalJourney } from '../../../lib/sales-proposal-journey.js';
const FIELDS = 'id,title,company_name,sent_at,status,source_system,source_stage,archived_at,sales_owner_id,company_id,source_company_id,close_reason,close_note';
const ACT_FIELDS = 'id,proposal_id,kind,result,outcome,occurred_at,created_at,detail';

// Supabaseの既定行上限を「全件」と誤認しない。明示的にページを取得。
export async function readJourneyPages(query, { pageSize = 500, maxRows = 5000 } = {}) {
  const rows = [];
  for (let offset = 0; offset <= maxRows; offset += pageSize) {
    const size = Math.min(pageSize, maxRows + 1 - offset);
    const { data, error } = await query().range(offset, offset + size - 1);
    if (error) return { error };
    rows.push(...(data || []));
    if (rows.length > maxRows) return { data: rows.slice(0, maxRows), truncated: true };
    if ((data || []).length < size) return { data: rows, truncated: false };
  }
  return { data: rows, truncated: false };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx)) return json(res, 403, { error: 'forbidden' });
  const requested = Number(new URL(req.url, 'http://localhost').searchParams.get('days'));
  const days = [1, 7, 30, 90, 365].includes(requested) ? requested : 30;
  const now = new Date(), until = now.toISOString();
  const { iso: since } = periodStartJst(days, now);
  const sb = userClient(req);
  const fail = (error) => {
    const message = dbSetupHint(error, 'db/138_sales_proposals.sql・db/140_sales_proposal_matching.sql');
    return json(res, message ? 503 : 500, { error: message ? 'not_ready' : 'db_failed', message: message || '集計データを読み取れませんでした。再試行してください。' });
  };
  const proposals = await readJourneyPages(() => sb.from('gw_sales_proposals').select(FIELDS)
    .eq('tenant_id', ctx.tenantId).eq('source_system', 'enger').is('archived_at', null).gte('sent_at', since).lte('sent_at', until)
    .order('sent_at', { ascending: false }).order('id', { ascending: true }));
  if (proposals.error) return fail(proposals.error);
  const acts = [];
  let activityTruncated = false;
  for (let i = 0; i < proposals.data.length; i += 100) {
    const ids = proposals.data.slice(i, i + 100).map((p) => p.id);
    const chunk = await readJourneyPages(() => sb.from('gw_sales_proposal_activities').select(ACT_FIELDS)
      .eq('tenant_id', ctx.tenantId).in('proposal_id', ids).in('kind', ['call', 'reply', 'meeting', 'result', 'sync', 'memo', 'decision'])
      .lte('occurred_at', until).order('occurred_at', { ascending: true }).order('id', { ascending: true }));
    if (chunk.error) return fail(chunk.error);
    acts.push(...chunk.data);
    activityTruncated ||= chunk.truncated;
  }
  const people = await loadPeople(ctx.tenantId);
  res.setHeader('Cache-Control', 'private, no-store');
  return json(res, 200, { days, ...proposalJourney(proposals.data, acts, {
    since, until, nameOf: people.nameOf, proposalTruncated: proposals.truncated, activityTruncated,
  }) });
}
