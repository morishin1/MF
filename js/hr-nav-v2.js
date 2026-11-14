// HR統一ナビ（2026-11）。旧ナビの追加スクリプトがあっても、最後にこのメニューを正とする。
// 認証・権限判定はHRLayout.initに委譲。既存ページのactiveキーは互換維持。
(function () {
  "use strict";
  if (!window.HRLayout || HRLayout.__navV2) return;
  const previousInit = HRLayout.init;
  // HRの固定ヘッダーは行き先を4つに限定する。
  // 面談・トライアル・書類/契約は、対象の応募者から開く（単独の機能は削除しない）。
  const NAV = [
    {key:"home",href:"/hr/dashboard.html",icon:"space_dashboard",label:"ダッシュボード"},
    {key:"applicants",href:"/hr/applicants.html",icon:"group",label:"応募者管理"},
    {key:"ceo",href:"/hr/ceo-review.html",icon:"how_to_reg",label:"採用判断",decisionOnly:true},
    {key:"tools",href:"/hr/tools.html",icon:"more_horiz",label:"その他"}
  ];
  function injectStyles() {
    if (document.getElementById("hr-nav-v2-style")) return;
    const style = document.createElement("style");
    style.id = "hr-nav-v2-style";
    style.textContent = [
      ".hr-bar{gap:12px!important;padding-left:12px!important;padding-right:12px!important}",
      ".hr-bar .hr-nav{gap:1px!important;min-width:0;justify-content:flex-start}",
      ".hr-bar .hr-nav a{padding:0 9px!important;gap:4px!important;font-size:12px!important;white-space:nowrap;flex-shrink:0}",
      ".hr-bar .hr-nav a .material-symbols-outlined{font-size:17px!important}",
      ".hr-bar .hr-actions{flex-shrink:0}",
      "@media(max-width:1180px){.hr-bar .hr-nav{overflow-x:auto;scrollbar-width:thin}.hr-bar .hr-nav a{padding:0 7px!important}}",
      "@media(max-width:720px){.hr-bar .hr-nav a{height:44px!important}.hr-bar .hr-nav{flex-basis:100%;overflow-x:auto}}"
    ].join("\n");
    document.head.appendChild(style);
  }
  function mappedActive(opts) {
    const active = opts && opts.active;
    if (["interviews", "trials", "contracts", "offer"].includes(active)) return "applicants";
    if (["dashboard", "materials", "templates", "intake", "spot", "inbox", "partners"].includes(active)) return "tools";
    return active || "home";
  }
  HRLayout.init = async function (opts) {
    const result = await previousInit.call(HRLayout, opts);
    if (!result) return result;
    injectStyles();
    const nav = document.querySelector(".hr-nav");
    if (!nav) return result;
    const selected = mappedActive(opts);
    const shown = NAV.filter(item => !item.decisionOnly || result.canDecide);
    const esc = HRLayout.esc || (s => String(s));
    nav.innerHTML = shown.map(item => {
      const current = item.key === selected;
      return '<a href="' + item.href + '" class="' + (current ? "on" : "") + '"'
        + (current ? ' aria-current="page"' : "") + '>'
        + '<span class="material-symbols-outlined" aria-hidden="true">' + item.icon + '</span>'
        + esc(item.label) + '</a>';
    }).join("");
    nav.setAttribute("aria-label", "採用HRメインメニュー");
    return result;
  };
  HRLayout.__navV2 = true;
})();
