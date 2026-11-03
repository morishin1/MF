// Sales Company Review: read-only reference view from existing, tenant/RLS-scoped analytics.
// A missing review snapshot must not hide companies present in actual proposals.
(() => {
  const root = document.getElementById('company-proposal-reference-content');
  const tab = document.getElementById('db-tab-company');
  if (!root || !tab) return;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = v => Number(v || 0).toLocaleString('ja-JP');
  const pct = v => v == null ? '—' : Number(v).toFixed(1) + '%';
  let companies = [], shown = 15, loaded = false, loading = false, sequence = 0, note = '';

  function render() {
    if (!companies.length) {
      root.innerHTML = '<p>この期間に送信した提案先企業はありません。審査対象が0件であることとは別です。</p>';
      return;
    }
    const body = companies.slice(0, shown).map(c => {
      const reasons = (c.lossReasons || []).slice().sort((a,b) => Number(b.count || 0) - Number(a.count || 0));
      const reason = reasons.length ? (reasons[0].label || '理由不明') + ' ' + num(reasons[0].count) + '件' : '終了理由の記録なし';
      return '<tr><td><strong>' + esc(c.companyName || '企業名不明') + '</strong></td>' +
        '<td class="num">' + esc(num(c.sentCount)) + '</td><td class="num">' + esc(num(c.meetingCount)) +
        '</td><td class="num">' + esc(pct(c.rate)) + '</td><td>' + esc(reason) +
        '</td><td>要照合</td></tr>';
    }).join('');
    root.innerHTML = '<p class="db-short-note">' + esc(note) + '　表示 ' + num(Math.min(shown, companies.length)) +
      ' / ' + num(companies.length) + ' 企業レコード。企業名やIDが未照合のため重複の可能性があります。</p>' +
      '<div style="overflow-x:auto"><table class="sl-table"><thead><tr>' +
      '<th>企業</th><th>提案</th><th>面談</th><th>面談率</th><th>主な終了理由</th><th>評価</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      (shown < companies.length ? '<button type="button" data-more-companies class="btn btn-sm btn-secondary" style="margin-top:10px">さらに15件表示</button>' : '');
  }

  async function load() {
    if (loaded || loading) return;
    const ticket = ++sequence;
    loading = true;
    root.textContent = '提案先企業を取得中…';
    // JST calendar days, inclusive: today and the previous 89 days.
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0,10);
    const start = new Date(today + 'T00:00:00Z');
    start.setUTCDate(start.getUTCDate() - 89);
    const from = start.toISOString().slice(0,10);
    try {
      const params = new URLSearchParams({period:'custom',from,to:today});
      const result = await window.API.api('/api/sales/dashboard-analysis?' + params);
      if (ticket !== sequence) return;
      companies = Array.isArray(result.metrics?.byCompany) ? result.metrics.byCompany : [];
      shown = 15;
      const scope = result.dataStatus?.scope === 'assigned' ? '担当分' : '閲覧できる範囲';
      const sync = result.dataStatus?.sourceState === 'ready' ? '' : '・ENGER同期未確認';
      note = '期間 ' + from + '〜' + today + '（JST）・' + scope + sync +
        '。面談率は送信コホートの到達率です。正式な企業評価ではありません。';
      loaded = true;
      render();
    } catch (e) {
      if (ticket === sequence) root.textContent = e?.hint || e?.data?.hint || 'Salesの提案データを取得できません。閲覧権限・同期状態を確認してください。';
    } finally {
      if (ticket === sequence) loading = false;
    }
  }
  const onShow = () => { if (tab.getAttribute('aria-selected') === 'true') load(); };
  tab.addEventListener('click', () => Promise.resolve().then(onShow));
  window.addEventListener('popstate', () => Promise.resolve().then(onShow));
  root.addEventListener('click', e => {
    if (e.target.closest?.('[data-more-companies]')) { shown += 15; render(); }
  });
  onShow();
})();
