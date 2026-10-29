import { json, readJson, methodNotAllowed, dbSetupHint } from '../../../lib/http.js';
import { requireUser } from '../../../lib/auth.js';
import { gwContext, canSell } from '../../../lib/gw.js';
import { userClient } from '../../../lib/supabase.js';
import { isUuid, canManageProposals } from '../../../lib/sales-proposals.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx)) return json(res, 403, { error: 'forbidden' });
  const body = await readJson(req);
  if (!isUuid(body?.id) || typeof body.isHot !== 'boolean' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)
    return json(res, 400, { error: 'invalid_body' });
  const sb = userClient(req);
  const { data: p, error: readError } = await sb.from('gw_sales_proposals')
    .select('id,tenant_id,sales_owner_id,archived_at').eq('tenant_id', ctx.tenantId).eq('id', body.id).maybeSingle();
  if (readError) return json(res, 500, { error: 'read_failed' });
  if (!p) return json(res, 404, { error: 'not_found' });
  if (!(canManageProposals(ctx) || (ctx.employee?.id && p.sales_owner_id === ctx.employee.id))) return json(res, 403, { error: 'forbidden' });
  if (p.archived_at) return json(res, 409, { error: 'archived' });
  const { data, error } = await sb.rpc('gw_sales_set_proposal_hot', {
    p_proposal: body.id, p_hot: body.isHot, p_expected_version: body.expectedVersion,
  });
  if (error) {
    if (['42883','PGRST202'].includes(error.code) || dbSetupHint(error, 'db/150_sales_proposal_hot_marks.sql')) return json(res, 503, { error: 'not_ready', message: 'ホットマークの準備が必要です。管理者にご連絡ください。' });
    return json(res, error.code === '40001' ? 409 : error.code === '42501' ? 403 : 500,
      { error: error.code === '40001' ? 'hot_changed' : 'save_failed', message: '保存を確認できません。一覧を再読み込みしてください。' });
  }
  return json(res, 200, { id: body.id, isHot: data.isHot, hotVersion: data.version, hotAvailable: true });
}
