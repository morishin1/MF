// Display one current state and one next action from the recorded hiring facts.
// No state transitions or applicant details are persisted by this module.
(function (root) {
  const ended = new Set(['passed', 'declined', 'position_closed']);
  const categories=[{key:'executive_employee',label:'正社員・幹部候補',icon:'badge'},{key:'trial_2weeks',label:'2週間トライアル',icon:'date_range'},{key:'training',label:'育成枠',icon:'eco'},{key:'contractor',label:'業務委託',icon:'handshake'},{key:'part_time',label:'パート・アルバイト',icon:'schedule'},{key:'spot',label:'スポット・副業',icon:'bolt'}];
  const categoryOf=a=>categories.some(c=>c.key===a?.offerType)?a.offerType:null;
  const isTraining = a => a?.leadCategory === 'mugendojo' || a?.offerType === 'training';
  const isClosed = a => ended.has(a?.status) || a?.status === 'done' || ['declined', 'cancelled', 'joined'].includes(a?.pdfFlow?.phase);
  const accepted = a => Boolean(a?.pdfFlow?.acceptedAt || a?.status === 'accepted' || a?.employeeId) && !ended.has(a?.status) && !['cancelled','declined'].includes(a?.pdfFlow?.phase);
  const officeUrl = a => `/admin-hr.html#agreement-${encodeURIComponent(a.id)}`;
  const manualLabels={screening:'事前選考',interview:'カジュアル面談',final:'代表面談',offer:'合格通知の準備',trial:'トライアルの準備・確認',terms:'条件通知書の準備・確認',agreement:'合意内容の確認',office:'OFFICEへの引継ぎ準備'};
  function manualView(a,p) {
    if(!a.manualProgress||p.stage!==a.manualProgress.phase||!manualLabels[p.stage]||a.employeeId||a.handoffState==='done')return null;
    if(p.stage==='trial')return {...p,label:a.currentTrial?.status==='active'?'トライアル実施中':manualLabels.trial,tone:'active',cta:'トライアルの条件・実績を確認する',href:'/hr/trials.html?applicantId='+encodeURIComponent(a.id),key:'trial',instruction:'確認した条件をもとに、期間・契約・報酬を確認し、トライアルの準備・実績を記録してください。'};
    const tab=['offer','terms','agreement','office'].includes(p.stage)?'docs':['interview','final'].includes(p.stage)?'interviews':'overview';
    return {...p,label:manualLabels[p.stage],tone:'active',key:'detail',tab,cta:tab==='docs'?'書類・契約を確認する':tab==='interviews'?'面談・評価を確認する':'応募内容を確認する',instruction:({screening:'応募内容と提出書類を確認してください。',interview:'電話・面談で確認した内容と、面談の予定・記録を確認してください。',final:'代表面談の記録・評価を確認し、採用判断を記録してください。',offer:'内定通知書に記載する条件と、PDF・送付の状況を確認してください。',terms:'電話・面談で話した条件を確認し、条件通知書を準備してください。',agreement:'電話・面談での確認内容と、本人の合意・契約の記録を確認してください。',office:'本人の合意・契約の記録を確認し、OFFICEへの引継ぎ手続きを進めてください。'})[p.stage]};
  }
  function view(a) {
    const f=a.pdfFlow,p=pipeline(a);
    if(p.stage==='complete')return {...p,tone:'done',cta:'履歴を確認',key:'detail'};
    if(p.stage==='closed')return {...p,tone:'muted',cta:a.contact?.state==='pending'?'本人へ連絡':'履歴を確認',key:a.contact?.state==='pending'?'contact':'detail'};
    const manual=manualView(a,p);if(manual)return manual;
    if(accepted(a)&&a.offerType==='training')return {stage:'agreement',label:'参加合意済み',tone:'done',cta:a.nextActionCta||'育成手続きを確認',key:a.nextActionKey||'detail'};
    if(p.stage==='office')return {...p,tone:'done',cta:'OFFICEを開く',href:officeUrl(a),key:'office'};
    if(p.stage==='trial')return {...p,tone:'active',cta:'実績を記録',href:'/hr/trials.html?applicantId='+encodeURIComponent(a.id),key:'trial'};
    if(a.pdfFlowEnabled&&a.pdfFlowReady===false)return {stage:'offer',label:'書類の状態を確認',tone:'wait',cta:'再確認する',key:'detail'};
    if(f)return {...p,label:({offer_preparing:'合格通知の準備',offer_waiting:'合格通知への回答待ち',terms_preparing:'条件通知書の準備',terms_waiting:'条件への合意待ち'})[f.phase]||p.label,tone:'wait',cta:p.stage==='agreement'?'回答状況を確認':'書類を確認する',href:`/hr/pdf-flow.html?applicantId=${encodeURIComponent(a.id)}`,key:'pdf'};
    if(accepted(a))return {...p,label:'条件への合意済み',tone:'done',cta:a.nextActionCta||'契約・引継ぎを確認する',key:a.nextActionKey||'detail'};
    if(p.stage==='terms')return {...p,label:'条件通知書の準備・確認',tone:'active',cta:a.nextActionCta||'条件通知書を確認する',key:a.nextActionKey||'detail'};
    const waiting=['offer_sent','offer_viewed','offer_response_pending'].includes(a.status);
    const labels={offer_draft_pending:'合格通知の作成待ち',offer_review_pending:'合格通知の社内確認待ち',offer_send_pending:'合格通知の送信待ち',offer_resend_pending:'合格通知の再送待ち',offer_sent:p.stage==='agreement'?'条件への合意待ち':'合格通知への回答待ち',offer_viewed:p.stage==='agreement'?'条件への合意待ち':'合格通知への回答待ち',offer_response_pending:p.stage==='agreement'?'条件への合意待ち':'合格通知への回答待ち'};
    const label=a.decision==='hold'?'保留中':labels[a.status]||String(a.statusLabel||'未対応').replace(/社長面談/g,'代表面談');
    return {...p,label,tone:waiting?'wait':'active',cta:waiting?'回答状況を確認':a.nextActionKey==='createOffer'?'書類をアップロード':a.nextActionCta||'詳細を確認',key:waiting?'detail':a.nextActionKey||'detail'};
  }
  const fingerprint = a => JSON.stringify([a.stage, a.status, a.decision, a.offerType, a.pdfFlow?.phase || null, a.pdfFlow?.acceptedAt || null, a.contact?.state || null, a.handoffState || null, Boolean(a.employeeId),a.progressRevision||null]);
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
    const d=a.docs,contractor=a.talentCategory==='contractor'||['contractor','spot'].includes(a.offerType)||a.employmentType==='業務委託';
    const lead=a.leadCategory==='mugendojo';
    const offer=['offer','joining_scheduled'].includes(a.stage)||a.decision==='hired';
    const skilled=/エンジニア|engineer|開発|IT|技術/i.test(a.jobTitle||'');
    const reviews=d?.reviews||{};
    const state=(key,present,required)=>!d?'unknown':reviews[key]==='defective'?'error':present?(reviews[key]==='confirmed'?'done':'pending'):(required?'missing':'na');
    const rows=[
      {key:'resume',required:!lead&&!contractor,label:'履歴書',icon:'description',state:state('resume',d?.resume,!lead&&!contractor)},
      {key:'work_history',required:!lead&&!contractor&&!['パート','アルバイト','パート・アルバイト'].includes(a.employmentType),label:'職務経歴書',icon:'work_history',state:state('work_history',d?.workHistory,!lead&&!contractor&&!['パート','アルバイト','パート・アルバイト'].includes(a.employmentType))},
      {key:'skill_sheet',required:!lead&&contractor&&skilled,label:'スキルシート',icon:'assignment_ind',state:state('skill_sheet',d?.skillSheet,!lead&&contractor&&skilled)},
      {key:'notice',label:contractor?'業務委託オファー':'労働条件通知書',icon:'article',state:!offer?'na':!d?.conditions?'unknown':d.conditions.noticeConfirmed?'done':d.conditions.notice?'pending':'missing'},
      {key:'contract',label:contractor?'業務委託契約書':'雇用契約書',icon:'contract',state:!offer||lead?'na':a.formalState==='signed'||d?.conditions?.contractConfirmed?'done':a.contractState||d?.conditions?.contract?'pending':'missing'}
    ];
    const texts={unknown:'取得状態を確認',done:'確認済み',pending:'確認待ち',missing:'未提出',na:'対象外・任意',error:'不備あり'};
    return rows.map(d=>({...d,text:texts[d.state]}));
  }
  function pipeline(a) {
    const f=a.pdfFlow;
    if(a.status==='done'||f?.phase==='joined')return {stage:'complete',label:isTraining(a)?'対応完了':'採用完了'};
    if(ended.has(a.status)||['declined','cancelled'].includes(f?.phase))return {stage:'closed',label:f?.phase==='cancelled'?'案内取消':f?.phase==='declined'?'辞退':a.statusLabel||'選考終了'};
    if(a.employeeId||a.handoffState==='done')return {stage:'office',label:'OFFICE'};
    if(manualLabels[a.manualProgress?.phase])return {stage:a.manualProgress.phase,label:manualLabels[a.manualProgress.phase]};
    if(['onboarding','ready'].includes(f?.phase))return {stage:'office',label:'OFFICE'};
    if(a.currentTrial?.status==='active')return {stage:'trial',label:'トライアル'};
    if(f?.phase==='terms_waiting')return {stage:'agreement',label:'合意'};
    if(f?.phase==='terms_preparing')return {stage:'terms',label:'条件通知書'};
    if(['offer_preparing','offer_waiting'].includes(f?.phase))return {stage:'offer',label:'合格通知'};
    if(a.status==='accepted'||['guided','formal_waiting','signed_before_consent'].includes(a.contractState))return {stage:'agreement',label:'合意'};
    if(['conditions','request_pending','requested','review_pending','returned','guide_prep','approved'].includes(a.contractState)&&!(a.contractState==='conditions'&&['offer_draft_pending','offer_review_pending'].includes(a.status)))return {stage:'terms',label:'条件通知書'};
    if(['offer_sent','offer_viewed','offer_response_pending'].includes(a.status)&&a.docs?.conditions?.notice)return {stage:'agreement',label:'合意'};
    if(['offer','joining_scheduled'].includes(a.stage)||String(a.status).startsWith('offer_'))return {stage:'offer',label:'合格通知'};
    if(['ceo_interview','ceo_recommend'].includes(a.stage))return {stage:'final',label:'代表面談'};
    if(a.stage==='casual_interview')return {stage:'interview',label:'カジュアル面談'};
    return {stage:'screening',label:'事前選考'};
  }
  // Guidance follows the recorded next action; it never decides or changes hiring facts.
  function guidance(a) {
    const current=view(a), closed=isClosed(a);
    if(manualView(a,pipeline(a)))return current;
    const fallback={applied:'応募内容と提出書類を確認してください。',screening:'応募内容を確認し、面談へ進めるか判断してください。',interview:'面談の予定・記録を確認してください。',final:'面談の評価を確認し、最終判断を行ってください。',offer:'合格通知の内容と送信状況を確認してください。',terms:'条件通知書の内容と確認状況を確認してください。',agreement:'本人の回答状況を確認してください。',office:'本人の合意を確認しました。Officeで契約・入社準備を進めてください。',complete:'採用手続きは完了しています。必要に応じて履歴を確認してください。',closed:'選考は終了しています。必要に応じて履歴を確認してください。'};
    if(current.href)return {...current,instruction:current.key==='trial'?'トライアルの活動と実績を記録してください。':fallback[current.stage]||a.nextAction||'次の手続きを確認してください。'};
    const key=!closed&&!a.pdfFlow&&a.nextActionKey?a.nextActionKey:current.key;
    const messages={registerEmail:'日程調整の案内を送るため、メールアドレスを登録してください。',sendSchedulingLink:'面談日程の案内を作成し、送信前に内容を確認してください。',schedule:a.nextAction||'面談の日程を設定してください。',conduct:'面談を行い、実施記録を残してください。',checkInterviews:'面談予定の記録を確認してください。',evaluate:'面談の回答・実績を確認し、評価を記録してください。',recommend:'評価の根拠をまとめて、最終判断を依頼してください。',decide:a.nextAction||'面談の評価を確認し、採用・保留・見送りを判断してください。',chooseOfferType:'採用区分を選び、通知書に記載する条件を設定してください。',createOffer:'作成済みの内定通知書・条件通知書PDFをアップロードし、確認してから本人に公開してください。',reviewOffer:'採用条件と通知書の内容を確認してください。',sendOffer:'通知書・宛先・文面を確認して、本人への送信を進めてください。',reissueOffer:'回答期限を確認し、必要に応じて案内を作り直してください。',contact:'決定した内容を本人へ伝えてください。',openContract:a.nextAction||'契約書の準備・確認を進めてください。',formalContract:'正式な契約の締結状況を確認してください。',handoff:'本人の合意・契約を確認し、Officeへの引継ぎを進めてください。',advance:a.nextAction||'次の採用手続きを確認してください。'};
    const instruction=a.pdfFlowEnabled&&a.pdfFlowReady===false?'書類の状態を取得できません。書類・契約から再確認してください。':messages[key]||(!closed?a.nextAction:null)||fallback[current.stage]||fallback[pipeline(a).stage]||fallback.applied;
    const cta={createOffer:'書類をアップロード',registerEmail:'メールアドレスを登録する',detail:closed?'履歴を見る':pipeline(a).stage==='terms'?'条件通知書を確認する':a.pdfFlowEnabled&&a.pdfFlowReady===false?'書類を確認する':['offer_sent','offer_viewed','offer_response_pending'].includes(a.status)?'回答状況を確認する':'応募者情報を見る'}[key]||a.nextActionCta||current.cta||'応募者情報を見る';
    return {...current,key,instruction,cta,tab:pipeline(a).stage==='terms'?'docs':closed||['offer_sent','offer_viewed','offer_response_pending'].includes(a.status)?'activity':a.pdfFlowEnabled&&a.pdfFlowReady===false?'docs':'overview'};
  }
  // Select the requested document type only, from the current version. Never fall back to a different file.
  function resolveDocument(kind,{documents=[],conditionDocs=null,contract=null,managed=[]}={}) {
    if(['resume','work_history','skill_sheet'].includes(kind)) {
      const file=documents.find(g=>g.docType===kind)?.latest;
      return file?{source:'application',file}:null;
    }
    const kinds=kind==='contract'?['employment_contract','labor_notice_contract','contractor_contract']:['labor_notice','labor_notice_contract','contractor_terms'];
    const formal=(contract?.docs||[]).filter(d=>!['superseded','returned'].includes(d.status)&&(!contract.offer?.id||d.offerId===contract.offer.id)&&kinds.includes(d.docKind)).sort((a,b)=>(b.revision||0)-(a.revision||0))[0];
    if(formal)return {source:'official',file:formal,allowed:Boolean(contract.perms?.salary)};
    const pdf=managed.find(d=>d.current&&!['superseded','revoked'].includes(d.state)&&d.kind==='terms'&&(kind==='notice'||d.responseMode==='contract_agree'));
    if(pdf)return {source:'managed',file:pdf};
    if(kind==='notice') {
      const row=conditionDocs?.rows?.find(r=>r.key==='notice'&&r.applicable!==false&&r.file);
      if(row&&conditionDocs.offerId)return {source:'offer',file:row,offerId:conditionDocs.offerId};
    }
    return null;
  }
  root.HRApplicantList = { view, accepted, isClosed, fingerprint, tracker, deadline, documents, pipeline, guidance, resolveDocument, categories, categoryOf };
})(globalThis);
