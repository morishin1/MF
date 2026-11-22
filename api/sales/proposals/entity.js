// Read jobs and talents only through a proposal the caller can already see.
import { json, methodNotAllowed } from '../../../lib/http.js';
import { requireUser } from '../../../lib/auth.js';
import { gwContext, canSell } from '../../../lib/gw.js';
import { admin, userClient } from '../../../lib/supabase.js';
import { canAccessEightEngerDirectory } from '../../../lib/sales-enger-scope.js';
import { isUuid } from '../../../lib/sales-proposals.js';
import { inChunks, loadProposal } from '../../../lib/sales-proposals-db.js';
import { readPublicCandidates } from '../../../lib/sales-company-portal-db.js';
import { isPublicTalent, toPublicTalent, publicSkillSheet, redact } from '../../../lib/enger-talent-public.js';

const row = (label, value) => ({ label, value: value == null || value === '' ? '未登録' : String(value) });
const text = value => redact(value, 160);
const notLinked = { error: 'not_linked', hint: 'この提案には詳細を確認できる情報が紐づいていません。' };

async function readTalent(db, entityId) {
  if (!isUuid(entityId)) return notLinked;
  const result = await readPublicCandidates(db, q => q.eq('id', entityId), 1);
  if (result.error) throw Error('talent_read_failed');
  const source = result.rows[0];
  if (!isPublicTalent(source)) return { error: 'talent_unavailable', hint: '削除・クローズ・稼働中などのため、この人材は現在提示できません。' };
  const t = toPublicTalent(source);
  return {
    kind: 'talent', title: t.displayName, dxUrl: 'https://dx.enger.jp/talents/' + entityId,
    fields: [row('人材番号', t.talentNo), row('職種', t.title), row('スキル', t.skills.join(' / ')), row('経験', t.experience), row('稼働開始', t.availability), row('働き方', t.remoteLabel), row('稼働日数', t.weekDays), row('地域', t.prefecture), row('最寄り駅', t.nearestStation)],
    sheet: publicSkillSheet(t),
  };
}

async function readJob(db, entityId) {
  if (!isUuid(entityId)) return notLinked;
  const result = await db.schema('enger').from('jobs')
    .select('id,job_no,title,role_label,skills,remote_type,start_date,work_location,required_experience_years,work_days,is_closed,deleted_at')
    .eq('id', entityId).maybeSingle();
  if (result.error) throw Error('job_read_failed');
  const j = result.data;
  if (!j || j.deleted_at || j.is_closed === true) return { error: 'job_unavailable', hint: 'この案件は削除済み、または募集が終了しています。' };
  const skills = (Array.isArray(j.skills) ? j.skills : []).map(text).filter(Boolean).slice(0, 20).join(' / ');
  const remote = ({ full_remote: 'フルリモート', partial_remote: '一部リモート', onsite: '出社' })[j.remote_type] || text(j.remote_type);
  const experience = text(j.required_experience_years);
  return {
    kind: 'job', title: text(j.role_label) || text(j.title) || '案件', jobTitle: text(j.title), dxUrl: 'https://dx.enger.jp/jobs/' + entityId,
    fields: [row('案件番号', Number.isSafeInteger(j.job_no) ? 'J-' + String(j.job_no).padStart(6, '0') : null), row('職種', text(j.role_label)), row('スキル', skills), row('必要経験', /^\d+(?:\.\d+)?$/.test(experience || '') ? experience + '年以上' : experience), row('開始予定', text(j.start_date)), row('働き方', remote), row('稼働日数', text(j.work_days)), row('勤務地', text(j.work_location))],
  };
}

async function affiliationHistory(sb, tenantId, companyName) {
  if (!companyName?.trim() || ['未登録', '未入力', '不明', '個人', 'フリーランス', '個人事業主', '所属なし', '-', '—'].includes(companyName.trim())) return null;
  const limit = 250;
  const linked = await sb.from('gw_sales_proposals').select('id,status')
    .eq('tenant_id', tenantId).eq('source_system', 'enger').eq('talent_company_name', companyName)
    .is('archived_at', null).not('sent_at', 'is', null).order('sent_at', { ascending: false }).limit(limit + 1);
  if (linked.error) return null;
  const proposals = linked.data.slice(0, limit);
  const meetings = await inChunks(proposals.map(p => p.id), ids =>
    sb.from('gw_sales_proposal_activities').select('proposal_id').eq('tenant_id', tenantId)
      .eq('kind', 'meeting').eq('result', 'done').in('proposal_id', ids));
  if (meetings.error) return null;
  const held = new Set(meetings.data.map(a => a.proposal_id));
  return {
    sent: proposals.length,
    meetings: proposals.filter(p => p.status === 'meeting_done' || held.has(p.id)).length,
    won: proposals.filter(p => p.status === 'won').length,
    limited: linked.data.length > limit,
  };
}

export default async function handler(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  res.setHeader?.('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx) || !canAccessEightEngerDirectory(ctx)) return json(res, 403, { error: 'forbidden' });
  const params = new URL(req.url || '/', 'http://localhost').searchParams;
  const id = params.get('id'), kind = params.get('kind');
  if (!isUuid(id) || !['job', 'talent', 'compare'].includes(kind)) return json(res, 400, { error: 'invalid_query' });
  try {
    const sb = userClient(req);
    const found = await loadProposal(sb, ctx.tenantId, id);
    if (found.error) throw Error('proposal_read_failed');
    const p = found.proposal;
    if (!p) return json(res, 404, { error: 'not_found' });
    if (p.source_system !== 'enger' || !isUuid(p.source_proposal_id)) return json(res, 404, { error: 'not_linked', hint: 'ENGERの案件・人材に紐づいていません。' });
    const db = admin();
    const linked = await db.schema('enger').from('proposals').select('id,job_id,candidate_id,deleted_at').eq('id', p.source_proposal_id).maybeSingle();
    if (linked.error) throw Error('source_read_failed');
    if (!linked.data || linked.data.deleted_at) return json(res, 404, { error: 'source_unavailable', hint: '元の提案は削除済み、または確認できません。' });
    if (kind === 'compare') {
      const [talent, job, affiliation] = await Promise.all([
        readTalent(db, linked.data.candidate_id), readJob(db, linked.data.job_id),
        affiliationHistory(sb, ctx.tenantId, p.talent_company_name),
      ]);
      return json(res, 200, { talent, job, affiliation });
    }
    const item = kind === 'talent' ? await readTalent(db, linked.data.candidate_id) : await readJob(db, linked.data.job_id);
    return json(res, item.error ? 404 : 200, item);
  } catch {
    return json(res, 503, { error: 'entity_unavailable', hint: '詳細を取得できませんでした。時間をおいて再度お試しください。' });
  }
}
