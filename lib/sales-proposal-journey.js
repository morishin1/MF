// 提案送信コホート。期間内イベント件数ではない。合格と成約・稼働は別の事実。
import { CLOSE_REASON_LABEL, REASON_COLLECTION_LABEL } from './sales-proposals.js';
const ACCEPTED = new Set(['合格', '面談合格']);
const WORKING = new Set(['稼働', '稼働決定', '稼働中']);
const iso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const rate = (n, d) => d ? Math.round(n / d * 1000) / 10 : null;

export function proposalJourney(proposals, activities, { since, until, activityTruncated = false, proposalTruncated = false, nameOf = () => null } = {}) {
  const start = iso(since), end = iso(until);
  if (!start || !end || start > end) throw new Error('invalid_period');
  const unique = new Map();
  for (const p of proposals || []) {
    const sent = iso(p.sent_at);
    if (p.id && p.source_system === 'enger' && !p.archived_at && sent && sent >= start && sent <= end && !unique.has(p.id)) unique.set(p.id, p);
  }
  const byId = new Map([...unique].map(([id, p]) => [id, {
    id, title: p.title || '', companyName: p.company_name || '', sentAt: iso(p.sent_at),
    companyKey: p.company_id ? `sales:${p.company_id}` : p.source_company_id ? `enger:${p.source_company_id}` : `proposal:${p.id}`,
    identityMissing: !p.company_id && !p.source_company_id,
    reasonCategoryUnrecorded: false, reasonCollectionStatus: 'unclassified', reasonCollectionLabel: REASON_COLLECTION_LABEL.unclassified,
    lost: p.status === 'lost', closeReason: p.close_reason || null, closeNote: p.close_note || null,
    ownerId: p.sales_owner_id || null, ownerName: nameOf(p.sales_owner_id) || '担当未登録・不明',
    terminal: ['won','lost','stopped','closed_no_reply'].includes(p.status),
    adjustedAt: null, scheduledAt: null, heldAt: null, acceptedAt: null, acceptedObservedAt: null,
    acceptedEvidence: null, wonAt: null, workingAt: null, workingEvidence: null,
    // Snapshot is evidence of current state, NOT evidence of its event date.
    ...(p.source_system === 'enger' && ACCEPTED.has(p.source_stage) ? { acceptedEvidence: 'snapshot' } : {}),
    ...(p.source_system === 'enger' && WORKING.has(p.source_stage) ? { workingEvidence: 'snapshot' } : {}),
    wonEvidence: p.status === 'won' ? 'snapshot' : null,
  }]));
  const earliest = (r, key, at) => { if (!r[key] || at < r[key]) r[key] = at; };
  for (const a of activities || []) {
    const r = byId.get(a.proposal_id), at = iso(a.occurred_at);
    if (!r || !at || at < r.sentAt || at > end) continue;
    if (['call', 'reply'].includes(a.kind) && a.outcome === 'meeting') earliest(r, 'adjustedAt', at);
    if (a.kind === 'meeting' && a.result === 'scheduled') earliest(r, 'scheduledAt', at);
    if (a.kind === 'meeting' && a.result === 'done') earliest(r, 'heldAt', at);
    if (a.kind === 'result' && a.result === 'won') { earliest(r, 'wonAt', at); r.wonEvidence = 'activity'; }
    if (a.kind !== 'sync' || unique.get(r.id).source_system !== 'enger') continue;
    const stage = a.detail?.to;
    if (ACCEPTED.has(stage)) {
      r.acceptedEvidence = 'sync';
      earliest(r, 'acceptedObservedAt', at);
      if (a.detail?.stageChange?.to === stage && iso(a.detail.stageChange.occurred_at) === at) earliest(r, 'acceptedAt', at);
      // Legacy sync time is a dispatch/observation time, never an invented pass date.
    }
    if (WORKING.has(stage)) {
      r.workingEvidence = 'sync';
      if (a.detail?.stageChange?.to === stage && iso(a.detail.stageChange.occurred_at) === at) earliest(r, 'workingAt', at);
    }
  }
  // 明示された記録だけを採用。再開→再見送りでは古い取得状態を引き継がない。
  const collectionLog = [...(activities || [])].filter(a=>['result','memo','decision','call','reply'].includes(a.kind))
    .sort((a,b)=>String(a.created_at || a.occurred_at).localeCompare(String(b.created_at || b.occurred_at)) || String(a.id).localeCompare(String(b.id)));
  for (const a of collectionLog) {
    const r = byId.get(a.proposal_id), at = iso(a.occurred_at);
    if (!r || !r.lost || !at || at < r.sentAt || at > end) continue;
    if (a.kind === 'result' || (a.kind === 'decision' && a.result === 'continue')
      || (['call','reply'].includes(a.kind) && a.outcome === 'declined')) { r.reasonCollectionStatus = 'unclassified'; r.reasonCategoryUnrecorded = false; }
    const c = a.detail?.reasonCollection;
    if (a.kind === 'result' && a.result === 'lost' && c?.version === 1
      && ['not_asked','no_answer','vague'].includes(c.status)) r.reasonCategoryUnrecorded = true;
    if (c?.version === 1 && ['not_asked','no_answer','vague','specific'].includes(c.status)
      && (a.kind === 'memo' || a.result === 'lost')) r.reasonCollectionStatus = c.status;
    r.reasonCollectionLabel = REASON_COLLECTION_LABEL[r.reasonCollectionStatus];
  }
  const rows = [...byId.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt) || a.id.localeCompare(b.id));
  const n = (key) => rows.filter((r) => r[key]).length;
  const counts = { sent: rows.length, adjusted: n('adjustedAt'), scheduled: n('scheduledAt'), held: n('heldAt'),
    accepted: n('acceptedEvidence'), won: n('wonEvidence'), working: n('workingEvidence') };
  const complete = !activityTruncated && !proposalTruncated;
  const median = (values) => {
    if (!values.length) return null;
    const v = [...values].sort((a,b)=>a-b), m = Math.floor(v.length/2);
    return Math.round((v.length%2 ? v[m] : (v[m-1]+v[m])/2)*10)/10;
  };
  const duration = (r, at) => (Date.parse(at)-Date.parse(r.sentAt))/86400000;
  const heldDays = (rs) => rs.filter(r=>r.heldAt).map(r=>duration(r,r.heldAt));
  const awaiting = rows.filter(r=>!r.heldAt && !r.terminal && !r.acceptedEvidence && !r.workingEvidence);
  const measured = heldDays(rows);
  const bottlenecks = {
    awaitingHeld: awaiting.length, awaitingHeldMedianDays: median(awaiting.map(r=>duration(r,end))),
    awaitingAcceptedEvidence: rows.filter(r=>r.heldAt && !r.acceptedEvidence).length,
    heldMedianDays: median(measured), heldMeasured: measured.length,
  };
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.ownerId)) groups.set(r.ownerId, []); groups.get(r.ownerId).push(r); }
  const byCurrentOwner = [...groups].map(([ownerId, rs]) => {
    const held = rs.filter(r=>r.heldAt).length, accepted = rs.filter(r=>r.acceptedEvidence).length, measured = heldDays(rs);
    return {ownerId, ownerName: rs[0].ownerName, sent:rs.length, held, accepted, acceptedUnknown:rs.length-accepted,
      heldRate: complete ? rate(held,rs.length) : null, heldMedianDays:median(measured), heldMeasured:measured.length};
  }).sort((a,b)=>b.sent-a.sent || String(a.ownerId).localeCompare(String(b.ownerId)));

  const companyGroups = new Map();
  for (const r of rows) { if (!companyGroups.has(r.companyKey)) companyGroups.set(r.companyKey, []); companyGroups.get(r.companyKey).push(r); }
  const byCompany = [...companyGroups].map(([companyKey, rs]) => {
    const held = rs.filter(r=>r.heldAt).length, accepted = rs.filter(r=>r.acceptedEvidence).length;
    const lost = rs.filter(r=>r.lost), reasons = new Map();
    const collectionCounts = {not_asked:0,no_answer:0,vague:0,specific:0,unclassified:0};
    for (const r of lost) collectionCounts[r.reasonCollectionStatus]++;
    const classifiedReasons = lost.filter(r=>['specific','unclassified'].includes(r.reasonCollectionStatus));
    for (const r of classifiedReasons) { const code = r.reasonCategoryUnrecorded ? 'unrecorded' : r.closeReason || 'unrecorded'; reasons.set(code, (reasons.get(code)||0)+1); }
    return { companyKey, companyName:rs[0].companyName, identityMissing:rs[0].identityMissing,
      sent:rs.length, held, accepted, acceptedUnknown:rs.length-accepted, lost:lost.length,
      collectionCounts, heldRate:complete ? rate(held,rs.length) : null, unknownReason:classifiedReasons.filter(r=>r.reasonCategoryUnrecorded || !r.closeReason).length,
      reasons:[...reasons].map(([code,count])=>({code,count,label:CLOSE_REASON_LABEL[code] || (code==='unrecorded'?'理由未入力':`旧コード・${code}`)})) };
  }).sort((a,b)=>b.sent-a.sent || a.companyKey.localeCompare(b.companyKey));
  return { since: start, until: end, cohortCount: rows.length, counts,
    rates: { heldFromSent: complete ? rate(counts.held, counts.sent) : null, acceptedFromHeld: null },
    coverage: { acceptedUnknown: rows.length - counts.accepted, activityTruncated, proposalTruncated, acceptedComplete: false },
    rows, bottlenecks, byCurrentOwner, byCompany,
    notice: 'ENGER連携の非アーカイブ提案だけを対象に、送信日を基準に選んだ提案の、その後の記録済み到達を集計（各段1提案1件）。期間内イベント件数ではありません。各段は独立した記録で、前段の通過を推測しません。合格はENGERの受信済み証拠のみ。未確認は不合格・0件ではなく、過去の履歴欠落や未連携を含みます。合格の日時は明示的な遷移の記録日時だけ表示（先方の判断日時ではありません）。正式な合格率は未集計。成約・稼働から合格を推定しません。' };
}
