// Read-only presentation of recorded HR facts. All changes use the existing HR procedures.
(function(root){
  const steps=[['screening','応募'],['interview','面談'],['decision','採用判断'],['offer','内定通知'],['office','引継ぎ']];
  function describe({applicant:a,guide={},pipeline={},notice=null,legacy=null,candidateDocuments=[],docsError='',missingDocuments=[],pdfError='',blocked='',now=Date.now()}){
    const phase=pipeline.stage;
    let step=['office','complete'].includes(phase)?'office':['offer','terms','agreement'].includes(phase)?'offer'
      :guide.key==='decide'||['ceo_decision_pending','ceo_recommend'].includes(a.status)?'decision'
      :['interview','final','trial'].includes(phase)?'interview':'screening';
    const state=guide.label||a.statusLabel||'状態を確認';
    const out={step,status:['未対応','対応中'].includes(state)&&pipeline.label?pipeline.label+'・'+state:state,title:guide.instruction||a.nextAction||'応募内容を確認してください',
      description:'',cta:guide.cta||'応募内容を確認',action:'next',blocked,waiting:false,dueAt:a.decisionDueOn||null,dueLabel:'対応期限'};
    if(guide.key==='detail'){out.action=guide.tab==='activity'?'activity':guide.tab==='interviews'?'interviews':'docs';}
    // Ended and transferred records never acquire a send button from an old PDF.
    if(['closed','complete'].includes(phase)||['declined','cancelled','joined'].includes(a.pdfFlow?.phase)){
      if(guide.key==='contact')return {...out,step:null,title:'採否の本人連絡が未完了です',action:'next',cta:guide.cta||'本人へ連絡'};
      return {...out,step:phase==='complete'?'office':null,title:'選考・手続きの履歴を確認できます',description:'記録済みの状態です。通知書の再送や採用判断は行いません。',action:'activity',cta:'履歴を確認',blocked:'',waiting:true};
    }
    if(['office','complete'].includes(phase)||a.employeeId||a.handoffState==='done'){
      return {...out,step:'office',title:'契約・入社準備はOfficeで確認します',description:'本人の合意と引継ぎの記録に基づく表示です。',action:guide.href?'office':'activity',cta:guide.href?'Officeを開く':'引継ぎ履歴を確認',waiting:true};
    }
    if(pdfError&&a.pdfFlow){return {...out,step:'offer',title:'通知書の状態を取得できませんでした',description:pdfError,action:'reload',cta:'最新の状態を確認',blocked:''};}
    const f=notice?.enabled?notice.flow:null;
    const d=(notice?.documents||[]).find(x=>x.kind==='offer'&&x.current&&!['revoked','superseded'].includes(x.state));
    if(f&&['declined','cancelled'].includes(f.phase))return {...out,step:null,status:f.phase==='declined'?'辞退':'案内取消',title:'選考は終了しています',action:'activity',cta:'履歴を確認',blocked:'',waiting:true};
    if(f?.acceptedAt){return {...out,step:'office',status:'本人承諾済み',title:'本人の承諾を確認しました',description:'正式契約・入社準備はOfficeで進めます。',action:guide.href?'office':'activity',cta:guide.href?'Officeを開く':'承諾・引継ぎ履歴を確認',waiting:true};}
    if(d&&['sending','unknown'].includes(d.deliveryStatus||d.state)){
      return {...out,step:'offer',status:'送信結果の確認が必要',title:'送付済みかどうか、まだ確定できません',description:'送信結果を確認するまで再送しません。',action:'notice',cta:'送信結果を確認',blocked:notice.canManage===false?'書類を管理する担当者に確認してください。':blocked};
    }
    if(d?.sentAt||d?.state==='sent'){
      const expired=!d.respondedAt&&Number.isFinite(Date.parse(d.expiresAt))&&Date.parse(d.expiresAt)<=now;
      return {...out,step:'offer',status:expired?'内定通知の回答期限切れ':d.respondedAt?'本人回答済み':'内定通知送付済み・本人回答待ち',
        title:expired?'回答期限を過ぎています':d.respondedAt?'本人の回答内容を確認してください':'本人の回答を待っています',
        description:'メールの送付・本人の閲覧・承諾は、それぞれ別の記録として確認します。',action:'notice',cta:'通知書・回答状況を確認',
        waiting:!expired,dueAt:d.expiresAt||null,dueLabel:'回答期限',blocked:''};
    }
    if(f||a.decision==='hired'&&notice?.canStart){
      const ready=Boolean(d),canManage=notice.canManage!==false||notice.canStart===true;
      return {...out,step:'offer',status:ready?'内定通知の送付待ち':'内定通知書の準備中',
        title:ready?'内定通知書を本人へ送付してください':'本人へ送る内定通知書を準備してください',
        description:ready?'宛先・PDF・文面を確認してからメール送信します。':'PDFの作成・登録だけでは、本人に送信されません。',
        action:'notice',cta:ready?'PDFとメール内容を確認':'内定通知書を準備・送付',blocked:canManage?blocked:'書類を管理する担当者に確認してください。'};
    }
    if(legacy?.acceptedAt||a.status==='accepted'){return {...out,step:a.offerType==='training'?'offer':'office',status:'本人承諾済み',title:a.offerType==='training'?'参加合意を確認しました':'本人の承諾を確認しました',description:a.offerType==='training'?'育成の手続きを確認してください。':'正式契約・入社準備はOffice人事労務で確認します。',action:a.offerType==='training'?'next':'docs',cta:a.offerType==='training'?guide.cta||'育成手続きを確認':'承諾・引継ぎ内容を確認',waiting:true};}
    if(legacy?.sentAt){
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
      const expired=legacy.respondBy&&legacy.respondBy<today&&!legacy.acceptedAt;
      return {...out,step:'offer',status:expired?'内定通知の回答期限切れ':'内定通知送付済み・本人回答待ち',title:expired?'回答期限を過ぎています':'本人の回答を待っています',
        description:'送付履歴・本人の回答を確認してください。送付だけでは承諾済みになりません。',action:'notice',cta:'通知書・回答状況を確認',waiting:!expired,dueAt:legacy.respondBy||null,dueLabel:'回答期限',blocked:''};
    }
    if(a.decision==='hired'&&['offer','terms','agreement'].includes(phase)){
      const saved=candidateDocuments.some(x=>x.kind==='offer'&&['draft','published'].includes(x.status));
      return {...out,step:'offer',title:saved?'保管済みの内定通知書は、まだメール送付の記録がありません':'内定通知書の内容と送付先を確認してください',
        description:saved?'保管・公開とメール送付は別の操作です。送付する版を確認してから進めます。':'PDF・宛先・採用条件を確認してメール送信へ進みます。',action:'notice',cta:'内定通知の準備・送付を確認'};
    }
    if(docsError&&step==='screening')return {...out,title:'応募書類を取得できませんでした',description:docsError,action:'docs',cta:'書類の状態を確認'};
    if(guide.key==='decide')out.description='採用判断は権限者が行います。面談記録・評価を根拠に確認してください。';
    if(guide.key==='detail'&&step==='screening'){out.title=missingDocuments.length?missingDocuments.join('・')+'が未提出です':'応募内容・提出書類を確認してください';out.description=missingDocuments.length?'不足している書類を確認し、本人へ提出を案内してください。':'';out.cta='応募内容と書類を確認';}
    return out;
  }
  root.HRApplicantCompact={steps,describe};
})(globalThis);
