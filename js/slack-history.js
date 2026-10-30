// Sent Slack summaries only. No email imports, sends or persistent browser storage.
(async function () {
  'use strict';
  const department = document.body.dataset.slackDepartment;
  const channels = {hr:'C0CCSBTDB1S',office:'C0CCLMUQZ7G',sales:'C0CCQHQN3SM'};
  const state = document.getElementById('slack-history-state');
  const list = document.getElementById('slack-history-list');
  const refresh = document.getElementById('slack-history-refresh');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => {const d = new Date(value);return value && Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'medium',timeStyle:'short'}).format(d) + ' JST' : '確認できません';};
  function permalink(value) {
    try {const u = new URL(value);return u.protocol === 'https:' && u.hostname === '8grp.slack.com' && !u.username && !u.password && !u.search && !u.hash && new RegExp('^/archives/'+channels[department]+'/p[0-9]{16}$').test(u.pathname) ? u.href : null;} catch {return null;}
  }
  let pending = false;
  async function load() {
    if(pending)return;
    pending = true; refresh.disabled = true; list.replaceChildren();state.textContent='送信済みの履歴を確認しています…';
    try {
      const result = await API.api('/api/slack-history?department='+encodeURIComponent(department));
      if(result.ready === false)throw {code:'not_ready'};
      if(!Array.isArray(result.history))throw new Error('invalid_response');
      // Fail closed if a malformed response includes another department or a non-sent row.
      const rows = result.history.filter(r => r && r.department === department && r.sent_at && Number.isFinite(Date.parse(r.sent_at)) && (!r.status || r.status === 'sent'));
      if(rows.length !== result.history.length)throw new Error('invalid_response');
      list.innerHTML = rows.map(r => {
        const url = permalink(r.slack_permalink);
        const coverage = r.coverage_status === 'complete' ? '<p class="slack-history-meta">対象情報の確認：完了</p>' : '<p class="slack-history-warning">対象情報の確認：'+(r.coverage_status === 'partial' ? '取得不足' : '未確認')+(r.coverage_note ? '\n'+esc(r.coverage_note) : '')+'</p>';
        return '<article class="slack-history-card"><h2>Slack送信済み</h2><p class="slack-history-meta">送信日時：'+esc(date(r.sent_at))+'<br>確認対象：'+esc(date(r.period_start))+' ～ '+esc(date(r.period_end))+'</p>'+coverage+'<p class="slack-history-summary">'+esc(r.summary)+'</p>'+(url ? '<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">Slackの投稿を開く <span aria-hidden="true">↗</span></a>' : '<p class="slack-history-warning">投稿リンクを確認できません。</p>')+'</article>';
      }).join('');
      state.textContent = rows.length ? '送信済み '+rows.length+'件'+(result.capped ? '（表示上限に達しています）' : '') : '送信済みのSlack通知履歴はまだありません。メールの確認が完了したことを意味するものではありません。';
    } catch(e) {
      list.replaceChildren();state.textContent = ['not_ready','history_not_ready'].includes(e.code||e.error) || e.status === 503 ? 'Slack通知履歴は準備中です。設定・保存先の確認が完了するまで履歴は表示できません。' : e.status === 403 ? 'この部門の通知履歴を閲覧する権限がありません。' : '通知履歴を取得できませんでした。履歴を更新して再確認してください。';
    } finally {pending=false;refresh.disabled=false;}
  }
  if(!channels[department]){state.textContent='対象の部門を確認できません。';return;}
  try {
    const ctx = department === 'hr' ? await HRLayout.init({active:'applicants',verify:true}) : department === 'sales' ? await SalesLayout.init({active:'dashboard'}) : await OfficeLayout.init({active:'home',access:['office','officeHr','officeFinance']});
    if(!ctx){state.textContent='この履歴を表示できません。';return;}
    const record=document.getElementById('slack-history-record');
    if(record && ctx.me?.gw?.roles?.includes('owner')){record.href='/slack-history-record.html?department='+encodeURIComponent(department);record.hidden=false;}
    refresh.addEventListener('click',load);await load();
  } catch {state.textContent='アクセス権を確認できませんでした。ページを再読み込みしてください。';}
})();
