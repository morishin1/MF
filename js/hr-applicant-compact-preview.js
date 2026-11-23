// Isolated visual prototype. No applicant APIs, uploads, email or persistent storage.
(() => {
  const $ = id => document.getElementById(id);
  const overlay = $('overlay'), dialog = $('applicant-dialog');
  const feedback = message => { $('preview-feedback').textContent = message; };
  const steps = ['screening','interview','decision','offer','handoff'];
  let previousFocus = $('reopen'), scenario = 'screening', offerDocumentName = '', mailMode = null;
  let requestSent = false, reviewedSignature = '', interviewScheduled = false;
  const applicationFiles = { 'resume-file':'', 'history-file':'', 'skill-file':'' };
  const offerScenarios = ['offer','offer_ready','sent','handoff'];
  function openDialog() { previousFocus = document.activeElement; overlay.hidden = false; $('close-dialog').focus(); }
  function closeDialog() { overlay.hidden = true; previousFocus?.focus(); }
  function openSection(id, focusId) {
    $(id).open = true;
    $(focusId || id).scrollIntoView({block:'nearest',behavior:'auto'});
    if (focusId) $(focusId).focus();
  }
  function addHistory(note) {
    const item = document.createElement('li'), time = document.createElement('time'), text = document.createElement('span');
    time.textContent = new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
    text.textContent = note; item.append(time,text); $('history-list').prepend(item);
    $('history-summary').textContent = $('history-list').children.length + '件';
  }
  function missingDocuments() { return ['resume-file','history-file'].filter(id => !applicationFiles[id]).length; }
  function renderProgress() {
    const offer = offerScenarios.includes(scenario), missing = missingDocuments();
    let step = scenario, status = '', issue = '', explanation = '', action = '', actionKey = '';
    if (scenario === 'screening') {
      status = '事前選考';
      issue = missing ? `応募書類が${missing}件未提出です` : '面談へ進めるか確認が必要です';
      explanation = missing ? requestSent ? '提出依頼済みです。書類が届いたら内容を確認します。' : '履歴書・職務経歴書の不足分を確認し、提出を案内します。' : '応募内容を確認し、次の面談を設定します。';
      action = missing ? requestSent ? '書類の状態を確認' : '提出依頼メールを準備' : '面談を設定する';
      actionKey = missing ? requestSent ? 'docs' : 'request' : 'interview';
    } else if (scenario === 'interview') {
      status = interviewScheduled ? '面談予定あり' : '面談日程の調整中';
      issue = interviewScheduled ? '面談の実施・評価が次の対応です' : '面談日時がまだ決まっていません';
      explanation = interviewScheduled ? '面談後に記録・評価を残し、採用判断へ進めます。' : '本人と日程を調整し、面談予定を登録します。';
      action = interviewScheduled ? '面談記録を開く' : '面談日時を設定'; actionKey = 'interview';
    } else if (scenario === 'decision') {
      status = '採用判断待ち'; issue = '面談後の採用判断が未確定です';
      explanation = '面談記録・評価を確認し、権限者が採用・保留・見送りを判断します。';
      action = '面談・評価を確認'; actionKey = 'interview';
    } else if (scenario === 'sent') {
      step = 'offer'; status = '内定通知送付済み・回答待ち'; issue = '本人の回答を待っています';
      explanation = '通知書の送付まで完了。承諾の確認後にOfficeへ引き継ぎます。';
      action = '送付履歴を確認'; actionKey = 'history';
    } else if (scenario === 'handoff') {
      status = 'Office引継ぎ待ち'; issue = '本人の承諾は確認済みです';
      explanation = '採用条件と本人の回答をOfficeへ引き継ぎ、正式契約・入社準備へ進みます。';
      action = '引継ぎ内容を確認'; actionKey = 'handoff';
    } else {
      step = 'offer'; status = offerDocumentName ? '内定通知の送付待ち' : '内定通知書の準備中';
      issue = offerDocumentName ? '内定通知書を本人へ送付してください' : '内定通知書のPDFが未登録です';
      explanation = offerDocumentName ? '宛先・本文・添付PDFを確認してメールを送ります。' : '採用決定済みです。本人へ送る内定通知書を用意します。';
      action = offerDocumentName ? '内定通知メールを準備' : '内定通知書を登録';
      actionKey = offerDocumentName ? 'offer-mail' : 'docs';
    }
    $('status-badge').textContent = status;
    $('issue-title').textContent = issue; $('issue-detail').textContent = explanation;
    $('next-action').textContent = action; $('next-action').dataset.action = actionKey;
    $('issue-owner').textContent = $('recruiter-name').textContent;
    $('issue-deadline').textContent = scenario === 'sent' ? '回答期限：11/27' : '期限：未設定';
    $('issue-label').textContent = scenario === 'sent' ? 'いまの状態' : 'いまの課題';
    document.querySelector('.issue-card').classList.toggle('is-waiting',scenario === 'sent');
    const current = steps.indexOf(step);
    document.querySelectorAll('[data-step]').forEach((node,index) => {
      node.classList.toggle('is-complete',index < current);
      if (index === current) node.setAttribute('aria-current','step'); else node.removeAttribute('aria-current');
    });
    $('offer-document').hidden = !offer;
    $('offer-filename').textContent = offerDocumentName || '未登録';
    $('offer-state').textContent = scenario === 'sent' || scenario === 'handoff' ? '送付済み' : offerDocumentName ? 'PDF準備済み' : 'PDF未登録';
    $('prepare-offer-mail').disabled = !offerDocumentName || ['sent','handoff'].includes(scenario);
    $('prepare-offer-mail').hidden = ['sent','handoff'].includes(scenario);
    $('offer-file-help').textContent = ['sent','handoff'].includes(scenario) ? '送付済みの通知書とメールは履歴から確認します。' : 'PDFを登録すると、宛先・本文・添付を確認できます。';
    $('docs-summary').textContent = offer ? $('offer-state').textContent : missing ? `未提出 ${missing}件` : '提出済み 2件';
    $('docs-summary').classList.toggle('warning',offer ? !offerDocumentName : Boolean(missing));
  }
  function applyScenario(value) {
    scenario = value; requestSent = false; interviewScheduled = false; reviewedSignature = ''; mailMode = null;
    $('outbound-form').hidden = true; $('mail-review').hidden = true; $('mail-confirm').checked = false;
    const later = value !== 'screening';
    applicationFiles['resume-file'] = later ? '履歴書_サンプル.pdf' : '';
    applicationFiles['history-file'] = later ? '職務経歴書_サンプル.pdf' : '';
    for (const [id,name] of Object.entries(applicationFiles)) {
      $(id).value = ''; $( $(id).dataset.fileLabel ).textContent = name || (id === 'skill-file' ? '任意' : '未提出');
    }
    $('offer-file').value = ''; offerDocumentName = ['offer_ready','sent','handoff'].includes(value) ? '内定通知書_サンプル.pdf' : '';
    $('email-value').textContent = later ? 'candidate@example.com' : '未登録';
    $('email-value').classList.toggle('muted',!later); $('email-input').value = later ? 'candidate@example.com' : '';
    $('edit-email').textContent = later ? '編集' : '登録する';
    $('recruitment-type').value = later ? 'trial_2weeks' : '';
    $('category-help').textContent = later ? '選択済み' : '区分を選択';
    $('phase-value').textContent = offerScenarios.includes(value) ? '採用決定済み' : value === 'decision' ? '採用判断' : value === 'interview' ? 'カジュアル面談' : '事前選考';
    $('interview-summary').textContent = value === 'screening' || value === 'interview' ? '予定なし' : '実施済み';
    ['section-docs','section-interview','section-history'].forEach(id => $(id).open = false);
    $('section-info').open = true;
    renderProgress(); feedback('表示例を切り替えました。実際の応募者情報は変更していません');
  }
  function invalidateReview() {
    reviewedSignature = ''; $('mail-review').hidden = true; $('mail-confirm').checked = false; $('send-preview').disabled = true;
  }
  function mailSignature() { return JSON.stringify([scenario,mailMode,$('outbound-email').value.trim(),$('outbound-subject').value,$('outbound-body').value,offerDocumentName]); }
  function prepareMail(mode) {
    if (mode === 'offer' && (!['offer','offer_ready'].includes(scenario) || !offerDocumentName)) return;
    if (mailMode !== mode) {
      $('outbound-email').value = $('email-input').value;
      $('outbound-subject').value = mode === 'offer' ? '【株式会社エイト】内定通知書のご送付' : '【株式会社エイト】応募書類ご提出のお願い';
      $('outbound-body').value = mode === 'offer' ? '山田 花子 様\n\nこのたびは弊社の採用選考にご参加いただき、ありがとうございます。\n内定通知書を添付いたします。内容をご確認のうえ、11月27日までにご回答をお願いいたします。\n\n株式会社エイト 採用担当' : '山田 花子 様\n\nこのたびは弊社の求人にご応募いただき、ありがとうございます。\n履歴書・職務経歴書をご提出いただけますでしょうか。\n\n株式会社エイト 採用担当';
    }
    mailMode = mode; invalidateReview();
    $('outbound-title').textContent = mode === 'offer' ? '内定通知書をメールで送る' : '応募書類の提出依頼';
    $('mail-attachment').hidden = mode !== 'offer'; $('attachment-name').textContent = offerDocumentName;
    $('outbound-form').hidden = false; openSection('section-history','outbound-email');
  }
  $('reopen').addEventListener('click', openDialog);
  $('close-dialog').addEventListener('click', closeDialog);
  document.addEventListener('keydown', e => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    if (e.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button,input,select,textarea,summary,a[href]')].filter(n => !n.disabled && n.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  $('sample-scenario').addEventListener('change',e => applyScenario(e.target.value));
  $('recruitment-type').addEventListener('change', e => { $('category-help').textContent = e.target.value ? '選択済み' : '区分を選択'; feedback('採用予定区分をプレビューに反映しました'); });
  $('next-action').addEventListener('click',e => {
    const key = e.currentTarget.dataset.action;
    if (key === 'request' || key === 'offer-mail') return prepareMail(key === 'request' ? 'request' : 'offer');
    if (key === 'interview') return openSection('section-interview','interview-date');
    if (key === 'docs') { openSection('section-docs'); if (offerScenarios.includes(scenario)) $('offer-document').scrollIntoView({block:'nearest'}); return; }
    if (key === 'history') return openSection('section-history');
    if (key === 'handoff') { openSection('section-docs'); feedback('Office引継ぎの表示例です。実際の引継ぎは行いません'); }
  });
  for (const key of ['email','recruiter','phase']) $('edit-' + key).addEventListener('click', () => { $(key + '-form').hidden = false; $(key + '-input').focus(); });
  document.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', () => { $(button.dataset.cancel).hidden = true; $('edit-' + button.dataset.cancel.replace('-form','')).focus(); }));
  $('email-form').addEventListener('submit', e => {
    e.preventDefault(); $('email-value').textContent = $('email-input').value.trim(); $('email-value').classList.remove('muted'); $('edit-email').textContent = '編集';
    $('email-form').hidden = true; $('edit-email').focus(); invalidateReview(); feedback('メールをプレビューに反映しました');
  });
  $('recruiter-form').addEventListener('submit', e => { e.preventDefault(); $('recruiter-name').textContent = $('recruiter-input').value; $('recruiter-form').hidden = true; $('edit-recruiter').focus(); renderProgress(); feedback('担当をプレビューに反映しました'); });
  $('phase-form').addEventListener('submit', e => {
    e.preventDefault(); $('phase-value').textContent = $('phase-input').value;
    scenario = $('phase-input').value === '事前選考' ? 'screening' : 'interview';
    $('phase-form').hidden = true; $('edit-phase').focus(); renderProgress(); feedback('選考段階をプレビューに反映しました');
  });
  document.querySelectorAll('[data-file-label]').forEach(input => input.addEventListener('change', () => {
    const file = input.files?.[0]; applicationFiles[input.id] = file?.name || '';
    $(input.dataset.fileLabel).textContent = file?.name || (input.id === 'skill-file' ? '任意' : '未提出');
    renderProgress(); feedback(file ? 'ファイル名を表示しました（アップロードは行いません）' : 'ファイル選択を解除しました');
  }));
  $('offer-file').addEventListener('change',() => {
    const file = $('offer-file').files?.[0];
    offerDocumentName = file && /\.pdf$/i.test(file.name) ? file.name : '';
    invalidateReview(); renderProgress(); feedback(offerDocumentName ? '内定通知書のファイル名を表示しました（アップロードは行いません）' : '内定通知書はPDFを選んでください');
  });
  $('prepare-offer-mail').addEventListener('click',() => prepareMail('offer'));
  $('cancel-mail').addEventListener('click',() => { $('outbound-form').hidden = true; invalidateReview(); });
  ['outbound-email','outbound-subject','outbound-body'].forEach(id => $(id).addEventListener('input',invalidateReview));
  $('outbound-form').addEventListener('submit', e => {
    e.preventDefault();
    if (mailMode === 'offer' && (!offerDocumentName || !['offer','offer_ready'].includes(scenario))) return;
    $('review-email').textContent = $('outbound-email').value.trim(); $('review-subject').textContent = $('outbound-subject').value;
    $('review-attachment').textContent = mailMode === 'offer' ? offerDocumentName : 'なし';
    reviewedSignature = mailSignature(); $('mail-review').hidden = false; $('mail-confirm').checked = false; $('send-preview').disabled = true;
    $('mail-review').scrollIntoView({block:'nearest'});
  });
  $('mail-confirm').addEventListener('change',() => { $('send-preview').disabled = !$('mail-confirm').checked || reviewedSignature !== mailSignature(); });
  $('send-preview').addEventListener('click',() => {
    if (!$('mail-confirm').checked || reviewedSignature !== mailSignature()) return;
    if (mailMode === 'offer') {
      if (!offerDocumentName || !['offer','offer_ready'].includes(scenario)) return;
      scenario = 'sent'; $('sample-scenario').value = 'sent'; addHistory('【サンプル】内定通知書をメール送付した状態');
    } else { requestSent = true; addHistory('【サンプル】応募書類の提出依頼メールを送付した状態'); }
    $('outbound-form').hidden = true; invalidateReview(); renderProgress();
    document.querySelector('.dialog-body').scrollTop = 0;
    $('next-action').focus(); feedback('送付済みの表示に切り替えました。実際のメールは送信していません');
  });
  $('interview-form').addEventListener('submit', e => {
    e.preventDefault(); interviewScheduled = true; if (scenario === 'screening') scenario = 'interview';
    $('interview-summary').textContent = $('interview-date').value.replace('T',' ').slice(5);
    $('interview-feedback').textContent = 'プレビューに反映しました'; renderProgress(); feedback('面談予定をプレビューに反映しました');
  });
  $('memo-form').addEventListener('submit', e => {
    e.preventDefault(); const note = $('memo-input').value.trim(); if (!note) return;
    addHistory(note); $('memo-input').value = ''; $('memo-feedback').textContent = 'プレビューに追加しました'; feedback('対応メモをプレビューに追加しました');
  });
  renderProgress(); dialog.focus();
})();
