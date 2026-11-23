// Isolated visual prototype. No applicant APIs, uploads, email or persistent storage.
(() => {
  const $ = id => document.getElementById(id);
  const overlay = $('overlay'), dialog = $('applicant-dialog');
  const feedback = message => { $('preview-feedback').textContent = message; };
  let previousFocus = $('reopen');
  function openDialog() { previousFocus = document.activeElement; overlay.hidden = false; $('close-dialog').focus(); }
  function closeDialog() { overlay.hidden = true; previousFocus?.focus(); }
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
  $('recruitment-type').addEventListener('change', e => {
    $('category-help').textContent = e.target.value ? '選択済み' : '区分を選択';
    feedback('採用予定区分をプレビューに反映しました');
  });
  for (const key of ['email','recruiter','phase']) {
    $('edit-' + key).addEventListener('click', () => { $(key + '-form').hidden = false; $(key + '-input').focus(); });
  }
  document.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', () => {
    $(button.dataset.cancel).hidden = true;
    $('edit-' + button.dataset.cancel.replace('-form','')).focus();
  }));
  $('email-form').addEventListener('submit', e => {
    e.preventDefault(); $('email-value').textContent = $('email-input').value.trim();
    $('email-value').classList.remove('muted'); $('edit-email').textContent = '編集';
    $('email-form').hidden = true; $('edit-email').focus(); feedback('メールをプレビューに反映しました');
  });
  $('recruiter-form').addEventListener('submit', e => {
    e.preventDefault(); $('recruiter-name').textContent = $('recruiter-input').value;
    $('recruiter-form').hidden = true; $('edit-recruiter').focus(); feedback('担当をプレビューに反映しました');
  });
  $('phase-form').addEventListener('submit', e => {
    e.preventDefault(); $('phase-value').textContent = $('phase-input').value;
    $('phase-form').hidden = true; $('edit-phase').focus(); feedback('選考段階をプレビューに反映しました');
  });
  document.querySelectorAll('[data-file-label]').forEach(input => input.addEventListener('change', () => {
    const file = input.files?.[0];
    $(input.dataset.fileLabel).textContent = file?.name || (input.id === 'skill-file' ? '任意' : '未提出');
    const missing = ['resume-file','history-file'].filter(id => !$(id).files?.length).length;
    $('docs-summary').textContent = missing ? `未提出 ${missing}件` : '2件 選択済み';
    $('docs-summary').classList.toggle('warning', Boolean(missing));
    feedback(file ? 'ファイル名を表示しました（アップロードは行いません）' : 'ファイル選択を解除しました');
  }));
  $('interview-form').addEventListener('submit', e => {
    e.preventDefault();
    const value = $('interview-date').value;
    $('interview-summary').textContent = value.replace('T',' ').slice(5);
    $('interview-feedback').textContent = 'プレビューに反映しました';
    feedback('面談予定をプレビューに反映しました');
  });
  $('memo-form').addEventListener('submit', e => {
    e.preventDefault(); const note = $('memo-input').value.trim(); if (!note) return;
    const item = document.createElement('li'), time = document.createElement('time'), text = document.createElement('span');
    time.textContent = new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
    text.textContent = note; item.append(time,text); $('history-list').prepend(item);
    $('history-summary').textContent = $('history-list').children.length + '件';
    $('memo-input').value = ''; $('memo-feedback').textContent = 'プレビューに追加しました'; feedback('対応メモをプレビューに追加しました');
  });
  $('close-dialog').focus();
})();
