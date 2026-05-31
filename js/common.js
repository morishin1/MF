// 共通ナビゲーション・ヘッダー描画

function renderSidebar(activeKey) {
  return `
    <nav class="sidebar">
      <div class="sidebar-brand">
        <h1>KessanPilot</h1>
        <p>for 会計事務所</p>
      </div>
      <div class="sidebar-nav">
        <div class="sidebar-section">メイン</div>
        <a href="dashboard.html" class="${activeKey === 'dashboard' ? 'active' : ''}">
          <span class="material-symbols-outlined">dashboard</span> ダッシュボード
        </a>
        <div class="sidebar-section">月次業務</div>
        <a href="closing-check.html" class="${activeKey === 'closing' ? 'active' : ''}">
          <span class="material-symbols-outlined">fact_check</span> 月次締めチェック
        </a>
        <a href="journal-approval.html" class="${activeKey === 'journal' ? 'active' : ''}">
          <span class="material-symbols-outlined">receipt_long</span> 仕訳候補の承認
        </a>
        <a href="report-generator.html" class="${activeKey === 'report' ? 'active' : ''}">
          <span class="material-symbols-outlined">assessment</span> 経営レポート生成
        </a>
        <div class="sidebar-section">参考</div>
        <a href="client-report.html" class="${activeKey === 'client-report' ? 'active' : ''}">
          <span class="material-symbols-outlined">visibility</span> 顧問先が見る画面
        </a>
        <a href="index.html" class="${activeKey === 'logout' ? 'active' : ''}">
          <span class="material-symbols-outlined">logout</span> ログアウト
        </a>
      </div>
    </nav>
    <div class="demo-ribbon">DEMO MOCK</div>
  `;
}

function renderClientSelector() {
  const current = getCurrentClient();
  return `
    <div class="client-selector" onclick="toggleClientMenu()">
      <div class="client-avatar" style="background:${current.avatar_color}">${current.name.charAt(0)}</div>
      <div>
        <div style="font-weight:600;">${current.name}</div>
        <div style="font-size:11px;color:var(--text-muted);">${current.industry}</div>
      </div>
      <span class="material-symbols-outlined" style="margin-left:12px;color:var(--text-muted);font-size:18px;">expand_more</span>
    </div>
    <div id="client-menu" style="display:none;position:absolute;background:white;border:1px solid var(--border);border-radius:8px;margin-top:4px;box-shadow:0 4px 12px rgba(0,0,0,0.08);z-index:20;min-width:280px;">
      ${CLIENTS.map(c => `
        <div onclick="selectClient('${c.id}')" style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);">
          <div class="client-avatar" style="background:${c.avatar_color}">${c.name.charAt(0)}</div>
          <div>
            <div style="font-weight:600;font-size:13px;">${c.name}</div>
            <div style="font-size:11px;color:var(--text-muted);">${c.industry}</div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function toggleClientMenu() {
  const el = document.getElementById("client-menu");
  if (el) el.style.display = el.style.display === "none" ? "block" : "none";
}

function selectClient(id) {
  setCurrentClient(id);
  location.reload();
}

// クリック外しで閉じる
document.addEventListener("click", function(e) {
  const menu = document.getElementById("client-menu");
  const selector = document.querySelector(".client-selector");
  if (menu && selector && !selector.contains(e.target) && !menu.contains(e.target)) {
    menu.style.display = "none";
  }
});
