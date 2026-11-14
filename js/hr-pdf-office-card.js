// Accepted applicants enter the Office queue; contract checks remain unchanged.
(async () => {
  const me = await API.me().catch(() => null);
  if (!me || !KPLayout.hasAccess(me, 'officeHr')) return;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {contract_preparing:'契約・労働条件の確認',terms_preparing:'労働条件通知書の準備',terms_waiting:'本人の確認待ち',onboarding:'入社手続き',ready:'入社準備完了'};
  try {
    const data = await API.api('/api/hr/pdf-flow?office=1');
    if (!data.enabled) return;
    const box = document.createElement('section');
    box.className = 'card'; box.id = 'hr-agreement-queue';
    box.style.cssText = 'padding:18px;margin:16px 0;background:#fff;border:1px solid #dedfd9;border-radius:10px';
    box.innerHTML = `<h2 style="font-size:17px">HRで合意済み <span>${(data.flows || []).length}名</span></h2><p style="font-size:12px">内定通知書への合意を確認した方です。Officeで契約・労働条件の確認 → 入社準備へ進みます。</p>${(data.flows || []).map(f => {
      const id = f.applicantId || f.applicant_id;
      const canOpen = f.source !== 'legacy' || me.access?.recruit || me.isAdmin || me.gw?.isAdmin || me.gw?.roles?.includes('owner');
      const href = f.source === 'legacy' ? `/hr/applicants.html?id=${encodeURIComponent(id)}&workspace=office` : `/hr/pdf-flow.html?applicantId=${encodeURIComponent(id)}&scope=office`;
      return `<div id="agreement-${esc(id)}" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid #e2e2dc;padding:12px 0;scroll-margin-top:90px"><b>${esc(f.applicantName || f.name)}</b><span style="font-size:12px;flex:1">${esc(labels[f.phase] || f.phase)}</span>${canOpen ? `<a class="btn btn-primary btn-sm" href="${href}">次の手続きへ →</a>` : '<span style="font-size:12px">契約手続きは採用担当に確認してください</span>'}</div>`;
    }).join('') || '<p>対象はありません。</p>'}`;
    (document.querySelector('.wrap') || document.body).prepend(box);
    if (location.hash.startsWith('#agreement-')) document.getElementById(location.hash.slice(1))?.scrollIntoView({block:'center'});
  } catch (e) {
    if (['disabled','not_found','forbidden'].includes(e.code) || [403,404].includes(e.status)) return;
    const box = document.createElement('p'); box.setAttribute('role','status');
    box.textContent = '合意済みの入社準備を取得できません。再読み込みしてください。';
    (document.querySelector('.wrap') || document.body).prepend(box);
  }
})();
