// 経営（/keiei）専用の、軽いヘッダーと左メニュー。
//
// ■ 権限
//   /keiei を開けるのは経営者（owner）だけ。ヘッダーの「経営」・この入口・/api/keiei は、
//   すべてサーバの判定（lib/gw.js canKeiei）にそろえる。/api/me の access.keiei で入口を決める
//   （画面側で役割を並べ直さない）。開けない人は、ホームへ送り返す。
//   これは見た目の制御。中身の秘匿は API（owner だけ・二段階認証つき）が担う。
//
// ■ /hr・/sales と同じ作り
//   左サイドメニュー（KPLayout）ではなく、ロゴ＋ナビだけの専用ヘッダーにする
//   （「経営」という別アプリの中を移動している見え方）。
//   ナビは左メニュー（データ）。ここに1行足すだけで画面を増やせる。
(function () {
  const esc = window.KPLayout ? window.KPLayout.esc
    : (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // 初期メニュー。将来、資金繰り・予実管理・部門別分析・サービス別分析・案件別採算を足せる
  const MENU = [
    { key: "dashboard",  label: "ダッシュボード", icon: "dashboard" },
    { key: "onboarding", label: "入社準備",       icon: "how_to_reg" },
    { key: "pay",        label: "給与管理",       icon: "request_quote" },
    { key: "revenue",    label: "売上・利益",     icon: "trending_up" },
    { key: "cash",       label: "入金・支払",     icon: "payments" },
    { key: "payroll",    label: "人件費",         icon: "groups" },
    { key: "expenses",   label: "経費",           icon: "receipt_long" },
    { key: "accounting", label: "会計",           icon: "account_balance" },
  ];

  function css() {
    if (document.getElementById("kei-layout-css")) return;
    const style = document.createElement("style");
    style.id = "kei-layout-css";
    style.textContent = `
      body.kei-app { background:#f6f6f2; }
      .kei-bar { background:#fff; border-bottom:1px solid #e2e2dc; padding:0 20px; display:flex; align-items:center;
                 gap:22px; height:56px; position:sticky; top:0; z-index:20; }
      .kei-logo { font-weight:700; font-size:14px; color:#1b2440; letter-spacing:.02em; white-space:nowrap; }
      .kei-logo span { color:#6b7080; font-weight:500; }
      .kei-back { display:flex; align-items:center; gap:4px; color:#9aa0b4; text-decoration:none; font-size:11.5px; white-space:nowrap; }
      .kei-back .material-symbols-outlined { font-size:16px; }
      .kei-back:hover { color:#6b7080; }
      .kei-spacer { flex:1; }
      .kei-user { font-size:12px; color:#6b7080; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px; }
      .kei-shell { display:grid; grid-template-columns:200px minmax(0,1fr); gap:0; max-width:1280px; margin:0 auto; }
      .kei-side { padding:18px 10px; position:sticky; top:56px; align-self:start; }
      .kei-side a { display:flex; align-items:center; gap:10px; padding:10px 12px; margin-bottom:2px; border-radius:8px;
                    color:#4a5068; text-decoration:none; font-size:13.5px; font-weight:500; }
      .kei-side a .material-symbols-outlined { font-size:20px; }
      .kei-side a:hover { background:#ecece6; }
      .kei-side a.on { background:#1b2440; color:#fff; font-weight:700; }
      .kei-main { padding:24px 20px 60px; min-width:0; }
      @media (max-width: 820px) {
        .kei-bar { padding:0 12px; gap:12px; }
        .kei-user { display:none; }
        .kei-shell { grid-template-columns:1fr; }
        .kei-side { position:static; display:flex; gap:4px; overflow-x:auto; padding:8px 10px; border-bottom:1px solid #e2e2dc; background:#fff; }
        .kei-side a { white-space:nowrap; margin:0; padding:8px 12px; }
        .kei-main { padding:16px 12px 48px; }
      }
    `;
    document.head.appendChild(style);
  }

  function render(active, me) {
    document.body.classList.add("kei-app");
    const name = me?.gw?.employee?.display_name || me?.email || "";
    const bar = document.createElement("div");
    bar.className = "kei-bar";
    bar.innerHTML = `
      <div class="kei-logo"><b>EIGHT</b> <span>/ 経営</span></div>
      <a class="kei-back" href="/admin-dashboard.html" title="グループウェアへ戻る">
        <span class="material-symbols-outlined">arrow_back</span>GWへ戻る</a>
      <div class="kei-spacer"></div>
      <div class="kei-user" title="${esc(name)}">${esc(name)}</div>`;
    document.body.insertBefore(bar, document.body.firstChild);

    const side = document.getElementById("kei-side");
    if (side) {
      side.className = "kei-side";
      side.innerHTML = MENU.map((m) => `<a href="#${m.key}" data-view="${m.key}" class="${m.key === active ? "on" : ""}">
        <span class="material-symbols-outlined">${m.icon}</span>${esc(m.label)}</a>`).join("");
    }
  }

  /** メニューの強調だけ更新する（画面は作り直さない） */
  function setActive(active) {
    for (const a of document.querySelectorAll("#kei-side a")) a.classList.toggle("on", a.dataset.view === active);
  }

  async function init(opts = {}) {
    css();
    if (!window.API || !API.isLoggedIn()) { location.href = "/index.html"; return null; }
    let me;
    try { me = await API.me(); } catch (e) { location.href = "/index.html"; return null; }
    // サーバの判定（canKeiei）そのもの。役割の並びを画面で持たない
    const canKeiei = me?.access ? Boolean(me.access.keiei) : (me?.gw?.roles || []).includes("owner");
    if (!canKeiei) { location.replace("/home.html"); return null; }
    render(opts.active || "dashboard", me);
    return { me };
  }

  window.KeieiLayout = { init, setActive, esc, MENU };
})();
