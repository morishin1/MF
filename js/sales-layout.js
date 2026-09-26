// 営業アタック管理（/sales）専用の、軽いヘッダー。
//
// ■ /hr と同じ作り（js/hr-layout.js）
//   左サイドメニューではなく、ロゴ＋5ナビ＋操作だけの専用ヘッダーにする。
//   「テンプレート」「キャンペーン」は上に出しすぎず、各画面から開く（要件 §24）。
//   esc・busy は KPLayout のものをそのまま使う（作り直さない）。
//
// ■ 権限
//   /sales を開けるのは canSell（管理者・経営者・マネージャー・営業担当）だけ。
//   直近アタックの押し切り（それでもアタックする）は canForce（管理者・経営者）のみ。
//   どちらもサーバ側（lib/gw.js・RLS）と同じ基準。
(function () {
  const esc = window.KPLayout ? window.KPLayout.esc
    : (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const NAV = [
    { key: "dashboard", href: "/sales/", label: "ダッシュボード", icon: "dashboard" },
    { key: "companies", href: "/sales/companies.html", label: "企業", icon: "domain" },
    { key: "attack", href: "/sales/attack.html", label: "アタック", icon: "send" },
    { key: "clicks", href: "/sales/clicks.html", label: "反応", icon: "ads_click" },
    { key: "analytics", href: "/sales/analytics.html", label: "分析", icon: "monitoring" },
  ];

  function css() {
    if (document.getElementById("sales-layout-css")) return;
    const style = document.createElement("style");
    style.id = "sales-layout-css";
    style.textContent = `
      body.sl-app { background:#f6f6f2; }
      .sl-bar { background:#fff; border-bottom:1px solid #e2e2dc; padding:0 20px;
                display:flex; align-items:center; gap:22px; height:56px; position:sticky; top:0; z-index:20; }
      .sl-logo { font-weight:700; font-size:14px; color:#1b2440; letter-spacing:.02em; white-space:nowrap; }
      .sl-logo span { color:#6b7080; font-weight:500; }
      .sl-back { display:flex; align-items:center; gap:4px; color:#9aa0b4; text-decoration:none;
                  font-size:11.5px; white-space:nowrap; }
      .sl-back .material-symbols-outlined { font-size:16px; }
      .sl-back:hover { color:#6b7080; }
      .sl-nav { display:flex; gap:4px; flex:1; min-width:0; overflow-x:auto; }
      .sl-nav a { display:flex; align-items:center; gap:6px; padding:0 12px; height:56px; white-space:nowrap;
                  color:#4a5068; text-decoration:none; font-size:13px; font-weight:500;
                  border-bottom:3px solid transparent; }
      .sl-nav a .material-symbols-outlined { font-size:19px; }
      .sl-nav a.on { color:#1b2440; font-weight:700; border-bottom-color:#1b2440; }
      .sl-actions { display:flex; align-items:center; gap:8px; }
      .sl-iconbtn { position:relative; border:none; background:none; cursor:pointer; padding:8px;
                    border-radius:8px; color:#4a5068; display:flex; }
      .sl-iconbtn:hover { background:#f6f6f2; }
      .sl-add { display:flex; align-items:center; gap:6px; background:#1b2440; color:#fff; border:none;
                border-radius:7px; padding:8px 14px; font-size:12.5px; font-weight:700; cursor:pointer;
                font-family:inherit; white-space:nowrap; }
      .sl-add .material-symbols-outlined { font-size:18px; }
      .sl-menu { position:absolute; right:20px; top:56px; background:#fff; border:1px solid #e2e2dc;
                 border-radius:8px; box-shadow:0 8px 24px rgba(27,36,64,.12); min-width:180px; z-index:30; }
      .sl-menu a, .sl-menu button { display:block; width:100%; text-align:left; border:none; background:none;
                         padding:10px 14px; font-size:13px; color:#1b2440; cursor:pointer; font-family:inherit;
                         text-decoration:none; box-sizing:border-box; }
      .sl-menu a:hover, .sl-menu button:hover { background:#f6f6f2; }
      .sl-wrap { max-width:1200px; margin:0 auto; padding:24px 16px 60px; }

      /* ここから下は /sales の各画面で共通（/hr の各画面と同じ見た目） */
      body.sl-app { font-family:'Zen Kaku Gothic New', sans-serif; }
      h1.sl-title { font-size:24px; font-weight:700; color:#1b2440; margin:0 0 4px; }
      .sl-sub { color:#6b7080; font-size:13px; margin:0 0 20px; }
      .sl-sec-h { font-size:15px; font-weight:700; color:#1b2440; margin:0 0 10px; }
      .sl-sec-sub { font-size:11.5px; color:#9aa0b4; margin:-6px 0 10px; }
      .sl-empty { color:#9aa0b4; font-size:12.5px; padding:2px 0 4px; }
      .sl-muted { color:#6b7080; font-size:12px; }
      .sl-pill { display:inline-flex; align-items:center; gap:4px; border-radius:999px; padding:3px 10px;
        font-size:11.5px; font-weight:600; white-space:nowrap; }
      .sl-warn { background:#fdecea; color:#b3261e; border-radius:9px; padding:10px 12px; font-size:12.5px;
        display:flex; gap:8px; align-items:flex-start; margin:0 0 12px; }
      .sl-warn .material-symbols-outlined { font-size:18px; }
      .sl-caution { background:#fbf1d6; color:#7d5a00; }

      .sl-toolbar { display:flex; gap:10px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
      .sl-toolbar input[type="text"], .sl-toolbar select { max-width:200px; margin:0; }
      .sl-tabs-pill { display:flex; gap:6px; flex-wrap:wrap; }
      .sl-tabs-pill button { border:1px solid #e2e2dc; background:#fff; border-radius:999px; padding:6px 13px;
        font-size:12px; font-weight:500; color:#4a5068; cursor:pointer; font-family:inherit; }
      .sl-tabs-pill button.on { background:#1b2440; border-color:#1b2440; color:#fff; font-weight:700; }

      .sl-table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #e2e2dc; border-radius:10px; overflow:hidden; }
      .sl-table th { text-align:left; font-size:11px; color:#6b7080; font-weight:700; padding:10px 12px;
        background:#f6f6f2; border-bottom:1px solid #e2e2dc; white-space:nowrap; }
      .sl-table td { padding:11px 12px; border-bottom:1px solid #e2e2dc; font-size:13px; vertical-align:top; }
      .sl-table tr:last-child td { border-bottom:none; }
      .sl-table tr.click { cursor:pointer; }
      .sl-table tr.click:hover { background:#f6f6f2; }
      .sl-nm { font-weight:700; color:#1b2440; font-size:14px; display:block; }
      .sl-sub2 { font-size:11.5px; color:#6b7080; display:block; margin-top:2px; }
      .sl-hot { color:#b3261e; font-weight:700; }

      .sl-drawer-bg { position:fixed; inset:0; background:rgba(27,36,64,.35); z-index:40; }
      .sl-drawer { position:fixed; top:0; right:0; bottom:0; width:440px; max-width:92vw; background:#fff;
        z-index:41; box-shadow:-8px 0 24px rgba(27,36,64,.15); overflow-y:auto; padding:22px; box-sizing:border-box; }
      .sl-drawer.top { z-index:43; }
      .sl-drawer h2 { font-size:17px; font-weight:700; color:#1b2440; margin:0 0 16px; }
      .sl-detail { position:fixed; top:0; right:0; bottom:0; width:560px; max-width:94vw; background:#f6f6f2;
        z-index:41; box-shadow:-8px 0 24px rgba(27,36,64,.15); overflow-y:auto; }

      .sl-next { background:#e6f050; border-radius:10px; padding:16px 18px; margin:0 0 16px; }
      .sl-next .now { font-size:11px; color:#4a5068; margin-bottom:2px; }
      .sl-next .lb { font-size:11px; font-weight:700; color:#4a5068; display:flex; align-items:center; gap:5px; }
      .sl-next .lb .material-symbols-outlined { font-size:15px; }
      .sl-next h3 { font-size:18px; font-weight:700; color:#1b2440; margin:6px 0 8px; }
      .sl-next .meta { font-size:12px; color:#4a5068; margin-bottom:10px; }

      .sl-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:4px 12px; font-size:12.5px; margin:0; }
      .sl-grid2 dt { color:#6b7080; margin-bottom:2px; }
      .sl-grid2 dd { margin:0 0 10px; color:#1b2440; font-weight:600; word-break:break-all; }
      .sl-grid2 a { color:#1b2440; }

      .sl-tl { border-left:2px solid #e2e2dc; margin-left:6px; padding-left:16px; }
      .sl-tl .row { position:relative; padding-bottom:14px; }
      .sl-tl .row::before { content:""; position:absolute; left:-21px; top:3px; width:9px; height:9px; border-radius:999px; background:#1b2440; }
      .sl-tl .row.click::before { background:#e0a100; }
      .sl-tl .row.planned::before { background:#fff; border:2px solid #9aa0b4; width:5px; height:5px; }
      .sl-tl .row .d { font-size:11px; color:#6b7080; font-variant-numeric:tabular-nums; }
      .sl-tl .row .l { font-size:13px; font-weight:600; color:#1b2440; }
      .sl-tl .row .x { font-size:11.5px; color:#6b7080; }

      .sl-chip { display:inline-flex; align-items:center; gap:4px; background:#e7eaf3; color:#1b2440;
        border-radius:999px; padding:5px 11px; font-size:12px; margin:0 6px 6px 0; cursor:pointer; }
      .sl-chip input { width:auto; margin:0 4px 0 0; }

      .sl-row { background:#fff; border:1px solid #e2e2dc; border-left:3px solid #e6f050; border-radius:9px;
        padding:12px 14px; display:flex; align-items:center; gap:14px; }
      .sl-row.hot { border-left-color:#e0a100; }
      .sl-row.overdue { border-left-color:#c0392b; }
      .sl-row .info { flex:1; min-width:0; }
      .sl-row b { display:block; color:#1b2440; font-size:14px; }
      .sl-row .now { color:#6b7080; font-size:12px; margin-top:3px; }
      .sl-row .n { color:#1b2440; font-size:12.5px; margin-top:3px; font-weight:500; }
      .sl-rows { display:grid; gap:8px; }

      .sl-funnel { display:flex; flex-wrap:wrap; align-items:center; gap:4px; font-size:13px; color:#1b2440; }
      .sl-funnel .v { font-weight:700; }
      .sl-funnel .arrow { color:#9aa0b4; margin:0 4px; font-size:11.5px; }

      @media (max-width: 760px) {
        .sl-grid2 { grid-template-columns:1fr; }
        .sl-table th, .sl-table td { padding:9px 8px; }
      }
      @media (max-width: 760px) {
        .sl-bar { gap:10px; padding:0 10px; }
        .sl-back, .sl-add .lb, .sl-help, .sl-logo span { display:none; }
        .sl-actions { gap:2px; flex-shrink:0; }
        .sl-add { padding:8px 10px; }
        .sl-nav a { padding:0 8px; font-size:12px; }
        .sl-nav a .material-symbols-outlined { display:none; }
      }
    `;
    document.head.appendChild(style);
  }

  function renderHeader(active, me) {
    document.body.classList.add("sl-app");
    const name = me?.gw?.employee?.display_name || me?.email || "";
    const bar = document.createElement("div");
    bar.className = "sl-bar";
    bar.innerHTML = `
      <div class="sl-logo">EIGHT <span>/ SALES</span></div>
      <a class="sl-back" href="../home.html" title="GWへ戻る">
        <span class="material-symbols-outlined">arrow_back</span>GWへ戻る</a>
      <nav class="sl-nav">
        ${NAV.map((n) => `<a class="${n.key === active ? "on" : ""}" href="${n.href}">
          <span class="material-symbols-outlined">${n.icon}</span>${esc(n.label)}</a>`).join("")}
      </nav>
      <div class="sl-actions">
        <button class="sl-iconbtn sl-help" onclick="SalesLayout.showGuide()" title="使い方（1分マニュアル）">
          <span class="material-symbols-outlined">help</span>
        </button>
        <button class="sl-add" onclick="location.href='/sales/companies.html?new=1'">
          <span class="material-symbols-outlined">add_business</span><span class="lb">企業追加</span>
        </button>
        <button class="sl-iconbtn" id="sl-user-btn" onclick="SalesLayout.toggleUserMenu()" title="${esc(name)}">
          <span class="material-symbols-outlined">account_circle</span>
        </button>
      </div>`;
    document.body.insertBefore(bar, document.body.firstChild);

    for (const w of document.querySelectorAll(".wrap")) w.classList.add("sl-wrap");
  }

  // テンプレート・キャンペーンは、ここ（設定）と各画面からだけ開く
  function toggleUserMenu() {
    let menu = document.getElementById("sl-user-menu");
    if (menu) { menu.remove(); return; }
    menu = document.createElement("div");
    menu.className = "sl-menu";
    menu.id = "sl-user-menu";
    menu.innerHTML = `
      <a href="/sales/templates.html">営業文テンプレート</a>
      <a href="/sales/campaigns.html">キャンペーン</a>
      <button onclick="API.logout();location.href='../index.html'">ログアウト</button>`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", closeUserMenuOnce), 0);
  }
  function closeUserMenuOnce(e) {
    const menu = document.getElementById("sl-user-menu");
    if (menu && !menu.contains(e.target) && !e.target.closest?.("#sl-user-btn")) menu.remove();
    document.removeEventListener("click", closeUserMenuOnce);
  }

  const GUIDE = `営業 1分マニュアル

① ダッシュボードの「今やること」を上から片付ける

② 企業を開いて「フォームアタック」

③ テンプレートを選ぶ → 営業文をコピー

④ 企業の問い合わせフォームに貼って、内容を確認して送信

⑤ GWに戻って「送信完了」を押す（ここで履歴が残る）

⑥ 相手が営業文のリンクを開くと、通知が届く

⑦ 反応した企業から優先してフォロー → 商談へ

迷ったら「NEXT」を見てください。
30日以内にアタックした企業・営業禁止の企業には送れません。`;

  function showGuide() {
    if (window.KPLayout?.viewer) KPLayout.viewer({ title: "営業 1分マニュアル", text: GUIDE });
  }

  async function init(opts = {}) {
    css();
    if (!window.API || !API.isLoggedIn()) { location.href = "../index.html"; return null; }
    let me;
    try {
      me = await API.me();
    } catch (e) {
      location.href = "../index.html";
      return null;
    }
    const roles = me?.gw?.roles || [];
    const isAdmin = Boolean(me?.gw?.isAdmin || me?.isAdmin);
    const canSell = isAdmin || ["owner", "manager", "sales"].some((r) => roles.includes(r));
    if (!canSell) { location.replace("../home.html"); return null; }
    const canForce = isAdmin || roles.includes("owner");

    renderHeader(opts.active, me);
    return { me, canSell, canForce };
  }

  // ---- 画面どうしで共通の小さな道具 -------------------------------------------

  const STATUS_COLOR = {
    untouched: ["#efefeb", "#4a5068"], reattack_wait: ["#efefeb", "#4a5068"],
    attacked: ["#e7eaf3", "#1b2440"], clicked: ["#fbf1d6", "#7d5a00"], replied: ["#e5f1e2", "#2f6f3a"],
    meeting: ["#e5f1e2", "#2f6f3a"], proposal: ["#e5f1e2", "#2f6f3a"], won: ["#1b2440", "#fff"],
    lost: ["#f6f6f2", "#9aa0b4"], excluded: ["#f6f6f2", "#9aa0b4"],
  };
  function statusPill(status, label) {
    const [bg, fg] = STATUS_COLOR[status] || STATUS_COLOR.untouched;
    return `<span class="sl-pill" style="background:${bg};color:${fg};">${esc(label || status)}</span>`;
  }

  /** "09/26 14:32" */
  function fmt(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  /** "9/27" */
  function fmtDay(ymd) {
    if (!ymd) return "";
    const [, m, d] = String(ymd).split("-");
    return `${Number(m)}/${Number(d)}`;
  }
  /** 「3日前」「2時間前」 */
  function ago(iso) {
    if (!iso) return "";
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return "たった今";
    if (ms < 3600000) return `${Math.floor(ms / 60000)}分前`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}時間前`;
    return `${Math.floor(ms / 86400000)}日前`;
  }

  window.SalesLayout = {
    init, esc, busy: window.KPLayout ? window.KPLayout.busy : null, toggleUserMenu, showGuide,
    statusPill, fmt, fmtDay, ago,
  };
})();
