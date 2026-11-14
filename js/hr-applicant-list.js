// Display one current state and one next action from the recorded hiring facts.
// No state transitions or applicant details are persisted by this module.
(function (root) {
  const ended = new Set(['passed', 'declined', 'position_closed']);
  const accepted = a => Boolean(a?.pdfFlow?.acceptedAt || a?.status === 'accepted' || a?.employeeId) && !ended.has(a?.status) && !['cancelled','declined'].includes(a?.pdfFlow?.phase);
  const officeUrl = a => `/admin-hr.html#agreement-${encodeURIComponent(a.id)}`;
  function view(a) {
    const f = a.pdfFlow;
    if (f && ['declined', 'cancelled'].includes(f.phase)) return { stage: 'closed', label: f.phase === 'declined' ? '辞退' : '案内取消', tone: 'muted', cta: '履歴を確認', key: 'detail' };
    if (ended.has(a.status)) return { stage: 'closed', label: a.statusLabel || '選考終了', tone: 'muted', cta: a.contact?.state === 'pending' ? '本人へ連絡' : '履歴を確認', key: a.contact?.state === 'pending' ? 'contact' : 'detail' };
    if (accepted(a) && a.offerType === 'training') return {stage:'agreement',label:'参加合意済み',tone:'done',cta:a.nextActionCta || '育成手続きを確認',key:a.nextActionKey || 'detail'};
    if (accepted(a)) return { stage: 'office', label: '合意済み・Officeへ', tone: 'done', cta: 'Officeを開く', href: officeUrl(a), key: 'office' };
    if (a.pdfFlowEnabled && a.pdfFlowReady === false) return { stage: 'offer', label: '書類の状態を確認', tone: 'wait', cta: '再確認する', key: 'detail' };
    if (f) return { stage: f.phase === 'offer_waiting' ? 'agreement' : 'offer', label: f.phase === 'offer_waiting' ? '本人の合意待ち' : '内定通知書の準備', tone: 'wait', cta: f.phase === 'offer_waiting' ? '回答状況を確認' : 'PDFを確認・送付', href: `/hr/pdf-flow.html?applicantId=${encodeURIComponent(a.id)}`, key: 'pdf' };
    const waiting = ['offer_sent', 'offer_viewed', 'offer_response_pending'].includes(a.status);
    const offer = ['offer', 'joining_scheduled'].includes(a.stage);
    const stage = waiting ? 'agreement' : offer ? 'offer' : ['ceo_recommend', 'ceo_interview'].includes(a.stage) ? 'ceo_interview' : a.stage === 'casual_interview' ? 'casual_interview' : 'applied';
    const labels = { offer_draft_pending: '内定通知書作成待ち', offer_review_pending: '通知書の社内確認待ち', offer_send_pending: '通知書の送付待ち', offer_resend_pending: '通知書の再送待ち', offer_sent: '本人の合意待ち', offer_viewed: '本人の合意待ち', offer_response_pending: '本人の合意待ち' };
    const label = a.decision === 'hold' ? '保留中' : labels[a.status] || a.statusLabel || '未対応';
    return { stage, label, tone: waiting ? 'wait' : 'active', cta: waiting ? '回答状況を確認' : a.nextActionCta || '詳細を確認', key: waiting ? 'detail' : a.nextActionKey || 'detail' };
  }
  const fingerprint = a => JSON.stringify([a.stage, a.status, a.decision, a.offerType, a.pdfFlow?.phase || null, a.pdfFlow?.acceptedAt || null, a.contact?.state || null, a.handoffState || null, Boolean(a.employeeId)]);
  function tracker(storage, key) {
    let data = { known: {}, unread: {} };
    try { const saved = JSON.parse(storage.getItem(key) || 'null'); if (saved?.known && saved?.unread) data = saved; } catch {}
    const save = () => { try { storage.setItem(key, JSON.stringify(data)); } catch {} };
    return {
      update(rows) {
        const first = !Object.keys(data.known).length;
        const ids = new Set(rows.map(a => a.id));
        for (const a of rows) { const f = fingerprint(a); if (!first && data.known[a.id] !== f) data.unread[a.id] = f; data.known[a.id] = f; }
        for (const id of Object.keys(data.known)) if (!ids.has(id)) { delete data.known[id]; delete data.unread[id]; }
        save();
      },
      has: id => Boolean(data.unread[id]),
      read(id, row) { if(row) data.known[id]=fingerprint(row); delete data.unread[id]; save(); },
      count: rows => rows.filter(a => Boolean(data.unread[a.id])).length,
    };
  }
  root.HRApplicantList = { view, accepted, fingerprint, tracker };
})(globalThis);
