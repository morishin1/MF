// Read a job/talent only through a proposal the caller can already see.
import { json, methodNotAllowed } from '../../../lib/http.js';
import { requireUser } from '../../../lib/auth.js';
import { gwContext, canSell } from '../../../lib/gw.js';
import { admin, userClient } from '../../../lib/supabase.js';
import { canAccessEightEngerDirectory } from '../../../lib/sales-enger-scope.js';
import { isUuid } from '../../../lib/sales-proposals.js';
import { loadProposal } from '../../../lib/sales-proposals-db.js';
import { readPublicCandidates } from '../../../lib/sales-company-portal-db.js';
import { isPublicTalent, toPublicTalent, redact } from '../../../lib/enger-talent-public.js';

const row = (label, value) => ({ label, value: value == null || value === '' ? '未登録' : String(value) });
export default async function handler(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  res.setHeader?.('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx) || !canAccessEightEngerDirectory(ctx)) return json(res, 403, { error: 'forbidden' });
  const params = new URL(req.url || '/', 'http://localhost').searchParams;
  const id = params.get('id'), kind = params.get('kind');
  if (!isUuid(id) || !['job', 'talent'].includes(kind)) return json(res, 400, { error: 'invalid_query' });
  try {
    const found = await loadProposal(userClient(req), ctx.tenantId, id);
    if (found.error) throw Error('proposal_read_failed');
    const p = found.proposal;
    if (!p) return json(res, 404, { error: 'not_found' });
    if (p.source_system !== 'enger' || !isUuid(p.source_proposal_id)) return json(res, 404, { error: 'not_linked', hint: 'ENGERの案件・人材に紐づいていません。' });
    const db = admin();
    const linked = await db.schema('enger').from('proposals').select('id,job_id,candidate_id,deleted_at').eq('id', p.source_proposal_id).maybeSingle();
    if (linked.error) throw Error('source_read_failed');
    if (!linked.data || linked.data.deleted_at) return json(res, 404, { error: 'source_unavailable', hint: '元の提案は削除済み、または確認できません。' });
    const entityId = linked.data[kind === 'job' ? 'job_id' : 'candidate_id'];
    if (!isUuid(entityId)) return json(res, 404, { error: 'not_linked', hint: 'この提案には詳細を確認できる情報が紐づいていません。' });
    if (kind === 'talent') {
      const result = await readPublicCandidates(db, q => q.eq('id', entityId), 1);
      if (result.error) throw Error('talent_read_failed');
      const source = result.rows[0];
      if (!isPublicTalent(source)) return json(res, 404, { error: 'talent_unavailable', hint: '削除・クローズ・稼働中などのため、この人材は現在提示できません。' });
      const t = toPublicTalent(source);
      return json(res, 200, { kind, title: t.displayName, fields: [row('人材番号', t.talentNo), row('職種', t.title), row('スキル', t.skills.join(' / ')), row('経験', t.experience), row('稼働開始', t.availability), row('働き方', t.remoteLabel), row('稼働日数', t.weekDays), row('地域', t.prefecture), row('最寄り駅', t.nearestStation)], dxUrl: 'https://dx.enger.jp/talents/' + entityId });
    }
    const result = await db.schema('enger').from('jobs').select('id,job_no,title,role_label,skills,remote_type,start_date,is_closed,deleted_at').eq('id', entityId).maybeSingle();
    if (result.error) throw Error('job_read_failed');
    const j = result.data;
    if (!j || j.deleted_at || j.is_closed === true) return json(res, 404, { error: 'job_unavailable', hint: 'この案件は削除済み、または募集が終了しています。' });
    const text = value => redact(value, 160);
    const skills = (Array.isArray(j.skills) ? j.skills : []).map(text).filter(Boolean).join(' / ');
    return json(res, 200, { kind, title: text(j.role_label) || text(j.title) || '案件', fields: [row('案件番号', Number.isSafeInteger(j.job_no) ? 'J-' + String(j.job_no).padStart(6, '0') : null), row('職種', text(j.role_label)), row('スキル', skills), row('働き方', ({ full_remote: 'フルリモート', partial_remote: '一部リモート', onsite: '出社' })[j.remote_type] || text(j.remote_type)), row('開始予定', text(j.start_date))], dxUrl: 'https://dx.enger.jp/jobs/' + entityId });
  } catch {
    return json(res, 503, { error: 'entity_unavailable', hint: '詳細を取得できませんでした。時間をおいて再度お試しください。' });
  }
}
