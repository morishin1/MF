// Display one centered dialog at a time and preserve the applicant's context.
(function (root) {
  'use strict';
  const ids = ['modal-root', 'action-root', 'hr-modal-root', 'confirm-root', 'pdf-preview-root'];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const previousFocus = new Map();
  let active = null, activeDialog = null, pdf = null;

  function sync() {
    const populated = ids.map(id => document.getElementById(id)).filter(n => n?.children.length);
    const next = populated.at(-1) || null;
    for (const id of ids) {
      const n = document.getElementById(id);
      if (!n) continue;
      n.hidden = Boolean(n.children.length && n !== next);
      n.inert = n.hidden;
      if (n.hidden) n.setAttribute('aria-hidden', 'true');
      else n.removeAttribute('aria-hidden');
    }
    document.body.classList.toggle('hr-dialog-open', Boolean(next));
    const page = document.querySelector('body > .wrap');
    if (page) page.inert = Boolean(next);
    const dialog = next?.querySelector(".hr-detail,.hr-modal");
    if (next === active && dialog === activeDialog) return;
    activeDialog = dialog;
    const former = active;
    active = next;
    if (next) {
      if (!previousFocus.has(next)) previousFocus.set(next, document.activeElement);
      if (dialog) {
        if (!dialog.hasAttribute('role')) dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('tabindex', '-1');
        if (!dialog.hasAttribute('aria-label')) dialog.setAttribute('aria-label', next.id === 'modal-root' ? '応募者の詳細' : '採用手続き');
      }
      const returning = previousFocus.get(former);
      if (returning?.isConnected && next.contains(returning)) returning.focus({ preventScroll: true });
      else dialog?.focus({ preventScroll: true });
    } else {
      const focus = previousFocus.get(former);
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    }
    for (const n of previousFocus.keys()) if (!n.children.length) previousFocus.delete(n);
  }

  function closePdf() {
    const n = document.getElementById('pdf-preview-root');
    if (n) n.innerHTML = '';
    if (pdf?.ownsUrl) URL.revokeObjectURL(pdf.url);
    pdf = null;
    sync();
  }

  function showDocument({ title = 'PDFを見る', url, filename = 'document.pdf', mimeType = 'application/pdf', ownsUrl = false }) {
    if (typeof url !== 'string' || !url) throw Error('書類のURLを確認できませんでした');
    const parsed = new URL(url, location.href);
    if (!['https:', 'blob:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('書類のURLを確認できませんでした');
    closePdf();
    pdf = { url: parsed.href, ownsUrl };
    const body = mimeType === 'application/pdf'
      ? `<iframe class="hr-pdf-viewer" title="${esc(title)}" src="${esc(parsed.href)}#view=FitH"></iframe>`
      : mimeType.startsWith('image/')
        ? `<img class="hr-document-image" alt="${esc(title)}" src="${esc(parsed.href)}">`
        : '<p>この形式は画面内で表示できません。ファイルを保存して確認してください。PDFで登録すると、この画面で見ることができます。</p>';
    document.getElementById('pdf-preview-root').innerHTML = `
      <div class="hr-modal-bg" onclick="HRModalUI.closePdf()"></div>
      <section class="hr-modal hr-pdf-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="hr-pdf-heading"><h2>${esc(title)}</h2><button class="btn btn-secondary btn-sm" onclick="HRModalUI.closePdf()">閉じる</button></div>
        ${body}
        <div class="hr-pdf-footer"><a class="btn btn-secondary" href="${esc(parsed.href)}" download="${esc(filename)}">${mimeType === 'application/pdf' ? 'PDFを保存する' : 'ファイルを保存する'}</a><button class="btn btn-primary" onclick="HRModalUI.closePdf()">戻る</button></div>
      </section>`;
    sync();
  }

  function closeTop() {
    if (active?.id === 'pdf-preview-root') return closePdf();
    const fn = { 'confirm-root': 'closeConfirm', 'hr-modal-root': 'closeHrModal', 'action-root': 'closeAction', 'modal-root': 'closeModal' }[active?.id];
    if (fn && typeof root[fn] === 'function') root[fn]();
    sync();
  }

  for (const id of ids) {
    const n = document.getElementById(id);
    if (n) new MutationObserver(sync).observe(n, { childList: true, subtree: true });
  }
  document.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      closeTop();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...active.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,summary,[tabindex]:not([tabindex="-1"])')]
      .filter(n => {
        if(n.tabIndex<0 || n.closest('[hidden],.hidden'))return false;
        for(let parent=n.parentElement;parent&&parent!==active;parent=parent.parentElement){
          if(parent.tagName==='DETAILS'&&!parent.open&&!(n.tagName==='SUMMARY'&&n.parentElement===parent))return false;
        }
        return true;
      });
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  });
  root.addEventListener('pagehide', () => { if (pdf?.ownsUrl) URL.revokeObjectURL(pdf.url); });
  root.HRModalUI = { sync, showDocument, closePdf };
  sync();
})(window);
