// Display one current state and one next action from the recorded hiring facts.
// No state transitions or applicant details are persisted by this module.
(function (root) {
  const ended = new Set(['passed', 'declined', 'position_closed']);
  const isTraining = a => a?.leadCategory === 'mugendojo' || a?.offerType === 'training';
  const isClosed = a => ended.has(a?.status) || a?.status === 'done' || ['declined', 'cancelled', 'joined'].includes(a?.pdfFlow?.phase);
  const accepted = a => Boolean(a?.pdfFlow?.acceptedAt || a?.status === 'accepted' || a?.employeeId) && !ended.has(a?.status) && !['cancelled','declined'].includes(a?.pdfFlow?.phase);
  const officeUrl = a => `/admin-hr.html#agreement-${encodeURIComponent(a.id)}`;
  function view(a) {
    const f = a.pdfFlow;
    if (a.status === 'done' || f?.phase === 'joined') return { stage: 'complete', label: isTraining(a) ? '対応完了' : '採用完了', tone: 'done', cta: '履歴を確認', key: 'detail' };
    if (f && ['declined', 'cancelled'].includes(f.phase)) return { stage: 'closed', label: f.phase === 'declined' ? '辞退' : '案内取消', tone: 'muted', cta: '履歴を確認', key: 'detail' };
    if (ended.has(a.status)) return { stage: 'closed', label: a.statusLabel || '選考終了', tone: 'muted', cta: a.contact?.state === 'pending' ? '本人へ連絡' : '履歴を確認', key: a.contact?.state === 'pending' ? 'contact' : 'detail' };
    if (accepted(a) && a.offerType === 'training') return {stage:'agreement',label:'参加合意済み',tone:'done',cta:a.nextActionCta || '育成手続きを確認',key:a.nextActionKey || 'detail'};
    if (accepted(a)) return { stage: 'office', label: '合意済み・Officeへ', tone: 'done', cta: 'Officeを開く', href: officeUrl(a), key: 'office' };
    if(a.currentTrial?.status === 'active') return {stage:'trial',label:'2週間トライアル',tone:'active',cta:'実績を記録',href:'/hr/trials.html?applicantId='+encodeURIComponent(a.id),key:'trial'};
    if (a.pdfFlowEnabled && a.pdfFlowReady === false) return { stage: 'offer', label: '書類の状態を確認', tone: 'wait', cta: '再確認する', key: 'detail' };
    if (f) return { stage: f.phase === 'offer_waiting' ? 'agreement' : 'offer', label: f.phase === 'offer_waiting' ? '本人の合意待ち' : '内定通知書の準備', tone: 'wait', cta: f.phase === 'offer_waiting' ? '回答状況を確認' : 'PDFを確認・送付', href: `/hr/pdf-flow.html?applicantId=${encodeURIComponent(a.id)}`, key: 'pdf' };
    const waiting = ['offer_sent', 'offer_viewed', 'offer_response_pending'].includes(a.status);
    const offer = ['offer', 'joining_scheduled'].includes(a.stage);
    const stage = waiting ? 'agreement' : offer ? 'offer' : ['ceo_recommend', 'ceo_interview'].includes(a.stage) ? 'ceo_interview' : a.stage === 'casual_interview' ? 'casual_interview' : 'applied';
    const labels = { offer_draft_pending: '内定通知書作成待ち', offer_review_pending: '通知書の社内確認待ち', offer_send_pending: '通知書の送付待ち', offer_resend_pending: '通知書の再送待ち', offer_sent: '本人の合意待ち', offer_viewed: '本人の合意待ち', offer_response_pending: '本人の合意待ち' };
    const label = a.decision === 'hold' ? '保留中' : labels[a.status] || a.statusLabel || '未対応';
    return { stage, label, tone: waiting ? 'wait' : 'active', cta: waiting ? '回答状況を確認' : a.nextActionKey==='createOffer'?'通知書PDFを作成する':a.nextActionCta || '詳細を確認', key: waiting ? 'detail' : a.nextActionKey || 'detail' };
  }
  const fingerprint = a => JSON.stringify([a.stage, a.status, a.decision, a.offerType, a.pdfFlow?.phase || null, a.pdfFlow?.acceptedAt || null, a.contact?.state || null, a.handoffState || null, Boolean(a.employeeId)]);
  function tracker(storage, key) {
    let data = { known: {}, unread: {}, kinds: {} };
    try { const saved = JSON.parse(storage.getItem(key) || 'null'); if (saved?.known && saved?.unread) data = saved; } catch {}
    data.kinds ||= {};
    const save = () => { try { storage.setItem(key, JSON.stringify(data)); } catch {} };
    return {
      update(rows) {
        const first = !Object.keys(data.known).length;
        const ids = new Set(rows.map(a => a.id));
        for (const a of rows) { const f = fingerprint(a); if (!first && data.known[a.id] !== f) { data.unread[a.id] = f; data.kinds[a.id] = data.known[a.id] ? 'status' : 'application'; } data.known[a.id] = f; }
        for (const id of Object.keys(data.known)) if (!ids.has(id)) { delete data.known[id]; delete data.unread[id]; }
        save();
      },
      has: id => Boolean(data.unread[id]),
      kind: id => data.kinds[id] || "status",
      seed(states) { for(const a of states) { if(a.unread) {data.unread[a.id]=true;data.kinds[a.id]=a.kind;} else {delete data.unread[a.id];} } save(); },
      read(id, row) { if(row) data.known[id]=fingerprint(row); delete data.unread[id]; save(); },
      count: rows => rows.filter(a => Boolean(data.unread[a.id])).length,
    };
  }
  function deadline(a,now=new Date()) {
    if(!a.decisionDueOn || ['accepted','done','passed','declined','position_closed'].includes(a.status)) return null;
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo'}).format(now);
    const days=(Date.parse(a.decisionDueOn+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000;
    return days<=2 ? {overdue:days<0,label:(days<0?'期限超過：':'対応期限：')+a.decisionDueOn} : null;
  }
  function documents(a) {
    const d=a.docs,contractor=a.talentCategory==='contractor'||a.offerType==='contractor'||a.employmentType==='業務委託';
    const lead=a.leadCategory==='mugendojo';
    const offer=['offer','joining_scheduled'].includes(a.stage)||a.decision==='hired';
    const skilled=/エンジニア|engineer|開発|IT|技術/i.test(a.jobTitle||'');
    const reviews=d?.reviews||{};
    const state=(key,present,required)=>!d?'unknown':reviews[key]==='defective'?'error':present?(reviews[key]==='confirmed'?'done':'pending'):(required?'missing':'na');
    const rows=[
      {key:'resume',label:'履歴書',icon:'description',state:state('resume',d?.resume,!lead&&!contractor)},
      {key:'work_history',label:'職務経歴書',icon:'work_history',state:state('work_history',d?.workHistory,!lead&&!contractor&&!['パート','アルバイト','パート・アルバイト'].includes(a.employmentType))},
      {key:'skill_sheet',label:'スキルシート',icon:'assignment_ind',state:state('skill_sheet',d?.skillSheet,!lead&&contractor&&skilled)},
      {key:'notice',label:contractor?'業務委託オファー':'労働条件通知書',icon:'article',state:!offer?'na':!d?.conditions?'unknown':d.conditions.noticeConfirmed?'done':d.conditions.notice?'pending':'missing'},
      {key:'contract',label:contractor?'業務委託契約書':'雇用契約書',icon:'contract',state:!offer||lead?'na':a.formalState==='signed'||d?.conditions?.contractConfirmed?'done':a.contractState||d?.conditions?.contract?'pending':'missing'}
    ];
    const texts={unknown:'取得状態を確認',done:'確認済み',pending:'確認待ち',missing:'未提出',na:'対象外・任意',error:'不備あり'};
    return rows.map(d=>({...d,text:texts[d.state]}));
  }
  function pipeline(a) {
    const current=view(a);
    if(current.stage==='closed')return {stage:'closed',label:current.label};
    if(current.stage==='complete')return {stage:'complete',label:current.label};
    if(current.stage==='office')return {stage:'office',label:'Office移行'};
    if(current.stage==='agreement')return {stage:'agreement',label:'本人合意'};
    if(current.stage==='offer')return {stage:'offer',label:'内定通知'};
    if(a.currentTrial?.status==='active')return {stage:'trial',label:'2週間トライアル'};
    if(['ceo_interview','ceo_recommend'].includes(a.stage))return {stage:'final',label:'最終判定'};
    if(a.stage==='casual_interview')return {stage:'interview',label:'採用面談'};
    if(a.status!=='todo')return {stage:'screening',label:'事前選考'};
    return {stage:'applied',label:'応募受付'};
  }
  root.HRApplicantList = { view, accepted, isClosed, fingerprint, tracker, deadline, documents, pipeline };
})(globalThis);
