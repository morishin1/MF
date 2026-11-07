// GET /api/sales/company-summary?companyId=<uuid>[&format=md]
// Read-only. AI jobs are never triggered from GET. Company + summary share tenant scope.
import { requireUser } from '../../lib/auth.js';
import { gwContext, canSell } from '../../lib/gw.js';
import { userClient } from '../../lib/supabase.js';
import { json, methodNotAllowed } from '../../lib/http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  res.setHeader?.('Cache-Control', 'private, no-store');
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx)) return json(res, 403, { error: 'forbidden' });
  const query = new URL(req.url || '/', 'http://localhost').searchParams;
  const companyId = query.get('companyId');
  const format = query.get('format') || 'json';
  if (!UUID.test(companyId || '') || !['json', 'md'].includes(format))
    return json(res, 400, { error: 'invalid_query' });

  const db = userClient(req);
  const { data: company, error: companyError } = await db.from('gw_sales_companies')
    .select('id,name,tenant_id').eq('id', companyId).eq('tenant_id', ctx.tenantId).maybeSingle();
  if (companyError) return json(res, 503, { error: 'company_unavailable' });
  if (!company) return json(res, 404, { error: 'company_not_found' });
  const { data, error } = await db.from('gw_sales_company_summaries')
    .select('company_id,status,summary,markdown,facts,hypotheses,sources,unknowns,next_actions,processed_at,updated_at,prompt_version')
    .eq('company_id', companyId).eq('tenant_id', ctx.tenantId).maybeSingle();
  if (error) return json(res, 503, { error: 'summary_unavailable', hint: 'db/162 migration or RLS permissions require verification' });
  if (format === 'md') {
    if (!data || data.status !== 'completed' || !data.markdown)
      return json(res, 409, { error: 'summary_not_ready' });
    // Prevent headers and content from being mistaken for public/cacheable documents.
    res.setHeader?.('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader?.('Content-Disposition', 'attachment; filename="company-summary.md"');
    return res.status(200).send(data.markdown);
  }
  return json(res, 200, { companyId, companyName: company.name,
    summary: data ? { status: data.status, text: data.summary, facts: data.facts,
      hypotheses: data.hypotheses, sources: data.sources, unknowns: data.unknowns,
      nextActions: data.next_actions, processedAt: data.processed_at,
      updatedAt: data.updated_at, promptVersion: data.prompt_version } : null });
}
