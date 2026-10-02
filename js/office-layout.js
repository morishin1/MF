// 月末月初業務（/office）専用の、軽いヘッダー。
//
// ■ /sales・/hr と同じ作り（js/sales-layout.js）
//   左サイドメニューではなく、ロゴ＋ナビ＋操作だけの専用ヘッダーにする。
//   ページどうしで共通の見た目（一覧・ドロワー・状態のラベル）は、ここに置く。
//
// ■ 権限
//   /office を開けるのは、経営者・責任者・経理だけ（サーバの canAccessOffice、DB の gw_is_office と同じ）。
//   入口は /api/me の access.office だけで決める。画面側で役割名を並べ直さない
//   （ヘッダーに出たのに API が 403、を作らない。test/accessparity.mjs が見張る）。
//   古い応答（access が無い）のときは、入れない側に倒す。
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Office は1つの業務アプリ（人事・労務・経理・事務）。月次業務（/office/）はその中の機能。
  // 月次業務は access.office の人（経営者・責任者・経理）が使う。
  // 人事・労務、経理・事務の管理画面（admin-*.html）は、既存の管理画面をそのまま使い、
  // 入口は担当の人にだけ出す。出すかどうかはサーバの判定（/api/me の access）で決める:
  //   officeHr（人事・労務）… 管理者・経営者・人事 / officeFinance（経理・事務）… 管理者・経営者・経理
  // （押すと 403 の入口を出さない。画面側で役割名を並べ直さない）
  const MONTHLY = { key: "monthly", href: "/office/", label: "月次業務", icon: "event_available" };
  const DASH   = { key: "dashboard", href: "/admin-dashboard.html", label: "ダッシュボード", icon: "dashboard" };
  const PEOPLE = { key: "people",    href: "/admin-members.html",   label: "人事・労務",     icon: "group" };
  const OPS    = { key: "ops",       href: "/admin-expenses.html",  label: "経理・事務",     icon: "work" };
  const navFor = (me) => {
    const a = me?.access || {};
    const hr = Boolean(a.officeHr), fin = Boolean(a.officeFinance);
    return [...(hr || fin ? [DASH] : []), ...(hr ? [PEOPLE] : []), ...(fin ? [OPS] : []), MONTHLY];
  };

  function css() {
    if (document.getElementById("office-layout-css")) return;
    const style = document.createElement("style");
    style.id = "office-layout-css";
    style.textContent = `
      body.of-app { background:#f6f6f2; font-family:'Zen Kaku Gothic New', sans-serif; }
      .of-bar { background:#fff; border-bottom:1px solid #e2e2dc; padding:0 20px;
                display:flex; align-items:center; gap:22px; height:56px; position:sticky; top:0; z-index:20; }
      .of-logo { font-weight:700; font-size:14px; color:#1b2440; letter-spacing:.02em; white-space:nowrap; }
      .of-logo span { color:#6b7080; font-weight:500; }
      .of-back { display:flex; align-items:center; gap:4px; color:#9aa0b4; text-decoration:none;
                 font-size:11.5px; white-space:nowrap; }
      .of-back .material-symbols-outlined { font-size:16px; }
      .of-back:hover { color:#6b7080; }
      .of-nav { display:flex; gap:4px; flex:1; min-width:0; overflow-x:auto; }
      .of-nav a { display:flex; align-items:center; gap:6px; padding:0 12px; height:56px; white-space:nowrap;
                  color:#4a5068; text-decoration:none; font-size:13px; font-weight:500;
                  border-bottom:3px solid transparent; }
      .of-nav a .material-symbols-outlined { font-size:19px; }
      .of-nav a.on { color:#1b2440; font-weight:700; border-bottom-color:#1b2440; }
      .of-actions { display:flex; align-items:center; gap:8px; }
      .of-iconbtn { position:relative; border:none; background:none; cursor:pointer; padding:8px;
                    border-radius:8px; color:#4a5068; display:flex; }
      .of-iconbtn:hover { background:#f6f6f2; }
      .of-menu { position:absolute; right:20px; top:56px; background:#fff; border:1px solid #e2e2dc;
                 border-radius:8px; box-shadow:0 8px 24px rgba(27,36,64,.12); min-width:180px; z-index:30; }
      .of-menu a, .of-menu button { display:block; width:100%; text-align:left; border:none; background:none;
                 padding:10px 14px; font-size:13px; color:#1b2440; cursor:pointer; font-family:inherit;
                 text-decoration:none; box-sizing:border-box; }
      .of-menu a:hover, .of-menu button:hover { background:#f6f6f2; }
      .of-wrap { max-width:1280px; margin:0 auto; padding:24px 16px 60px; }

      /* アイコンは幅を 1em に固定する。フォントの読込前・読込に失敗したときに、
         アイコン名（chevron_right など）の文字がそのまま幅をとって、横にはみ出さないように */
      body.of-app .material-symbols-outlined { display:inline-block; width:1em; overflow:hidden;
        white-space:nowrap; line-height:1; flex:none; }

      /* ここから下は /office の各画面で共通 */
      h1.of-title { font-size:24px; font-weight:700; color:#1b2440; margin:0 0 4px; }
      .of-sub { color:#6b7080; font-size:13px; margin:0 0 20px; }
      .of-sec-h { font-size:15px; font-weight:700; color:#1b2440; margin:0 0 10px; display:flex; align-items:baseline; gap:10px; }
      .of-sec-h small { font-size:12px; font-weight:500; color:#6b7080; }
      .of-empty { color:#6b7080; font-size:13px; padding:18px 4px; text-align:center; }
      .of-muted { color:#6b7080; font-size:12px; }
      .of-pill { display:inline-flex; align-items:center; gap:4px; border-radius:999px; padding:3px 10px 3px 8px;
                 font-size:11.5px; font-weight:700; white-space:nowrap; }
      .of-pill .material-symbols-outlined { font-size:14px; }
      .of-banner { border-radius:9px; padding:10px 12px; font-size:12.5px; display:flex; gap:8px;
                   align-items:flex-start; margin:0 0 14px; background:#fbf1d6; color:#5c4300; }
      .of-banner.err { background:#fdecea; color:#b3261e; }
      .of-banner .material-symbols-outlined { font-size:18px; flex:none; }
      .of-btn { display:inline-flex; align-items:center; gap:5px; border:1px solid #1b2440; background:#1b2440;
                color:#fff; border-radius:7px; padding:6px 12px; font-size:12px; font-weight:700; cursor:pointer;
                font-family:inherit; white-space:nowrap; }
      .of-btn.sec { background:#fff; color:#1b2440; border-color:#c7cad4; }
      .of-btn .material-symbols-outlined { font-size:16px; }
      .of-btn:disabled { opacity:.55; cursor:default; }
      .of-btn:focus-visible, .of-iconbtn:focus-visible, .of-nav a:focus-visible, button:focus-visible {
        outline:2px solid #1b2440; outline-offset:2px; }

      .of-drawer-bg { position:fixed; inset:0; background:rgba(27,36,64,.35); z-index:40; }
      .of-drawer { position:fixed; top:0; right:0; bottom:0; width:560px; max-width:100vw; background:#f6f6f2;
                   z-index:41; box-shadow:-8px 0 24px rgba(27,36,64,.15); overflow-y:auto; }

      @media (max-width: 760px) {
        .of-bar { gap:10px; padding:0 10px; }
        .of-back, .of-logo span { display:none; }
        .of-nav a { padding:0 8px; font-size:12px; }
        .of-nav a .material-symbols-outlined { display:none; }
      }
    `;
    document.head.appendChild(style);
  }

  function renderHeader(active, me) {
    document.body.classList.add("of-app");
    const name = me?.gw?.employee?.display_name || me?.email || "";
    const bar = document.createElement("div");
    bar.className = "of-bar";
    bar.innerHTML = `
      <div class="of-logo">EIGHT <span>/ OFFICE</span></div>
      <a class="of-back" href="/home.html" title="GWへ戻る">
        <span class="material-symbols-outlined">arrow_back</span>GWへ戻る</a>
      <nav class="of-nav" aria-label="Office">
        ${navFor(me).map((n) => `<a class="${n.key === active ? "on" : ""}" href="${n.href}"${n.key === active ? ' aria-current="page"' : ""}>
          <span class="material-symbols-outlined">${n.icon}</span>${esc(n.label)}</a>`).join("")}
      </nav>
      <div class="of-actions">
        <button class="of-iconbtn" id="of-user-btn" onclick="OfficeLayout.toggleUserMenu()" title="${esc(name)}" aria-label="アカウント">
          <span class="material-symbols-outlined">account_circle</span>
        </button>
      </div>`;
    document.body.insertBefore(bar, document.body.firstChild);
    for (const w of document.querySelectorAll(".wrap")) w.classList.add("of-wrap");
  }

  function toggleUserMenu() {
    let menu = document.getElementById("of-user-menu");
    if (menu) { menu.remove(); return; }
    menu = document.createElement("div");
    menu.className = "of-menu";
    menu.id = "of-user-menu";
    menu.innerHTML = `<button onclick="API.logout();location.href='/index.html'">ログアウト</button>`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", closeUserMenuOnce), 0);
  }
  function closeUserMenuOnce(e) {
    const menu = document.getElementById("of-user-menu");
    if (menu && !menu.contains(e.target) && !e.target.closest?.("#of-user-btn")) menu.remove();
    document.removeEventListener("click", closeUserMenuOnce);
  }

  async function init(opts = {}) {
    css();
    if (!window.API || !API.isLoggedIn()) { location.href = "/index.html"; return null; }
    let me;
    try {
      me = await API.me();
    } catch (e) {
      location.href = "/index.html";
      return null;
    }
    // ヘッダーの近道と同じ値（/api/me の access = サーバの canAccessOffice）だけで入口を決める。
    // 役割名は画面側で持たない。access が無い（古い応答）ときは入れない
    if (!me?.access?.office) { location.replace("/home.html"); return null; }

    renderHeader(opts.active, me);
    return { me };
  }

  // ---- 画面どうしで共通の小さな道具 -------------------------------------------

  // 色だけで状態を判断させない：ラベル＋アイコン＋最小限の色
  const TONE = {
    neutral:  ["#efefeb", "#4a5068"],
    progress: ["#e7eaf3", "#1b2440"],
    attention: ["#fbf1d6", "#7d5a00"],
    ok:       ["#e5f1e2", "#2f6f3a"],
    danger:   ["#fdecea", "#b3261e"],
    muted:    ["#f6f6f2", "#6b7080"],
  };
  function pill(label, tone, icon) {
    const [bg, fg] = TONE[tone] || TONE.neutral;
    return `<span class="of-pill" style="background:${bg};color:${fg};">`
      + `${icon ? `<span class="material-symbols-outlined" aria-hidden="true">${icon}</span>` : ""}${esc(label)}</span>`;
  }

  /** "09/26 14:32"（日本時間） */
  function fmt(iso) {
    if (!iso) return "";
    const d = new Date(new Date(iso).getTime() + 9 * 3600000);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }
  /** "10/5" */
  function fmtDay(ymd) {
    if (!ymd) return "";
    const [, m, d] = String(ymd).split("-");
    return `${Number(m)}/${Number(d)}`;
  }

  window.OfficeLayout = { init, esc, pill, fmt, fmtDay, toggleUserMenu };
})();
