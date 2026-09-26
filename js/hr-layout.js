// 採用HR（/hr）専用の、軽いヘッダー。
//
// ■ なぜ KPLayout（サイドメニュー）を使わないか
//   ユーザーには「/hr という別アプリの中を移動している」ように見せたい
//   （指示書§1）。左サイドメニュー・通常の帯ではなく、
//   ロゴ＋3ナビ＋3操作だけの専用ヘッダーにする。
//   esc・busy は KPLayout のものをそのまま使う（作り直さない）。
//
// ■ 権限
//   /hr を開けるのは canRecruit（管理者・経営者・人事・採用担当）だけ。
//   CEO REVIEW（判断そのもの）は canDecideHire（経営者・管理者）のみ。
//   どちらもサーバ側（lib/gw.js・RLS）と同じ基準（lib/hr.js API 経由で判定）。
(function () {
  const esc = window.KPLayout ? window.KPLayout.esc
    : (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const NAV = [
    { key: "dashboard", href: "index.html", label: "ダッシュボード", icon: "dashboard" },
    { key: "applicants", href: "applicants.html", label: "応募者", icon: "group" },
    { key: "ceo", href: "ceo-review.html", label: "CEO REVIEW", icon: "supervisor_account" },
  ];

  function css() {
    if (document.getElementById("hr-layout-css")) return;
    const style = document.createElement("style");
    style.id = "hr-layout-css";
    style.textContent = `
      body.hr-app { background:#f6f6f2; }
      .hr-bar { background:#fff; border-bottom:1px solid #e2e2dc; padding:0 20px;
                display:flex; align-items:center; gap:22px; height:56px; position:sticky; top:0; z-index:20; }
      .hr-logo { font-weight:700; font-size:14px; color:#1b2440; letter-spacing:.02em; white-space:nowrap; }
      .hr-logo b { color:#1b2440; } .hr-logo span { color:#6b7080; font-weight:500; }
      .hr-back { display:flex; align-items:center; gap:4px; color:#9aa0b4; text-decoration:none;
                  font-size:11.5px; white-space:nowrap; }
      .hr-back .material-symbols-outlined { font-size:16px; }
      .hr-back:hover { color:#6b7080; }
      .hr-nav { display:flex; gap:4px; flex:1; }
      .hr-nav a { display:flex; align-items:center; gap:6px; padding:0 12px; height:56px;
                  color:#4a5068; text-decoration:none; font-size:13px; font-weight:500;
                  border-bottom:3px solid transparent; }
      .hr-nav a .material-symbols-outlined { font-size:19px; }
      .hr-nav a.on { color:#1b2440; font-weight:700; border-bottom-color:#1b2440; }
      .hr-actions { display:flex; align-items:center; gap:8px; }
      .hr-iconbtn { position:relative; border:none; background:none; cursor:pointer; padding:8px;
                    border-radius:8px; color:#4a5068; display:flex; }
      .hr-iconbtn:hover { background:#f6f6f2; }
      .hr-dot { position:absolute; top:5px; right:5px; min-width:15px; height:15px; border-radius:999px;
                background:#b3261e; color:#fff; font-size:9.5px; font-weight:700;
                display:flex; align-items:center; justify-content:center; padding:0 3px; }
      .hr-add { display:flex; align-items:center; gap:6px; background:#1b2440; color:#fff; border:none;
                border-radius:7px; padding:8px 14px; font-size:12.5px; font-weight:700; cursor:pointer;
                font-family:inherit; }
      .hr-add .material-symbols-outlined { font-size:18px; }
      .hr-user { border:none; background:none; cursor:pointer; padding:8px; border-radius:8px; color:#4a5068; display:flex; }
      .hr-user:hover { background:#f6f6f2; }
      .hr-menu { position:absolute; right:20px; top:56px; background:#fff; border:1px solid #e2e2dc;
                 border-radius:8px; box-shadow:0 8px 24px rgba(27,36,64,.12); min-width:160px; z-index:30; }
      .hr-menu button { display:block; width:100%; text-align:left; border:none; background:none;
                         padding:10px 14px; font-size:13px; color:#1b2440; cursor:pointer; font-family:inherit; }
      .hr-menu button:hover { background:#f6f6f2; }
      .hr-wrap { max-width:1200px; margin:0 auto; padding:24px 16px 60px; }
    `;
    document.head.appendChild(style);
  }

  function renderHeader(active, me) {
    document.body.classList.add("hr-app");
    const name = me?.gw?.employee?.display_name || me?.email || "";
    const bar = document.createElement("div");
    bar.className = "hr-bar";
    bar.innerHTML = `
      <div class="hr-logo"><b>EIGHT</b> <span>/ HR</span></div>
      <a class="hr-back" href="../admin-dashboard.html" title="人事・労務 ＞ 採用">
        <span class="material-symbols-outlined">arrow_back</span>GWへ戻る</a>
      <nav class="hr-nav">
        ${NAV.map((n) => `<a class="${n.key === active ? "on" : ""}" href="${n.href}">
          <span class="material-symbols-outlined">${n.icon}</span>${esc(n.label)}</a>`).join("")}
      </nav>
      <div class="hr-actions">
        <button class="hr-iconbtn" onclick="HRLayout.showGuide()" title="使い方（1分マニュアル）">
          <span class="material-symbols-outlined">help</span>
        </button>
        <button class="hr-iconbtn" id="hr-bell-btn" onclick="HRLayout.toggleBell()" title="通知">
          <span class="material-symbols-outlined">notifications</span>
          <span class="hr-dot hidden" id="hr-bell-dot">0</span>
        </button>
        <button class="hr-add" onclick="location.href='applicants.html?new=1'">
          <span class="material-symbols-outlined">person_add</span>応募者追加
        </button>
        <button class="hr-user" id="hr-user-btn" onclick="HRLayout.toggleUserMenu()" title="${esc(name)}">
          <span class="material-symbols-outlined">account_circle</span>
        </button>
      </div>`;
    document.body.insertBefore(bar, document.body.firstChild);

    const wraps = document.querySelectorAll(".wrap");
    for (const w of wraps) w.classList.add("hr-wrap");
  }

  function toggleUserMenu() {
    let menu = document.getElementById("hr-user-menu");
    if (menu) { menu.remove(); return; }
    menu = document.createElement("div");
    menu.className = "hr-menu";
    menu.id = "hr-user-menu";
    menu.innerHTML = `<button onclick="API.logout();location.href='../index.html'">ログアウト</button>`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", closeUserMenuOnce), 0);
  }
  function closeUserMenuOnce(e) {
    const menu = document.getElementById("hr-user-menu");
    if (menu && !menu.contains(e.target) && e.target.id !== "hr-user-btn") menu.remove();
    document.removeEventListener("click", closeUserMenuOnce);
  }

  function toggleBell() {
    // 通知の中身は Stage 9（notifications統合）で実装する。いまは枠だけ
  }

  // 迷ったら、これだけ覚えていればよい。長い別ページにはしない
  // （KPLayout.viewer を使い回す。新しい画面・モーダルは増やさない）
  const GUIDE = `採用HR 1分マニュアル

① 応募者を登録

② 応募者を開いたら「NEXT ACTION」を見る

③ 面談 → 評価 → 良い候補者は社長推薦

④ 社長はCEO REVIEWで会う・判断する

⑤ 内定したら人事が合格通知を作成・送付

⑥ 本人が承諾したら「本採用へ進める」

⑦ その後は既存GWで
　社員登録 → 契約書 → 電子署名 → 入社手続き

迷ったら、「NEXT ACTIONを見る」で統一してください。`;

  function showGuide() {
    if (window.KPLayout?.viewer) KPLayout.viewer({ title: "採用HR 1分マニュアル", text: GUIDE });
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
    const canRecruit = isAdmin || roles.includes("hr") || roles.includes("owner") || roles.includes("recruiter");
    if (!canRecruit) { location.replace("../home.html"); return null; }
    const canDecide = isAdmin || roles.includes("owner");

    if (opts.active === "ceo" && !canDecide) { location.replace("index.html"); return null; }

    renderHeader(opts.active, me);
    return { me, canRecruit, canDecide };
  }

  window.HRLayout = { init, esc, busy: window.KPLayout ? window.KPLayout.busy : null, toggleUserMenu, toggleBell, showGuide };
})();
