// HR統一ナビ（2026-11）。旧ナビの追加スクリプトがあっても、最後にこのメニューを正とする。
// 認証・権限判定はHRLayout.initに委譲。既存ページのactiveキーは互換維持。
(function () {
  "use strict";
  if (!window.HRLayout || HRLayout.__navV2) return;
  const previousInit = HRLayout.init;
  // HRの固定ヘッダーは、使うものだけを直接並べる（「その他」は置かない）。
  // 面談・トライアル・内定/契約は、対象の応募者から開く（画面そのものは削除しない）。
  const NAV = [
    {key:"home",href:"/hr/dashboard.html",icon:"space_dashboard",label:"ダッシュボード"},
    {key:"applicants",href:"/hr/applicants.html",icon:"group",label:"応募者管理"},
    // 見せる・見せないは既存の canDecide に従う。APIの認可はここでは変えない。
    {key:"ceo",href:"/hr/ceo-review.html",icon:"how_to_reg",label:"採用判断",decisionOnly:true},
    {key:"analytics",href:"/hr/",icon:"bar_chart",label:"応募分析"},
    {key:"materials",href:"/hr/materials.html",icon:"folder_open",label:"採用資料"},
    {key:"templates",href:"/hr/templates.html",icon:"mail",label:"メールひな型"},
    {key:"manual",href:"/guide-hr-office.html#hr",icon:"menu_book",label:"操作マニュアル",manual:true}
  ];
  // 各画面が渡している active（旧キーを含む）→ ヘッダーで選択表示する項目。
  // 応募者に紐づく画面（面談・トライアル・契約・応募受付・スポット）は「応募者管理」。
  const ACTIVE = {
    home:"home", inbox:"home",
    applicants:"applicants", interviews:"applicants", trials:"applicants", contracts:"applicants",
    offer:"applicants", intake:"applicants", spot:"applicants", partners:"applicants",
    ceo:"ceo",
    dashboard:"analytics", analytics:"analytics",   // hr/index.html は旧キー "dashboard" のまま
    materials:"materials", templates:"templates",
    tools:null
  };
  function injectStyles() {
    if (document.getElementById("hr-nav-v2-style")) return;
    const style = document.createElement("style");
    style.id = "hr-nav-v2-style";
    style.textContent = [
      ".hr-bar{gap:10px!important;padding-left:12px!important;padding-right:12px!important}",
      ".hr-bar .hr-nav{gap:0!important;min-width:0;justify-content:flex-start;overflow-x:auto;scrollbar-width:none}",
      ".hr-bar .hr-nav::-webkit-scrollbar{display:none}",
      ".hr-bar .hr-nav a{padding:0 8px!important;gap:3px!important;font-size:12px!important;white-space:nowrap;flex:0 0 auto}",
      // アイコンの幅を固定する（アイコンフォントが読めないときに、名前の文字列で横に伸びない）
      ".hr-bar .hr-nav a .material-symbols-outlined{font-size:16px!important;width:16px;flex:0 0 16px;overflow:hidden}",
      ".hr-bar .hr-nav a:focus-visible{outline:2px solid #3668a5;outline-offset:-2px}",
      ".hr-bar .hr-actions{flex-shrink:0}",
      "@media(max-width:1340px){.hr-bar .hr-back-t,.hr-bar .hr-add-t{display:none}.hr-bar .hr-add{padding:7px 8px}}",
      "@media(max-width:1120px){.hr-bar .hr-nav a{padding:0 6px!important}}",
      "@media(max-width:720px){.hr-bar .hr-nav{flex:1 0 100%}.hr-bar .hr-nav a{height:44px!important;padding:0 10px!important;font-size:12.5px!important}}"
    ].join("\n");
    document.head.appendChild(style);
  }
  function mappedActive(opts) {
    const active = opts && opts.active;
    if (!active) return "home";
    return Object.prototype.hasOwnProperty.call(ACTIVE, active) ? ACTIVE[active] : null;
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
      return '<a href="' + item.href + '" data-nav="' + item.key + '" class="' + [current ? "on" : "", item.manual ? "hr-manual-nav" : ""].join(" ").trim() + '"'
        + (current ? ' aria-current="page"' : "") + '>'
        + '<span class="material-symbols-outlined" aria-hidden="true">' + item.icon + '</span>'
        + esc(item.label) + '</a>';
    }).join("");
    nav.setAttribute("aria-label", "採用HRメインメニュー");
    // 操作マニュアルはメニューに1つだけ。右側の重複ボタンは外す（行き先のURLは同じ）。
    document.querySelectorAll(".hr-actions .hr-manual").forEach(node => node.remove());
    // 選択中の項目が横スクロールの外に隠れないようにする（狭い画面）。
    const on = nav.querySelector("a.on");
    if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, on.offsetLeft - 12);
    return result;
  };
  HRLayout.NAV_ITEMS = NAV.map(item => ({key:item.key, href:item.href, label:item.label, decisionOnly:Boolean(item.decisionOnly)}));
  HRLayout.navActiveFor = active => mappedActive({active});
  HRLayout.__navV2 = true;
})();
