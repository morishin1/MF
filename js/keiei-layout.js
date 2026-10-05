// 経営（/keiei）の枠と、画面の共通部品。
//
// ■ 権限
//   /keiei を開けるのは経営者（owner）だけ。ヘッダーの「経営」・この入口・/api/keiei は、
//   すべてサーバの判定（lib/gw.js canKeiei）にそろえる。/api/me の access.keiei で入口を決める
//   （画面側で役割を並べ直さない）。開けない人は、KPLayout がホームへ送り返す。
//   これは見た目の制御。中身の秘匿は API（owner だけ・二段階認証つき）が担う。
//
// ■ Office と同じ作り（2026-10-05 の UI/UX 刷新）
//   以前は、ロゴ＋左サイドメニューだけの専用ヘッダーだった。いまは採用HR・Sales・Office と同じ共通ヘッダー
//   （採用HR｜Sales｜Office｜経営）を KPLayout が描き、その下に経営内の横タブを出す
//   （ホーム｜売上・営業｜人・組織｜財務｜リスク。js/layout.js の KEIEI_TABS）。左サイドバーは持たない。
//   タブの行き先は URL のハッシュ（#sales など）で、ページは作り直さない。
//
// ■ ここに置くもの
//   ・見た目の値（採用HR・Sales・Office と同じ：背景 #f6f6f2・白カード・枠線 #e2e2dc・文字 #1b2440）
//   ・画面の中身で共通に使う小さな部品の CSS（.kei-*・.kd-*・.kg-*・.fn-*・.pc-*）
//   経営だけが持つ機能（入社準備・給与管理）の中身は、keiei/onboarding.js・keiei/pay.js
(function () {
  const esc = window.KPLayout ? window.KPLayout.esc
    : (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function css() {
    if (document.getElementById("kei-layout-css")) return;
    const style = document.createElement("style");
    style.id = "kei-layout-css";
    style.textContent = `
      /* アイコンは幅を 1em に固定する（フォント読込前に、アイコン名の文字が横にはみ出さないように） */
      body.kei-app .material-symbols-outlined { display:inline-block; width:1em; overflow:hidden; white-space:nowrap; line-height:1; flex:none; }
      body.kei-app { background:#f6f6f2; font-family:'Zen Kaku Gothic New', sans-serif;
        --k-ink:#1b2440; --k-sub:#4a5068; --k-mute:#6b7080; --k-faint:#9aa0b4; --k-line:#e2e2dc; --k-soft:#efefeb; --k-bg:#f6f6f2;
        --k-red:#b3261e; --k-red-bg:#fdecea; --k-amber:#7d5a00; --k-amber-bg:#fbf1d6; --k-green:#2f6f3a; --k-green-bg:#e5f1e2; }
      .kei-wrap { max-width:1200px; margin:0 auto; padding:24px 16px 80px; }
      @media (max-width: 820px) { .kei-wrap { padding:16px 14px 72px; } }
      #kei-main { min-width:0; }
      #kei-main > .kei-sec:first-child, #kei-main > h1.kei-title:first-child { margin-top:0; }
      h1.kei-title { font-size:24px; font-weight:700; color:var(--k-ink); margin:0 0 4px; }
      .kei-sub { color:var(--k-mute); font-size:13px; margin:0 0 20px; line-height:1.7; }
      .kei-sec { margin:0 0 26px; }
      .kei-sec-h { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; font-size:15px; font-weight:700; color:var(--k-ink); margin:0 0 10px; }
      .kei-sec-h small { font-size:12px; font-weight:400; color:var(--k-mute); }
      .kei-sec-h a { margin-left:auto; font-size:12px; font-weight:400; color:var(--k-mute); text-decoration:none; white-space:nowrap; }
      .kei-sec-h a:hover { color:var(--k-ink); }
      .kei-count { font-size:11.5px; font-weight:700; color:var(--k-mute); background:var(--k-soft); border-radius:999px; padding:1px 9px; }
      .kei-note { font-size:11.5px; color:var(--k-mute); line-height:1.8; margin:6px 0; }
      .kei-mute { font-size:12px; color:var(--k-faint); }
      .kei-empty { color:var(--k-faint); font-size:12.5px; padding:6px 0; }
      .kei-none { font-size:12.5px; color:var(--k-mute); background:#fff; border:1px dashed #c7cad4; border-radius:10px; padding:12px 14px; }
      .kei-panel { background:#fff; border:1px solid var(--k-line); border-radius:10px; padding:12px 16px; overflow-x:auto; }
      .kei-banner { background:#fff; border:1px solid var(--k-line); border-left:3px solid #e6f050; border-radius:8px; padding:11px 14px;
                    font-size:12.5px; color:var(--k-sub); line-height:1.8; margin:0 0 16px; }
      .kei-banner.warn { border-left-color:#e0a030; background:#fffaf0; }
      .kei-banner.err { border-left-color:var(--k-red); background:#fff5f4; }

      /* 状態の印：色だけに頼らず、ことばを添える */
      .kei-pill { display:inline-flex; align-items:center; gap:4px; border-radius:999px; padding:2px 10px; font-size:11px; font-weight:700; white-space:nowrap; }
      .kei-pill.high, .kei-pill.behind { background:var(--k-red-bg); color:var(--k-red); }
      .kei-pill.mid { background:var(--k-amber-bg); color:var(--k-amber); }
      .kei-pill.low, .kei-pill.unmeasured, .kei-pill.miss { background:var(--k-soft); color:var(--k-mute); }
      .kei-pill.ontrack, .kei-pill.ok { background:var(--k-green-bg); color:var(--k-green); }
      .kei-pill.prov { background:#fff2d6; color:#8a5a00; }
      .kei-pill.warn { background:var(--k-red-bg); color:var(--k-red); }

      /* ボタン：css/app.css の .btn（採用HR・Sales・Office と同じ） */
      .kei-btn { display:inline-flex; align-items:center; gap:6px; background:var(--primary, #3182ce); color:#fff; border:none; border-radius:8px;
                 padding:6px 12px; font-size:13px; font-weight:600; text-decoration:none; cursor:pointer; margin:4px 8px 4px 0; font-family:inherit; }
      .kei-btn.sec { background:#fff; color:var(--k-ink); border:1px solid #c7cad4; }
      .kei-btn.sm { padding:4px 10px; font-size:11.5px; margin:0; }
      .kei-btn[disabled] { opacity:.45; cursor:default; }
      .kei-go { display:inline-flex; align-items:center; gap:4px; font-size:12.5px; font-weight:600; color:var(--k-ink); text-decoration:none; white-space:nowrap;
                border:1px solid #c7cad4; border-radius:8px; padding:6px 12px; background:#fff; }
      .kei-go:hover { background:#f3f3ee; }

      /* 今日の判断 */
      .kd-chips { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 12px; }
      .kd-chip { display:inline-flex; align-items:baseline; gap:6px; background:#fff; border:1px solid var(--k-line); border-radius:999px; padding:6px 14px; font-size:12.5px; color:var(--k-sub); }
      .kd-chip b { font-size:17px; color:var(--k-ink); font-variant-numeric:tabular-nums; }
      .kd-chip.hot { border-color:#f1c4c0; background:#fff8f7; } .kd-chip.hot b { color:var(--k-red); }
      .kd-rows { display:flex; flex-direction:column; gap:8px; }
      .kd-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:4px 12px; align-items:center; background:#fff; border:1px solid var(--k-line);
                border-left:4px solid var(--k-line); border-radius:10px; padding:11px 14px; }
      .kd-row[data-severity="high"] { border-left-color:var(--k-red); }
      .kd-row[data-severity="mid"] { border-left-color:#e0a030; }
      .kd-more { margin-top:8px; }
      .kd-more summary { cursor:pointer; font-size:12.5px; font-weight:600; color:var(--k-sub); padding:8px 4px; list-style:none; display:inline-block; }
      .kd-more summary::-webkit-details-marker { display:none; }
      .kd-more summary::after { content:" ▾"; }
      .kd-more[open] summary::after { content:" ▴"; }
      .kd-more[open] summary { margin-bottom:4px; }
      .kd-tx { display:flex; flex-direction:column; gap:2px; min-width:0; }
      .kd-tx b { font-size:14px; color:var(--k-ink); }
      .kd-tx span { font-size:12.5px; color:var(--k-sub); line-height:1.6; }

      /* KGI：大きなカード */
      .kg-meta { font-size:12px; color:var(--k-mute); margin:-4px 0 10px; line-height:1.7; }
      .kg-cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
      .kg-card { background:#fff; border:1px solid var(--k-line); border-radius:12px; padding:16px 18px; min-width:0; }
      .kg-card .lb { font-size:12.5px; color:var(--k-mute); display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .kg-card .big { font-size:30px; font-weight:700; color:var(--k-ink); margin:8px 0 2px; letter-spacing:.01em; font-variant-numeric:tabular-nums; line-height:1.2; }
      .kg-card .big small { font-size:13px; font-weight:500; color:var(--k-mute); margin-left:4px; }
      .kg-card .big.miss { font-size:22px; color:var(--k-faint); }
      .kg-card .tg { font-size:12px; color:var(--k-mute); }
      .kg-card .why { font-size:11.5px; color:var(--k-faint); line-height:1.6; margin-top:6px; }
      .kg-card.miss { background:#fafaf7; border-style:dashed; }
      .kei-prog { display:block; height:6px; background:var(--k-soft); border-radius:99px; overflow:hidden; margin:10px 0 4px; }
      .kei-prog i { display:block; height:100%; background:var(--k-ink); border-radius:99px; }
      .kei-prog.ok i { background:var(--k-green); }
      .kg-pct { font-size:11.5px; color:var(--k-mute); font-variant-numeric:tabular-nums; }

      /* 営業ファネル：横に、接触 → 商談 → 提案 → 契約 */
      .fn { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:0; align-items:stretch; }
      .fn-step { position:relative; background:#fff; border:1px solid var(--k-line); border-radius:12px; padding:14px 16px; min-width:0; }
      .fn-step + .fn-step { margin-left:34px; }
      .fn-step + .fn-step::before { content:"→"; position:absolute; left:-27px; top:50%; transform:translateY(-50%); color:var(--k-faint); font-size:18px; }
      .fn-step .lb { font-size:12.5px; color:var(--k-mute); font-weight:700; }
      .fn-step .v { font-size:26px; font-weight:700; color:var(--k-ink); margin:6px 0 0; font-variant-numeric:tabular-nums; line-height:1.2; }
      .fn-step .v small { font-size:12px; font-weight:500; color:var(--k-mute); margin-left:3px; }
      .fn-step .v.miss { font-size:15px; color:var(--k-faint); margin:10px 0 4px; }
      .fn-step .tg { font-size:11.5px; color:var(--k-mute); line-height:1.7; margin-top:2px; }
      .fn-step .cv { display:inline-block; margin-top:8px; font-size:11.5px; font-weight:700; color:var(--k-sub); background:var(--k-soft); border-radius:999px; padding:2px 9px; }
      .fn-step .cv.na { color:var(--k-faint); font-weight:500; }
      .fn-foot { font-size:12px; color:var(--k-sub); margin:10px 2px 0; line-height:1.8; }
      .fn-foot b { color:var(--k-ink); }

      /* 担当者別：カード */
      .pc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:10px; }
      .pc { background:#fff; border:1px solid var(--k-line); border-radius:12px; padding:13px 15px; min-width:0; display:flex; flex-direction:column; gap:6px; }
      .pc-h { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
      .pc-h b { display:block; font-size:14.5px; color:var(--k-ink); }
      .pc-h span.r { display:block; font-size:11.5px; color:var(--k-mute); line-height:1.5; }
      .pc-main { display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; }
      .pc-main .v { font-size:20px; font-weight:700; color:var(--k-ink); font-variant-numeric:tabular-nums; }
      .pc-main .v small { font-size:11.5px; font-weight:500; color:var(--k-mute); margin-left:2px; }
      .pc-main .t { font-size:12px; color:var(--k-mute); }
      .pc-main .l { font-size:11.5px; color:var(--k-mute); width:100%; }
      .pc-next { font-size:12px; color:var(--k-sub); line-height:1.6; border-top:1px solid #f0f0ea; padding-top:7px; margin-top:auto; }
      .pc-next b { font-size:11px; color:var(--k-mute); font-weight:700; margin-right:6px; }
      .pc-more { font-size:11.5px; color:var(--k-mute); }
      .pc-kpis { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px 12px; margin:2px 0; }
      .pc-kpi .l { font-size:11px; color:var(--k-mute); line-height:1.4; }
      .pc-kpi .v { font-size:14px; font-weight:700; color:var(--k-ink); font-variant-numeric:tabular-nums; }
      .pc-kpi .v small { font-size:11px; font-weight:500; color:var(--k-mute); }
      .pc-kpi.na .v { font-size:12px; color:var(--k-faint); }
      .pc-kpi .w { font-size:10.5px; color:var(--k-faint); line-height:1.5; }

      /* 数字のタイル（お金・人・組織） */
      .kt-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:10px; }
      .kt { background:#fff; border:1px solid var(--k-line); border-radius:10px; padding:12px 14px; text-decoration:none; color:inherit; display:block; }
      a.kt:hover { border-color:#b8bccb; }
      .kt .lb { font-size:12px; color:var(--k-mute); }
      .kt .val { font-size:24px; font-weight:700; color:var(--k-ink); margin:4px 0 2px; font-variant-numeric:tabular-nums; }
      .kt .val small { font-size:12px; font-weight:500; color:var(--k-mute); margin-left:2px; }
      .kt .val.miss { font-size:13px; color:var(--k-faint); margin:9px 0 7px; }
      .kt .sub { font-size:11.5px; color:var(--k-mute); line-height:1.5; min-height:1.5em; }
      .kt.miss { background:#fafaf7; border-style:dashed; }

      /* リスク・停滞 */
      .kr-row, .ks-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:4px 12px; align-items:center; padding:11px 0; border-top:1px solid #f0f0ea; }
      .kr-row:first-child, .ks-row:first-child { border-top:0; }
      .kr-sub { font-size:13px; font-weight:700; color:var(--k-ink); margin:16px 0 8px; }

      /* 表（売上・営業／財務／セキュリティ） */
      table.kei-t { border-collapse:collapse; width:100%; font-size:13px; }
      table.kei-t th { text-align:left; font-size:11.5px; color:var(--k-mute); font-weight:500; padding:6px 8px; border-bottom:1px solid var(--k-line); white-space:nowrap; }
      table.kei-t td { padding:8px; border-bottom:1px solid #f0f0ea; vertical-align:top; }
      table.kei-t td.n, table.kei-t th.n { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
      table.kei-t tr.dim td { color:var(--k-faint); }
      table.kei-t tr.na td { color:var(--k-faint); }
      .kei-why { display:block; font-size:11px; color:var(--k-faint); margin-top:2px; font-weight:400; line-height:1.5; white-space:normal; }

      @media (max-width: 1000px) {
        .fn { grid-template-columns:repeat(2,minmax(0,1fr)); gap:34px 0; }
        .fn-step + .fn-step { margin-left:0; }
        .fn-step + .fn-step::before { display:none; }
        .fn-step:nth-child(even) { margin-left:34px; }
        .fn-step:nth-child(even)::before { display:block; content:"→"; position:absolute; left:-27px; top:50%; transform:translateY(-50%); color:var(--k-faint); font-size:18px; }
      }
      @media (max-width: 820px) {
        h1.kei-title { font-size:21px; }
        .kd-row, .kr-row, .ks-row { grid-template-columns:auto minmax(0,1fr); }
        .kd-row .kei-go, .kr-row .kei-go, .ks-row .kei-go { grid-column:1 / -1; justify-self:start; }
        .kt-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .kg-card .big { font-size:26px; }
      }
      @media (max-width: 700px) {
        .kg-cards { grid-template-columns:1fr; }
      }
      @media (max-width: 560px) {
        .pc-grid { grid-template-columns:1fr; }
        .fn { grid-template-columns:1fr; gap:30px 0; }
        .fn-step:nth-child(even) { margin-left:0; }
        .fn-step + .fn-step::before, .fn-step:nth-child(even)::before { display:block; content:"↓"; left:50%; top:-26px; transform:translateX(-50%); }
      }
    `;
    document.head.appendChild(style);
  }

  // サーバの判定（canKeiei）そのもの。役割の並びを画面で持たない。API.warm にも渡す
  function allows(me) { return me?.access ? Boolean(me.access.keiei) : (me?.gw?.roles || []).includes("owner"); }

  /** 画面を切り替えたとき、横タブの強調だけ更新する（ページは作り直さない） */
  function setActive(view) { if (window.KPLayout?.setKeieiView) KPLayout.setKeieiView(view); }

  // 枠（共通ヘッダー・横タブ）は KPLayout が描く。経営者でなければ KPLayout がホームへ送り返す（null）
  async function init() {
    css();
    if (!window.API || !window.KPLayout || !API.isLoggedIn()) { location.href = "/index.html"; return null; }
    const got = await KPLayout.init({ active: "keiei_home", access: "keiei" });
    if (!got) return null;
    document.body.classList.add("kei-app");
    return { me: got.me };
  }

  window.KeieiLayout = { init, allows, setActive, esc };
})();
