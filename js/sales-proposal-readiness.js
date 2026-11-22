(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const choices = {
    contact: { direct:'決裁者・採用担当と直接', staff:'担当者と会話', mail:'メール中心・商流が深い' },
    hiring: { confirmed:'募集中を確認', stopped:'募集終了・停止' },
    budget: { yes:'予算あり', no:'予算なし' },
    candidateContact: { direct:'本人に直接', affiliate:'所属会社経由', sheet:'スキルシートのみ' },
    intent: { yes:'応募意思あり', no:'辞退' },
    dates: { yes:'候補日あり', no:'候補日なし' },
    offers: { none:'内定なし', pending:'内定あり・回答待ち', accepted:'他社で決定' },
    previousDeal: { yes:'以前の面談・成約を確認' },
    fitVerified: { yes:'必須スキルと類似案件の実績を確認' },
    interviewResult: { passed:'合格', failed:'不合格' },
    interviewReason: { skills:'必須スキル', experience:'実務経験・担当工程', communication:'業務上の説明・折衝', terms:'単価・働き方などの条件', timing:'採用・選考時期', other:'その他', unknown:'企業に未確認' },
  };
  const axes = { relationship:'企業との関係性', grip:'人材のグリップ', fit:'スキル・経験の適合', terms:'成約条件' };
  const terms = { rate:'単価', start:'開始日', location:'勤務地・働き方', flow:'商流' };
  const labels = {
    previousDeal:'過去の面談・成約', fitVerified:'実績の確認', contact:'企業の窓口', hiring:'募集状況', budget:'採用予算', candidateContact:'意思確認の経路',
    intent:'この案件への応募意思', dates:'面談候補日', offers:'他社の内定状況', interviewResult:'面談結果', interviewReason:'不合格理由（不合格時のみ）',
    hiringCount:'募集人数', interviewCount:'面談予定回数', otherInterviews:'他社の応募・選考件数',
    confirmedOn:'最終意思確認日', targetStart:'採用予定日', meetingDue:'面談予定日', ...terms,
  };
  const termOptions = { yes:'成立を確認', no:'条件差あり' };
  const numberFields = ['hiringCount','interviewCount','otherInterviews'];
  const humanValue = (key,value) => (choices[key] || termOptions)[value] || value;
  const row = (label,value) => value !== '' && value != null ? '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>' : '';
  const range = (min,max) => min != null ? (max == null ? min + '万円〜' : min === max ? min + '万円' : min + '〜' + max + '万円')
    : max != null ? '〜' + max + '万円' : '未登録';
  const percentage = (n,d) => Math.round(n / d * 1000) / 10;
  const rate = (n,d) => d ? n + '/' + d + '件（' + percentage(n,d) + '%）' : '記録なし';
  function editField(facts,key,type = 'select') {
    const current = facts[key] ?? '';
    const input = type === 'select' ? '<select name="' + key + '"><option value="">' + (key === 'interviewResult' ? '未記録' : '未確認') + '</option>' +
      Object.entries(choices[key] || termOptions).map(([val,label]) => '<option value="' + val + '"' + (current === val ? ' selected' : '') + '>' + esc(label) + '</option>').join('') + '</select>'
      : '<input type="' + type + '" name="' + key + '" value="' + esc(current) + '"' + (type === 'number' ? ' min="0" max="999" step="1" inputmode="numeric"' : '') + '>';
    return '<label>' + esc(labels[key]) + input + '</label>';
  }
  function editForm(data) {
    const f = data.facts;
    const all = (keys,type) => keys.map(k => editField(f,k,type)).join('');
    return '<form class="pp-readiness-form"><div class="pp-readiness-inputs">' +
      '<fieldset><legend>企業・案件</legend>' + all(['contact','hiring','budget','previousDeal']) + all(['hiringCount','interviewCount'],'number') + all(['targetStart','meetingDue'],'date') + '</fieldset>' +
      '<fieldset><legend>提案人材</legend>' + all(['candidateContact','intent','dates','offers']) + all(['confirmedOn'],'date') + all(['otherInterviews'],'number') +
      all(['fitVerified']) + (data.conditions.meetingHeld ? all(['interviewResult','interviewReason']) : '') + '</fieldset>' +
      '<fieldset><legend>成約条件</legend>' + all(Object.keys(terms)) + '</fieldset></div>' +
      '<label>確認した根拠<textarea name="note" rows="2" maxlength="400" placeholder="例　採用担当に電話し、募集２名と予算を確認">' + esc(f.note || '') + '</textarea></label>' +
      '<div class="pp-quick-actions"><button type="submit" class="btn btn-primary btn-sm">保存</button><button type="button" class="btn btn-secondary btn-sm" data-readiness-cancel>閉じる</button></div>' +
      '<p role="status" data-readiness-message></p></form>';
  }
  function info(data) {
    const { facts:f, history:h, conditions:c, fit, interview } = data;
    const fields = keys => keys.map(key => row(labels[key], humanValue(key,f[key]))).join('');
    const contactReply = key => ({proceed:'話を進める',pass:'見送り'})[data[key]] || '未記録';
    const feedback = h?.interviewFeedback;
    const feedbackReasons = Object.entries(feedback?.reasons || {}).map(([key,n]) =>
      (choices.interviewReason[key] || 'その他') + ' ' + n + '件').join('、');
    const feedbackDetail = feedback && feedback.passed + feedback.failed
      ? row('合格／不合格（結果記録済み）',feedback.passed + '件／' + feedback.failed + '件') +
        row('不合格の理由（確認済み）',feedbackReasons) +
        (feedback.unknown ? row('理由未確認',feedback.unknown + '件') : '') : '';
    const trend = feedback?.dominant && h?.basis !== '同じ提案先企業名'
      ? '<p class="pp-readiness-trend">過去の面談結果から、' +
        esc(choices.interviewReason[feedback.dominant.reason]) + 'が' +
        esc(feedback.dominant.count) + '/' + esc(feedback.dominant.of) +
        '件で記録されています。面談前の確認に活用してください（合否予測ではありません）。</p>' : '';
    const history = h ? '<dl>' + row('集計対象',h.basis + (h.limited ? '・直近250提案' : '')) + row('提案送信',h.sent + '件') +
      row('面談実施／提案',rate(h.meetings,h.sent)) + row('合格／面談実施',rate(h.passed,h.meetings)) + row('成約／提案',rate(h.won,h.sent)) +
      row('見送りの理由',Object.entries(h.lost).map(([name,n]) => name + ' ' + n + '件').join('、')) + feedbackDetail + '</dl>' + trend : '<p>企業の実績を取得できません。</p>';
    const comparison = fit.checks.length ? '<ul>' + fit.checks.map(check => '<li>' + esc(check.requirement) + ' <strong>' +
      (check.matches.length ? '登録スキルに ' + esc(check.matches.join('・')) : '裏づけ未確認') + '</strong></li>').join('') + '</ul>' : '<p>必須条件を確認できる記載がありません。</p>';
    const bullet = (title, items) => items.length ? '<div><strong>' + title + '</strong><ul>' + items.map(v => '<li>' + esc(v) + '</li>').join('') + '</ul></div>' : '';
    return '<details class="pp-readiness-evidence"><summary>判断の根拠・企業の実績</summary>' +
      '<div class="pp-readiness-info"><section><h4>企業・案件</h4><dl>' + row('ENGERでの回答',contactReply('companyReply')) +
      fields(['contact','hiring','budget','previousDeal','hiringCount','interviewCount','targetStart','meetingDue']) + row('案件単価（月額）',range(c.jobMin,c.jobMax)) +
      row('開始日',c.jobStart) + row('勤務地',c.location) + row('商流',c.flow) + '</dl><h4>提案先企業の実績</h4>' + history + '</section>' +
      '<section><h4>提案人材</h4><dl>' + row('ENGERでの回答',contactReply('candidateReply')) +
      fields(['candidateContact','intent','confirmedOn','dates','offers','otherInterviews','interviewResult','interviewReason','fitVerified']) +
      row('希望単価（月額）',range(c.talentMin,c.talentMax)) + row('稼働開始',c.talentStart) + row('働き方',c.remote) +
      row('確認した根拠',f.note) + '</dl></section></div>' +
      '<section class="pp-readiness-fit"><h4>必須条件と実務経験の確認</h4>' + comparison + '<dl>' +
      row('案件・人材の共通スキル',fit.matched.join('・')) + row('案件スキルの登録なし',fit.missing.join('・')) +
      row('必要経験',fit.minYears == null ? null : fit.minYears + '年以上') + row('登録されている経験',fit.experience) + '</dl>' +
      '<h4>面談の準備</h4>' +
      (interview ? '<p class="pp-simple-meta">' + (fit.ai ? 'ENGER AIの分析' : '登録済み要件から作成したAIの確認案') + '</p>' +
        bullet('強み',interview.strengths) + bullet('懸念点',interview.concerns) + bullet('面談前に聞くこと',interview.questions)
        : '<p>類似案件の役割・成果、自走した範囲、顧客折衝の経験を確認します。</p>') +
      (data.canAnalyze ? '<button type="button" class="btn btn-secondary btn-sm" data-readiness-analyze>AI分析</button>' : '') + '</section></details>';
  }
  function mount(root, id) {
    const path = '/api/sales/proposals/readiness';
    let data;
    let editing = false;
    function editState(value) {
      editing = value;
      root.closest('.pp-detail-workspace')?.classList.toggle('pp-readiness-editing', value);
    }
    function render() {
      const {assessment:a} = data;
      root.innerHTML = '<header><h3>成約分析</h3><span class="pp-readiness-grade" data-grade="' + esc(a.grade || '') + '">' +
        (a.grade ? '成約見込み ' + esc(a.grade) : '見込み未評価') + '</span>' +
        (data.canEdit && !editing ? '<button type="button" class="btn btn-secondary btn-sm" data-readiness-edit>編集</button>' : '') + '</header>' +
        '<p class="pp-readiness-next"><b>次にやること</b> ' + esc(a.next) + '</p>' +
        (Array.isArray(a.steps) && a.steps.length ? '<div class="pp-readiness-steps"><b>面談合格に向けた確認</b><ol>' +
          a.steps.map(step => '<li><strong>' + esc(step.area) + '</strong> ' + esc(step.action) + '</li>').join('') + '</ol></div>' : '') +
        '<dl class="pp-readiness-axes">' + Object.entries(axes).map(([key,label]) => {
          const item = a.dimensions[key];
          return '<div><dt>' + label + '</dt><dd><strong data-grade="' + esc(item.grade || '') + '">' + esc(item.grade || '未確認') +
            '</strong> <span>' + esc(item.why) + '</span></dd></div>';
        }).join('') + '</dl>' + (editing ? editForm(data) : info(data)) +
        '<p class="pp-readiness-feedback" role="status" data-readiness-feedback></p>';
    }
    async function send(action, fields, button, message) {
      if (button.disabled) return;
      button.disabled = true;
      message.textContent = action === 'analyze' ? '分析中…' : '保存中…';
      try {
        const result = await API.api(path,{method:'POST',body:{id,revision:data.revision,action,...fields}});
        if (!root.isConnected) return;
        data = result;
        editState(false); render();
        if (action === 'analyze') root.querySelector('details').open = true;
        root.querySelector('[data-readiness-feedback]').textContent = action === 'save' ? '保存しました' : '分析しました';
        root.querySelector('[data-readiness-edit]')?.focus({preventScroll:true});
      } catch (error) {
        message.textContent = error?.hint || (error?.code === 'assessment_changed' ? '別の更新があります。提案を開き直してください。' : '操作できませんでした。もう一度お試しください。');
      } finally { button.disabled = false; }
    }
    root.addEventListener('click', event => {
      if (event.target.closest('[data-readiness-edit]')) {
        editState(true); render(); root.querySelector('form select')?.focus({preventScroll:true});
      } else if (event.target.closest('[data-readiness-cancel]')) {
        editState(false); render(); root.querySelector('[data-readiness-edit]')?.focus({preventScroll:true});
      } else {
        const button = event.target.closest('[data-readiness-analyze]');
        if (button) send('analyze',{},button,root.querySelector('[data-readiness-feedback]'));
      }
    });
    root.addEventListener('submit', event => {
      if (!event.target.matches('.pp-readiness-form')) return;
      event.preventDefault();
      const facts = {...data.facts,...Object.fromEntries(new FormData(event.target))};
      for (const key of numberFields) facts[key] = facts[key] ? Number(facts[key]) : null;
      if (facts.interviewResult !== 'failed') facts.interviewReason = '';
      send('save',{facts},event.submitter,event.target.querySelector('[data-readiness-message]'));
    });
    API.api(path + '?id=' + encodeURIComponent(id)).then(result => {
      if (!root.isConnected) return;
      data = result; render();
    }).catch(() => {
      if (root.isConnected) root.textContent = '成約分析を取得できません。提案を開き直してください。';
    });
  }
  window.SalesProposalReadiness = { mount };
})();
