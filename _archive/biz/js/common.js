// DriveKeiri - 法人向けサイドバー

function renderBizSidebar(activeKey) {
  const openCount = AI_QUESTIONS.filter(q => q.status === "open").length;
  return `
    <nav class="sidebar">
      <div class="sidebar-brand">
        <h1>DriveKeiri</h1>
        <p>スキャンするだけの経理</p>
      </div>
      <div class="sidebar-nav">
        <div class="sidebar-section">メイン</div>
        <a href="home.html" class="${activeKey === 'home' ? 'active' : ''}">
          <span class="material-symbols-outlined">home</span> ホーム
        </a>
        <a href="drive.html" class="${activeKey === 'drive' ? 'active' : ''}">
          <span class="material-symbols-outlined">cloud</span> Google Drive
        </a>
        <a href="processing.html" class="${activeKey === 'processing' ? 'active' : ''}">
          <span class="material-symbols-outlined">inventory_2</span> 書類の処理状況
        </a>
        <a href="questions.html" class="${activeKey === 'questions' ? 'active' : ''}" style="position:relative;">
          <span class="material-symbols-outlined">chat</span> AIからの質問
          ${openCount > 0 ? `<span style="background:#e53e3e;color:white;border-radius:10px;padding:1px 6px;font-size:10px;margin-left:auto;">${openCount}</span>` : ''}
        </a>
        <div class="sidebar-section">毎月</div>
        <a href="report.html" class="${activeKey === 'report' ? 'active' : ''}">
          <span class="material-symbols-outlined">insights</span> 月次レポート
        </a>
        <div class="sidebar-section">その他</div>
        <a href="index.html" class="${activeKey === 'logout' ? 'active' : ''}">
          <span class="material-symbols-outlined">logout</span> ログアウト
        </a>
      </div>
      <div style="position:absolute;bottom:20px;left:16px;right:16px;padding:12px;background:rgba(255,255,255,0.08);border-radius:8px;">
        <div style="font-size:10px;opacity:0.6;">契約プラン</div>
        <div style="font-size:12px;font-weight:600;margin-top:2px;">${BIZ_COMPANY.subscription}</div>
        <div style="font-size:10px;opacity:0.6;margin-top:6px;">税理士：${BIZ_COMPANY.tax_adviser}</div>
      </div>
    </nav>
    <div class="demo-ribbon">DEMO MOCK</div>
  `;
}

function renderTopBar() {
  return `
    <div class="top-bar">
      <div class="company-info">
        <div class="company-avatar" style="background:${BIZ_COMPANY.logo_color};">${BIZ_COMPANY.name.charAt(0)}</div>
        <div>
          <div class="company-name">${BIZ_COMPANY.name}</div>
          <div class="company-sub">
            <span class="material-symbols-outlined" style="font-size:12px;">person</span>
            ${BIZ_COMPANY.representative} 様
            <span style="margin:0 6px;color:var(--border);">|</span>
            <span class="material-symbols-outlined" style="font-size:12px;">storefront</span>
            ${BIZ_COMPANY.tax_firm}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <div style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:#e6fffa;border-radius:20px;font-size:12px;color:var(--biz-green);font-weight:600;">
          <span class="dot green"></span>
          Google Drive 連携中
        </div>
        <button class="icon-btn" title="通知"><span class="material-symbols-outlined">notifications</span></button>
      </div>
    </div>
  `;
}
