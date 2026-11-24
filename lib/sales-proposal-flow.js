// Each step uses its own evidence. A later milestone never fills a missing earlier step.
const responseLabels = { proceed: '進める', '話を進める': '進める', pass: '見送り', '見送り': '見送り' };
const explicitFailures = new Set(['面談不合格', '面談で不合格', '不合格', '面談結果：不合格', '面談結果:不合格']);
const step = (label, value, state = 'unknown') => ({ label, value, state });

export function currentAnswers(rounds, reactions, reopenedAt, now) {
  const answer={};
  const current=at => at && Date.parse(at)<=Date.parse(now) && (!reopenedAt || Date.parse(at)>=Date.parse(reopenedAt));
  for (const side of ['job','cand']) {
    const latest=rounds.filter(r=>r.side===side && r.opens_round && current(r.sent_at))
      .sort((a,b)=>Date.parse(b.sent_at)-Date.parse(a.sent_at) || b.id.localeCompare(a.id))[0];
    const found=reactions.filter(r=>r.side===side && ['proceed','pass'].includes(r.result) && current(r.answered_at) &&
      (!latest || r.round_id===latest.id)).sort((a,b)=>Date.parse(b.answered_at)-Date.parse(a.answered_at))[0];
    if(found) answer[side]=found.result;
    else if(latest) answer[side]='unanswered';
  }
  return answer;
}

export function proposalFlow({ source = {}, sale = {}, activities = [], sentAt, interviewResult, currentHeld, affiliation, reopenedAt, answers = {} } = {}) {
  const fresh = at => !reopenedAt || (at && Date.parse(at) >= Date.parse(reopenedAt));
  const activity = (kind, results) => activities.filter(a => a.kind === kind && results.includes(a.result) && fresh(a.occurred_at || a.created_at))
    .sort((a, b) => Date.parse(b.occurred_at || b.created_at) - Date.parse(a.occurred_at || a.created_at))[0];
  const matched = Boolean(sale.matched_at || source.match_evaluation_id || (source.job_id && source.candidate_id));
  const sent = sentAt || (fresh(source.mail_sent_at) && source.mail_sent_at) || (fresh(sale.sent_at) && sale.sent_at) || activity('sent', ['sent', 'resent']);
  const lost = ['失注', '見送り'].includes(source.stage) || (!source.id && sale.status === 'lost');
  const job = responseLabels[answers.job ?? (!reopenedAt && source.job_action_type)];
  const candidate = responseLabels[answers.cand ?? (!reopenedAt && source.cand_action_type)];
  const sourceFailure = lost && source.lost_phase === '4. 面談後失注' && source.dx2_lost_side === '案件側' &&
    [source.lost_reason, source.lost_detail_reason].some(v => explicitFailures.has(v));
  const decision = interviewResult || (source.stage === '合格' ? 'passed' : sourceFailure ? 'failed' :
    activity('result', ['passed','failed'])?.result || activity('meeting', ['passed','failed'])?.result);
  const held = currentHeld || Boolean(decision) || Boolean(activity('meeting', ['done','held','completed'])) || (lost && source.lost_phase === '4. 面談後失注');
  const confirmed = affiliation?.confirmedAt && fresh(affiliation.confirmedAt);
  const contact = fresh(source.confirm_notified_at) && source.confirm_notified_at;
  const affiliationLabel = confirmed ? ({available:'提案可を確認', unavailable:'提案不可を確認', waiting:'回答待ち'})[affiliation.status] : null;
  const result = job ? '案件側：' + job : lost ? '見送り' : held ? '面談実施' : sent ? '回答待ち' : '未確認';
  return [
    step('マッチング', matched ? '案件・人材を照合' : '未確認', matched ? 'done' : 'unknown'),
    step('提案', sent ? '送信済み' : '送信未確認', sent ? 'done' : 'unknown'),
    step('所属確認', affiliationLabel || (candidate ? '人材側：' + candidate : contact ? '確認依頼済み' : '未確認'),
      affiliationLabel ? (affiliation.status === 'waiting' ? 'pending' : affiliation.status === 'unavailable' ? 'stopped' : 'done') :
      (candidate || contact) ? 'pending' : 'unknown'),
    step('結果', result, result.includes('見送り') ? 'stopped' : result === '回答待ち' ? 'pending' : result === '未確認' ? 'unknown' : 'done'),
    step('合否', decision === 'passed' ? '合格' : decision === 'failed' ? '不合格' : held ? '結果待ち' : lost ? '合否記録なし' : '未確定',
      decision === 'passed' ? 'done' : decision === 'failed' ? 'stopped' : held ? 'pending' : 'unknown'),
  ];
}

export const IMPROVEMENT_DAYS = 90;
export const OBSERVATION_DAYS = 14;
export const MEETING_MINIMUM = 3;
const dayMs = 86400000;

export function improvementSignal(rows, asOf) {
  const today = Date.parse(asOf);
  const sent = rows.filter(r => r.sentAt && today - Date.parse(r.sentAt) <= IMPROVEMENT_DAYS * dayMs && Date.parse(r.sentAt) <= today);
  const mature = sent.filter(r => today - Date.parse(r.sentAt) >= OBSERVATION_DAYS * dayMs);
  const successful = sent.some(r => r.facts.passed || r.facts.won);
  return { suggested: mature.length >= MEETING_MINIMUM && !successful, sent: mature.length,
    lost: mature.filter(r => r.facts.lost).length, open: mature.filter(r => r.facts.active).length,
    unknownReason: mature.filter(r => r.facts.lost && ((!r.lossDetail && (!r.confirmedFeedback || r.confirmedFeedback.reason==='理由未確認')) || r.facts.side.code === 'unknown')).length };
}
