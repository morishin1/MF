// 経営（/keiei）の「予定・日報確認」（#schedule）。メンバーが今日何をしたか（日報）、明日以降どう動くか（業務予定）を見る画面。
//
// ■ ここでしないこと（Phase 1）
//   予定・日報の編集はしない。経営の確認（［問題なし］［修正依頼］［コメント］）・本人への通知も、まだ無い（Phase 2・3）。
//   ボタンだけ置いて押せない、ということはしない。置き場所はドロワーの data-slot="review-actions"（コメント参照）。
//   予定のメモ（body）は API が返さない（本人だけのもの）。重要度の欄は持たない。
//
// ■ データ
//   GET /api/keiei?view=schedule&period=day|week|month&date=YYYY-MM-DD[&employeeId=…]（lib/keiei-schedule-read.js）。
//   提出・未登録・休暇・対象外・取得できません の判定はサーバが決めたものをそのまま出す。ここで判定し直さない。
//
// index.html（/keiei）から window.KeieiSchedule.open(mainElement, isStale) で呼ばれる。
(function () {
  const esc = window.KeieiLayout ? window.KeieiLayout.esc
    : (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CSS = `
    .ks-nav { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; font-size:12.5px; margin:0 0 6px; }
    .ks-nav a { color:var(--k-mute,#6b7080); text-decoration:none; }
    .ks-nav a:hover { color:var(--k-ink,#1b2440); text-decoration:underline; }
    .ks-bar { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; margin:0 0 10px; }
    .ks-seg { display:inline-flex; border:1px solid #c7cad4; border-radius:8px; overflow:hidden; background:#fff; }
    .ks-seg button { border:0; background:#fff; color:var(--k-sub,#4a5068); font:inherit; font-size:13px; padding:6px 12px; cursor:pointer; min-height:34px; }
    .ks-seg button + button { border-left:1px solid #e2e2dc; }
    .ks-seg button[aria-pressed="true"] { background:var(--k-ink,#1b2440); color:#fff; font-weight:700; }
    .ks-seg button:disabled { color:#c0c3cf; cursor:not-allowed; }
    .ks-date { display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
    .ks-date .lbl { font-weight:700; color:var(--k-ink,#1b2440); font-size:14px; min-width:0; }
    .ks-ib { border:1px solid #c7cad4; background:#fff; border-radius:8px; min-width:34px; min-height:34px; font:inherit; font-size:13px; cursor:pointer; color:var(--k-ink,#1b2440); padding:0 10px; }
    .ks-bar input, .ks-bar select { margin:0; width:auto; max-width:100%; font-size:13px; padding:6px 8px; border:1px solid #c7cad4; border-radius:8px; font-family:inherit; background:#fff; box-sizing:border-box; min-height:34px; }
    .ks-bar input[type=search] { width:180px; }
    .ks-tiles { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:0 0 6px; }
    .ks-tile { text-align:left; background:#fff; border:1px solid var(--k-line,#e2e2dc); border-radius:10px; padding:10px 12px; font:inherit; cursor:pointer; color:inherit; min-width:0; }
    .ks-tile:hover { border-color:#b8bccb; }
    .ks-tile[aria-pressed="true"] { border-color:var(--k-ink,#1b2440); box-shadow:inset 0 0 0 1px var(--k-ink,#1b2440); background:#f4f5f9; }
    .ks-tile:disabled { cursor:default; }
    .ks-tile .lb { font-size:12px; color:var(--k-mute,#6b7080); }
    .ks-tile .val { font-size:21px; font-weight:700; color:var(--k-ink,#1b2440); font-variant-numeric:tabular-nums; margin-top:2px; }
    .ks-tile .val small { font-size:12px; font-weight:500; color:var(--k-mute,#6b7080); margin-left:2px; }
    .ks-tile .val.miss { font-size:13px; color:var(--k-faint,#9aa0b4); font-weight:500; }
    .ks-tile .sub { font-size:11.5px; color:var(--k-mute,#6b7080); margin-top:2px; }
    .ks-tile .sub b { color:var(--k-red,#b3261e); }
    .ks-filter { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--k-sub,#4a5068); margin:4px 0 8px; min-height:24px; }
    .ks-filter button { border:0; background:none; color:var(--k-ink,#1b2440); text-decoration:underline; cursor:pointer; font:inherit; font-size:12.5px; padding:4px; }
    .ks-list { display:grid; gap:6px; }
    .ks-row { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.3fr); gap:4px 12px; align-items:center;
      width:100%; text-align:left; background:#fff; border:1px solid var(--k-line,#e2e2dc); border-radius:10px; padding:10px 12px; font:inherit; color:inherit; cursor:pointer; box-sizing:border-box; }
    .ks-row:hover { border-color:#b8bccb; }
    .ks-row.att { border-left:3px solid var(--k-red,#b3261e); }
    .ks-row > span { display:block; min-width:0; font-size:13px; }
    .ks-row .nm { font-weight:700; color:var(--k-ink,#1b2440); font-size:14px; overflow-wrap:anywhere; }
    .ks-row .k { display:none; font-size:11px; color:var(--k-mute,#6b7080); }
    .ks-head { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.3fr); gap:12px; padding:0 13px; font-size:11.5px; color:var(--k-mute,#6b7080); }
    .ks-why { font-size:11.5px; color:var(--k-mute,#6b7080); line-height:1.5; }
    .ks-bad { color:var(--k-red,#b3261e); font-weight:700; }
    .ks-m { display:inline-block; border-radius:999px; padding:1px 9px; font-size:11.5px; font-weight:700; white-space:nowrap; }
    .ks-m.has, .ks-m.submitted { background:var(--k-green-bg,#e5f1e2); color:var(--k-green,#2f6f3a); }
    .ks-m.none, .ks-m.missing { background:var(--k-red-bg,#fdecea); color:var(--k-red,#b3261e); }
    .ks-m.leave { background:#e8eef9; color:#2d4f8a; }
    .ks-m.off, .ks-m.future { background:#ecece6; color:var(--k-mute,#6b7080); }
    .ks-m.error { background:#fafaf7; color:var(--k-faint,#9aa0b4); border:1px dashed #c7cad4; }
    table.ks-wk { width:100%; table-layout:fixed; border-collapse:separate; border-spacing:0; background:#fff; border:1px solid var(--k-line,#e2e2dc); border-radius:10px; overflow:hidden; font-size:12.5px; }
    table.ks-wk th { font-weight:500; font-size:11.5px; color:var(--k-mute,#6b7080); background:#f6f6f2; padding:6px 2px; text-align:center; border-bottom:1px solid var(--k-line,#e2e2dc); }
    table.ks-wk th.nm { text-align:left; padding-left:10px; width:22%; }
    table.ks-wk th.hol { color:var(--k-red,#b3261e); }
    table.ks-wk th.td { background:#eef0f6; color:var(--k-ink,#1b2440); font-weight:700; }
    table.ks-wk td { border-bottom:1px solid #f0f0ea; padding:3px 2px; text-align:center; }
    table.ks-wk td.nm { text-align:left; padding:6px 6px 6px 10px; font-weight:700; color:var(--k-ink,#1b2440); overflow-wrap:anywhere; font-size:13px; }
    table.ks-wk tr:last-child td { border-bottom:0; }
    .ks-c { width:100%; min-height:34px; border:0; border-radius:6px; font:inherit; font-size:12px; cursor:pointer; padding:2px 0; font-weight:700; }
    .ks-c.has { background:var(--k-green-bg,#e5f1e2); color:var(--k-green,#2f6f3a); }
    .ks-c.none { background:var(--k-red-bg,#fdecea); color:var(--k-red,#b3261e); }
    .ks-c.none.later { background:#f6f6f2; color:var(--k-mute,#6b7080); font-weight:500; }
    .ks-c.leave { background:#e8eef9; color:#2d4f8a; }
    .ks-c.off { background:transparent; color:#b8bccb; font-weight:500; }
    .ks-c.error { background:#fafaf7; color:var(--k-faint,#9aa0b4); border:1px dashed #c7cad4; }
    .ks-legend { display:flex; flex-wrap:wrap; gap:6px 12px; font-size:11.5px; color:var(--k-mute,#6b7080); margin:8px 0 0; align-items:center; }
    .ks-legend .ks-c { width:auto; min-height:0; padding:1px 8px; cursor:default; display:inline-block; }
    .ks-ev { display:grid; grid-template-columns:auto minmax(0,1fr); gap:2px 12px; width:100%; text-align:left; background:#fff; border:1px solid var(--k-line,#e2e2dc);
      border-radius:10px; padding:10px 12px; font:inherit; color:inherit; cursor:pointer; box-sizing:border-box; margin:0 0 6px; }
    .ks-ev:hover { border-color:#b8bccb; }
    .ks-ev .tm { font-variant-numeric:tabular-nums; font-size:13px; color:var(--k-sub,#4a5068); white-space:nowrap; }
    .ks-ev .tt { font-weight:700; color:var(--k-ink,#1b2440); font-size:14px; overflow-wrap:anywhere; }
    .ks-ev .mt { grid-column:2; font-size:11.5px; color:var(--k-mute,#6b7080); overflow-wrap:anywhere; }
    .ks-panel { background:#fff; border:1px solid var(--k-line,#e2e2dc); border-radius:10px; padding:12px 14px; margin:0 0 10px; }
    .ks-panel h3 { font-size:13.5px; margin:0 0 8px; color:var(--k-ink,#1b2440); display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .ks-panel ul { margin:0; padding-left:18px; font-size:13px; line-height:1.7; }
    .ks-panel p { margin:4px 0; font-size:13px; line-height:1.7; }
    .ks-week { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:8px; }
    .ks-wd { background:#fff; border:1px solid var(--k-line,#e2e2dc); border-radius:10px; padding:8px; min-width:0; }
    .ks-wd.off { background:#fafaf7; }
    .ks-wd .h { display:flex; align-items:center; justify-content:space-between; gap:6px; width:100%; border:0; background:none; font:inherit; cursor:pointer; padding:2px 0 6px; color:var(--k-ink,#1b2440); font-weight:700; font-size:13px; }
    .ks-wd .h.hol { color:var(--k-red,#b3261e); }
    .ks-wd .ks-ev { grid-template-columns:1fr; padding:6px 8px; margin:0 0 4px; }
    .ks-wd .ks-ev .mt { grid-column:1; }
    .ks-wd .ks-ev .tt { font-size:12.5px; }
    .ks-wd .ks-ev .tm { font-size:11.5px; }
    .ks-mon { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:4px; }
    .ks-mon .dw { text-align:center; font-size:11.5px; color:var(--k-mute,#6b7080); padding:2px 0; }
    .ks-md { min-height:62px; border:1px solid var(--k-line,#e2e2dc); border-radius:8px; background:#fff; font:inherit; text-align:left; padding:4px 6px; cursor:pointer;
      display:flex; flex-direction:column; gap:3px; color:var(--k-ink,#1b2440); min-width:0; box-sizing:border-box; }
    .ks-md:hover { border-color:#b8bccb; }
    .ks-md .d { font-size:12.5px; font-weight:700; }
    .ks-md.hol .d { color:var(--k-red,#b3261e); }
    .ks-md.td { box-shadow:inset 0 0 0 2px var(--k-ink,#1b2440); }
    .ks-md.off { background:#fafaf7; }
    .ks-md .n { font-size:11px; border-radius:999px; padding:0 6px; align-self:flex-start; font-weight:700; white-space:nowrap; }
    .ks-md .n.has { background:var(--k-green-bg,#e5f1e2); color:var(--k-green,#2f6f3a); }
    .ks-md .n.none { background:var(--k-red-bg,#fdecea); color:var(--k-red,#b3261e); }
    .ks-md .n.none.later { background:#f0f0ea; color:var(--k-mute,#6b7080); font-weight:500; }
    .ks-md .n.leave { background:#e8eef9; color:#2d4f8a; }
    .ks-md .n.error { color:var(--k-faint,#9aa0b4); border:1px dashed #c7cad4; }
    .ks-md .nb { font-size:10.5px; color:var(--k-mute,#6b7080); }
    .ks-md .nb.miss { color:var(--k-red,#b3261e); }
    .ks-dr-bg { position:fixed; inset:0; background:rgba(20,24,40,.35); z-index:80; }
    .ks-dr { position:fixed; top:0; right:0; bottom:0; width:min(520px,100%); background:#fafaf7; z-index:81; overflow-y:auto; box-shadow:-8px 0 24px rgba(0,0,0,.12); box-sizing:border-box; }
    .ks-dr-in { padding:18px 18px 48px; }
    .ks-dr-h { display:flex; align-items:flex-start; gap:10px; margin:0 0 6px; }
    .ks-dr-h h2 { margin:0; font-size:18px; color:var(--k-ink,#1b2440); overflow-wrap:anywhere; min-width:0; }
    .ks-dr-h .x { margin-left:auto; flex:none; }
    .ks-scope { font-size:12px; color:var(--k-sub,#4a5068); background:#ecece6; border-radius:6px; padding:4px 8px; display:inline-block; margin:0 0 10px; }
    .ks-back { border:0; background:none; font:inherit; font-size:12.5px; color:var(--k-mute,#6b7080); cursor:pointer; padding:4px 0; margin:0 0 6px; }
    dl.ks-dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:5px 14px; margin:0; font-size:13px; }
    dl.ks-dl dt { color:var(--k-mute,#6b7080); font-size:12px; }
    dl.ks-dl dd { margin:0; overflow-wrap:anywhere; }
    .ks-links { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 0; }
    @media (max-width: 900px) {
      .ks-week { grid-template-columns:repeat(2,minmax(0,1fr)); }
    }
    @media (max-width: 760px) {
      .ks-tiles { grid-template-columns:1fr; gap:6px; }
      .ks-tile { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:0 10px; padding:8px 12px; }
      .ks-tile .val { grid-row:1 / span 2; grid-column:2; font-size:18px; margin:0; text-align:right; }
      .ks-head { display:none; }
      .ks-row { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .ks-row .nm { grid-column:1 / -1; }
      .ks-row .k { display:block; }
      .ks-row .ck { grid-column:1 / -1; }
      .ks-bar input[type=search] { width:100%; }
      .ks-bar .ks-q { flex:1 1 100%; }
      table.ks-wk th.nm { width:24%; }
      table.ks-wk td.nm { font-size:11.5px; padding:4px 2px 4px 6px; }
      table.ks-wk th { font-size:10.5px; padding:4px 0; }
      .ks-c { font-size:11px; min-height:32px; }
      .ks-week { grid-template-columns:1fr; }
      .ks-md { min-height:52px; padding:3px; }
      .ks-md .nb { display:none; }
      .ks-dr { width:100%; }
      .ks-dr-in { padding:14px 14px 40px; }
    }`;
  function style() {
    if (document.getElementById("ks-style")) return;
    const s = document.createElement("style"); s.id = "ks-style"; s.textContent = CSS; document.head.appendChild(s);
  }

  // ---- 日付 --------------------------------------------------------------------
  const JST = 9 * 3600000;
  const DOW = ["日", "月", "火", "水", "木", "金", "土"];
  const todayJst = () => new Date(Date.now() + JST).toISOString().slice(0, 10);
  const utc = (d) => new Date(`${d}T00:00:00Z`);
  const addDays = (d, n) => { const x = utc(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const addMonths = (d, n) => { const x = utc(`${d.slice(0, 7)}-01`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const mdw = (d) => `${md(d)}（${DOW[utc(d).getUTCDay()]}）`;
  const tOf = (ts) => new Date(Date.parse(ts) + JST).toISOString().slice(11, 16);
  const dOf = (ts) => new Date(Date.parse(ts) + JST).toISOString().slice(0, 10);
  const jstMs = (d) => Date.parse(`${d}T00:00:00Z`) - JST;
  const stamp = (ts) => { if (!ts) return "—"; const d = dOf(ts); return `${d.slice(0, 4)}/${md(d)} ${tOf(ts)}`; };
  const mins = (n) => n >= 60 ? `${Math.floor(n / 60)}時間${n % 60 ? `${n % 60}分` : ""}` : `${n}分`;

  const CATEGORY = { work: "業務", meeting: "会議", visit: "訪問", other: "その他" };
  const MARK_SHORT = { has: "", none: "未", leave: "休", off: "—", error: "？" };
  const TILE_LABEL = { nippoMissing: "日報が未提出の人", scheduleMissing: "翌営業日の予定が未登録の人", attention: "要対応の人" };

  // 画面の状態。scope: all（全員）| member（メンバー別）。tile: 集計カードの絞り込み
  const S = { scope: "all", period: "day", date: null, emp: null, q: "", tile: null };
  let main = null, D = null, loading = false, failed = null, seq = 0, roster = [];

  // ---- 読み込み ------------------------------------------------------------------
  const keyOf = () => `${S.scope}|${S.period}|${S.date}|${S.scope === "member" ? S.emp : ""}`;
  async function load(isStale) {
    const mine = ++seq;
    loading = true; failed = null; render();
    const p = new URLSearchParams({ period: S.period, date: S.date });
    if (S.scope === "member" && S.emp) p.set("employeeId", S.emp);
    try {
      const d = await API.api(`/api/keiei?view=schedule&${p.toString()}`);
      if (mine !== seq || (isStale && isStale())) return;
      D = { ...d, key: keyOf() };
      if (Array.isArray(d.roster)) roster = d.roster;
    } catch (e) {
      if (mine !== seq || (isStale && isStale())) return;
      if (e.status === 403) { location.replace("/home.html"); return; }
      failed = e;
    }
    loading = false; render();
  }

  // ---- 部品 ----------------------------------------------------------------------
  const pill = (cls, label) => `<span class="ks-m ${esc(cls)}">${esc(cls === "future" ? "まだ先の日" : label)}</span>`;
  const segBtn = (group, val, label, on, disabled = false, title = "") =>
    `<button type="button" data-${group}="${val}" aria-pressed="${on ? "true" : "false"}"${disabled ? " disabled" : ""}${title ? ` title="${esc(title)}"` : ""} onclick="KeieiSchedule.set('${group}','${val}')">${esc(label)}</button>`;
  const personOf = (id) => D?.people?.find((p) => p.employeeId === id) || null;
  const eventsOf = (id, date) => (D?.events || []).filter((e) => e.employeeId === id && e.dates.includes(date))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.startsAt) - Date.parse(b.startsAt));
  function timeRange(e, date) {
    if (e.allDay) return "終日";
    const s = dOf(e.startsAt) < date ? "0:00" : tOf(e.startsAt);
    const t = dOf(e.endsAt) > date ? "24:00" : tOf(e.endsAt);
    return `${s}〜${t}`;
  }
  const eventBtn = (e, date, from) => `<button type="button" class="ks-ev" data-ev="${esc(e.id)}" onclick="KeieiSchedule.openEvent('${esc(e.id)}','${date}','${from}')">
      <span class="tm">${esc(timeRange(e, date))}</span><span class="tt">${esc(e.title)}</span>
      <span class="mt">${esc(CATEGORY[e.category] || e.category || "")}${e.location ? `・${esc(e.location)}` : ""}</span></button>`;
  const periodLabel = () => {
    if (!D) return "";
    if (S.period === "day") return `${mdw(D.from)}${D.from === D.today ? "（今日）" : ""}`;
    if (S.period === "week") return `${mdw(D.from)} 〜 ${mdw(D.to)}`;
    return `${D.from.slice(0, 4)}年${Number(D.from.slice(5, 7))}月`;
  };
  const checkText = (c) => !c ? `<span class="ks-why">—</span>`
    : c.verdict === "adjust" ? `<span class="ks-bad">指摘あり</span><span class="ks-why">${esc([c.overlaps ? `重なり${c.overlaps}件` : "", c.totalMinutes > 540 ? "9時間超" : ""].filter(Boolean).join("・") || "時間配分")}</span>`
    : `<span class="ks-why">指摘なし（${esc(mins(c.totalMinutes))}）</span>`;

  // 集計カードの絞り込み
  function matches(p) {
    if (S.q && !String(p.name || "").includes(S.q)) return false;
    if (!S.tile) return true;
    if (S.tile === "nippoMissing") return p.attention.nippoMissing;
    if (S.tile === "scheduleMissing") { const n = D.nextBizDay && p.days[D.nextBizDay]; return Boolean(n && n.target && n.mark === "none"); }
    return p.attention.any;
  }

  // ---- 上部 ----------------------------------------------------------------------
  function toolbar() {
    const all = S.scope === "all";
    const opts = roster.map((r) => `<option value="${esc(r.employeeId)}" ${S.emp === r.employeeId ? "selected" : ""}>${esc(r.name)}${r.department ? `（${esc(r.department)}）` : ""}</option>`).join("");
    return `<div class="ks-bar" data-role="switch">
        <div class="ks-seg" role="group" aria-label="表示する人">${segBtn("scope", "all", "全員", all)}${segBtn("scope", "member", "メンバー別", !all)}</div>
        <div class="ks-seg" role="group" aria-label="期間">${segBtn("period", "day", "日", S.period === "day")}${segBtn("period", "week", "週", S.period === "week")}${segBtn("period", "month", "月", S.period === "month", all, "月はメンバー別で見られます")}</div>
      </div>
      <div class="ks-bar">
        <div class="ks-date">
          <button type="button" class="ks-ib" data-nav="prev" aria-label="前へ" onclick="KeieiSchedule.move(-1)">‹</button>
          <span class="lbl" data-role="period-label">${esc(periodLabel())}</span>
          <button type="button" class="ks-ib" data-nav="next" aria-label="次へ" onclick="KeieiSchedule.move(1)">›</button>
          <button type="button" class="ks-ib" data-nav="today" onclick="KeieiSchedule.toToday()">今日へ</button>
          <input type="date" id="ks-date" value="${esc(S.date)}" aria-label="日付を選ぶ" onchange="KeieiSchedule.setDate(this.value)">
        </div>
        ${all ? `<span class="ks-q"><input type="search" id="ks-q" placeholder="名前で探す" aria-label="名前で探す" value="${esc(S.q)}" oninput="KeieiSchedule.search(this.value)"></span>`
          : `<select id="ks-emp" aria-label="メンバーを選ぶ" onchange="KeieiSchedule.pick(this.value)">${opts}</select>`}
      </div>`;
  }

  function tiles() {
    const s = D.summary;
    const t = (key, label, val, sub, enabled) => `<button type="button" class="ks-tile" data-tile="${key}" aria-pressed="${S.tile === key ? "true" : "false"}"${enabled ? "" : " disabled"}
        onclick="KeieiSchedule.tile('${key}')"><div class="lb">${esc(label)}</div>${val}<div class="sub">${sub}</div></button>`;
    const miss = `<div class="val miss">取得できません</div>`;
    const n = s.nippo, x = s.next, a = s.attention;
    const nippoLabel = `${D.date === D.today ? "今日" : mdw(D.date)}の日報`;
    const nippoVal = !n ? miss : n.bizDay === false && !n.target ? `<div class="val miss">休日</div>`
      : `<div class="val">${n.submitted}<small>/ ${n.target}人 提出</small></div>`;
    const nippoSub = !n ? "未提出かどうか分かりません" : n.future ? "まだ先の日です（未提出と数えません）" : `未提出 <b>${n.missing}</b>人`;
    const nextVal = !x ? miss : `<div class="val">${x.registered}<small>/ ${x.target}人 登録</small></div>`;
    const nextSub = !x ? "未登録かどうか分かりません" : `${esc(mdw(x.date))}・未登録 <b>${x.missing}</b>人`;
    const attVal = !a ? miss : `<div class="val">${a.people}<small>人</small></div>`;
    const attSub = !a ? "" : [a.nippoMissing == null ? "日報：取得できません" : `日報未提出 ${a.nippoMissing}`, a.scheduleMissing == null ? "予定：取得できません" : `予定未登録 ${a.scheduleMissing}`].join("・");
    return `<div class="ks-tiles" data-role="tiles">
        ${t("nippoMissing", nippoLabel, nippoVal, nippoSub, Boolean(n) && !n.future)}
        ${t("scheduleMissing", "翌営業日の予定", nextVal, nextSub, Boolean(x))}
        ${t("attention", "要対応", attVal, esc(attSub), Boolean(a))}
      </div>
      <div class="ks-filter" data-role="filter">${S.tile ? `<span>絞り込み中：${esc(TILE_LABEL[S.tile])}</span><button type="button" data-role="clear" onclick="KeieiSchedule.tile(null)">解除</button>` : ""}</div>`;
  }

  // ---- 全員×日 -------------------------------------------------------------------
  function allDay() {
    const rows = D.people.filter(matches);
    const nx = D.nextBizDay;
    const nippoH = D.date === D.today ? "今日の日報" : `${mdw(D.date)}の日報`;
    const nextH = nx ? `翌営業日 ${mdw(nx)} の予定` : "翌営業日の予定";
    const list = rows.map((p) => {
      const a = p.days[D.date], n = nx ? p.days[nx] : null;
      const sched = !n ? `<span class="ks-why">—</span>` : n.mark === "has" ? `${pill("has", `${n.count}件`)}` : pill(n.mark, n.mark === "off" && n.reason ? `対象外（${n.reason}）` : n.markLabel);
      return `<button type="button" class="ks-row${p.attention.any ? " att" : ""}" data-emp="${esc(p.employeeId)}" onclick="KeieiSchedule.openDay('${esc(p.employeeId)}','${esc(nx || D.date)}')">
          <span class="nm">${esc(p.name)}${p.department ? `<span class="ks-why" style="display:block;font-weight:400">${esc(p.department)}</span>` : ""}</span>
          <span><span class="k">${esc(nippoH)}</span>${pill(a.nippo.state, a.nippo.state === "off" && a.reason ? `対象外（${a.reason}）` : a.nippo.label)}</span>
          <span><span class="k">${esc(nextH)}</span>${sched}</span>
          <span class="ck"><span class="k">時間割チェック</span>${checkText(n?.check)}</span></button>`;
    }).join("");
    return `${tiles()}
      <div class="ks-head" aria-hidden="true"><span>メンバー（要対応が上）</span><span>${esc(nippoH)}</span><span>${esc(nextH)}</span><span>時間割チェック（自動計算）</span></div>
      <div class="ks-list" data-role="list">${list || `<div class="kei-none" data-role="none">条件に合うメンバーはいません</div>`}</div>`;
  }

  // ---- 全員×週 -------------------------------------------------------------------
  function allWeek() {
    const rows = D.people.filter(matches);
    const head = D.days.map((d) => `<th class="${d.holiday || d.dow === 0 ? "hol" : ""}${d.isToday ? " td" : ""}" scope="col">${Number(d.date.slice(8, 10))}<br>${DOW[d.dow]}</th>`).join("");
    const body = rows.map((p) => `<tr data-emp="${esc(p.employeeId)}"><td class="nm">${esc(p.name)}</td>${D.days.map((d) => {
      const x = p.days[d.date];
      const label = x.mark === "has" ? `${x.count}` : MARK_SHORT[x.mark];
      const later = x.mark === "none" && D.dueBy && d.date > D.dueBy ? " later" : "";
      const aria = `${p.name} ${mdw(d.date)} ${x.mark === "has" ? `予定 ${x.count}件` : x.markLabel}${x.reason && x.mark === "off" ? `（${x.reason}）` : ""}`;
      return `<td><button type="button" class="ks-c ${x.mark}${later}" data-date="${d.date}" data-mark="${x.mark}" aria-label="${esc(aria)}" title="${esc(aria)}"
        onclick="KeieiSchedule.openDay('${esc(p.employeeId)}','${d.date}')">${esc(label)}</button></td>`;
    }).join("")}</tr>`).join("");
    return `${tiles()}
      ${rows.length ? `<table class="ks-wk" data-role="week"><thead><tr><th class="nm" scope="col">メンバー</th>${head}</tr></thead><tbody>${body}</tbody></table>`
        : `<div class="kei-none" data-role="none">条件に合うメンバーはいません</div>`}
      <div class="ks-legend" data-role="legend"><span><span class="ks-c has">2</span> 予定あり（件数）</span><span><span class="ks-c none">未</span> 未登録</span><span><span class="ks-c none later">未</span> 未登録（${esc(D.dueBy ? mdw(D.dueBy) : "翌営業日")}より先・まだ期限前）</span>
        <span><span class="ks-c leave">休</span> 休暇</span><span><span class="ks-c off">—</span> 対象外（休日・入社前・退職後）</span><span><span class="ks-c error">？</span> 取得できません</span></div>`;
  }

  // ---- メンバー別 ----------------------------------------------------------------
  function memberHead(p) {
    const a = p.days[D.date];
    return `<div class="ks-panel" data-role="member-head"><h3>${esc(p.name)}${p.department ? `<span class="ks-why">${esc(p.department)}</span>` : ""}</h3>
      <p>${esc(D.date === D.today ? "今日" : mdw(D.date))}の日報：${pill(a.nippo.state, a.nippo.label)}
      ${D.nextBizDay && p.days[D.nextBizDay] ? `　翌営業日 ${esc(mdw(D.nextBizDay))} の予定：${p.days[D.nextBizDay].mark === "has" ? pill("has", `${p.days[D.nextBizDay].count}件`) : pill(p.days[D.nextBizDay].mark, p.days[D.nextBizDay].markLabel)}` : ""}</p></div>`;
  }
  function memberDay(p) {
    const d = D.date, x = p.days[d], evs = eventsOf(p.employeeId, d);
    return `${memberHead(p)}
      <div class="ks-panel" data-role="day"><h3>${esc(mdw(d))} の予定 ${x.mark === "has" ? pill("has", `${x.count}件`) : pill(x.mark, x.mark === "off" && x.reason ? `対象外（${x.reason}）` : x.markLabel)}</h3>
        ${x.mark === "error" ? `<p class="ks-why">予定を読み込めませんでした（予定が無いという意味ではありません）。</p>` : ""}
        <div data-role="events">${evs.map((e) => eventBtn(e, d, "")).join("") || (x.mark === "error" ? "" : `<p class="ks-why">業務予定はありません。</p>`)}</div>
        ${x.check ? `<p class="ks-why" data-role="check">時間割チェック（自動計算・AIは使っていません）：${esc(x.check.notes.join(" ") || "指摘なし")}</p>` : ""}
        <!-- Phase 2：この日全体への［問題なし］［修正依頼］［コメント］をここに置く（未実装のため、ボタンは出さない） -->
      </div>`;
  }
  function memberWeek(p) {
    const cols = D.days.map((d) => {
      const x = p.days[d.date], evs = eventsOf(p.employeeId, d.date);
      return `<div class="ks-wd${x.target ? "" : " off"}" data-date="${d.date}">
        <button type="button" class="h${d.holiday || d.dow === 0 ? " hol" : ""}" onclick="KeieiSchedule.openDay('${esc(p.employeeId)}','${d.date}')" aria-label="${esc(mdw(d.date))} の予定一覧を開く">
          <span>${esc(mdw(d.date))}</span>${x.mark === "has" ? pill("has", `${x.count}件`) : pill(x.mark, x.markLabel)}</button>
        ${evs.map((e) => eventBtn(e, d.date, "")).join("")}</div>`;
    }).join("");
    return `${memberHead(p)}<div class="ks-week" data-role="member-week">${cols}</div>`;
  }
  function memberMonth(p) {
    const first = D.days[0];
    const pad = (first.dow + 6) % 7;   // 月曜はじまり
    const cells = D.days.map((d) => {
      const x = p.days[d.date];
      const n = x.mark === "has" ? `<span class="n has">${x.count}件</span>` : x.mark === "none" ? `<span class="n none${D.dueBy && d.date > D.dueBy ? " later" : ""}">未登録</span>`
        : x.mark === "leave" ? `<span class="n leave">休暇</span>` : x.mark === "error" ? `<span class="n error">？</span>` : "";
      const nb = x.nippo.state === "submitted" ? `<span class="nb">日報 提出</span>` : x.nippo.state === "missing" ? `<span class="nb miss">日報 未提出</span>` : "";
      const aria = `${mdw(d.date)} ${x.mark === "has" ? `予定 ${x.count}件` : x.markLabel}・日報 ${x.nippo.label}`;
      return `<button type="button" class="ks-md${d.holiday || d.dow === 0 ? " hol" : ""}${d.isToday ? " td" : ""}${x.target ? "" : " off"}" data-date="${d.date}" aria-label="${esc(aria)}"
        onclick="KeieiSchedule.openDay('${esc(p.employeeId)}','${d.date}')"><span class="d">${Number(d.date.slice(8, 10))}</span>${n}${nb}</button>`;
    }).join("");
    return `${memberHead(p)}<div class="ks-panel" data-role="member-month" style="padding:10px">
      <div class="ks-mon">${["月", "火", "水", "木", "金", "土", "日"].map((w) => `<div class="dw">${w}</div>`).join("")}${"<div></div>".repeat(pad)}${cells}</div>
      <p class="ks-why" style="margin-top:8px">日付を押すと、その日の予定一覧が開きます。</p></div>`;
  }

  // ---- 描画 ----------------------------------------------------------------------
  function content() {
    if (failed) return `<div class="kei-banner err" data-role="error">${esc(failed.hint || failed.detail || failed.message || "読み込めませんでした")}</div>`;
    if (loading || !D || D.key !== keyOf()) return `<div class="kei-empty">読み込み中…</div>`;
    if (S.scope === "all") {
      if (!D.people.length && !S.q) return `<div class="kei-none" data-role="empty">対象のメンバーがいません（在籍・退職予定で、ログインできる人が対象です）。</div>`;
      return S.period === "week" ? allWeek() : allDay();
    }
    const p = personOf(S.emp);
    if (!p) return `<div class="kei-none" data-role="empty">メンバーを選んでください。</div>`;
    return S.period === "month" ? memberMonth(p) : S.period === "week" ? memberWeek(p) : memberDay(p);
  }
  function render() {
    if (!main) return;
    const unread = D && D.key === keyOf() && D.unreadable?.length
      ? `<div class="kei-banner warn" data-role="unreadable">一部を読み込めませんでした：${esc(D.unreadable.join("・"))}。その欄は「取得できません」と出しています（未提出・未登録という意味ではありません）。</div>` : "";
    // 検索欄に入力中は描き直すとカーソルが飛ぶので、入力欄の位置を覚えて戻す
    const focusQ = document.activeElement?.id === "ks-q" ? document.activeElement.selectionStart : null;
    main.innerHTML = `<div class="ks-nav"><a href="#members">← メンバー実行状況</a></div>
      <h1 class="kei-title">予定・日報確認</h1>
      <p class="kei-sub">日報の提出と、カレンダーの業務予定（私用・休暇・予約は除く）を見ます。予定の中身の変更は本人がカレンダーで行います。</p>
      ${toolbar()}${unread}<div data-role="content">${content()}</div>`;
    if (focusQ != null) { const q = document.getElementById("ks-q"); if (q) { q.focus(); q.setSelectionRange(focusQ, focusQ); } }
  }

  // ---- ドロワー（右から。スマホは全画面） ------------------------------------------
  function drawer(html, label) {
    let root = document.getElementById("ks-drawer");
    if (!root) {
      root = document.createElement("div");
      root.id = "ks-drawer";
      root.innerHTML = `<div class="ks-dr-bg" onclick="KeieiSchedule.close()"></div><aside class="ks-dr" role="dialog" aria-modal="true"></aside>`;
      document.body.appendChild(root);
    }
    const aside = root.querySelector(".ks-dr");
    aside.setAttribute("aria-label", label);
    aside.innerHTML = `<div class="ks-dr-in">${html}</div>`;
    aside.scrollTop = 0;
    aside.querySelector(".x")?.focus();
  }
  const closeBtn = `<button type="button" class="kei-btn sec x" onclick="KeieiSchedule.close()" aria-label="閉じる">閉じる</button>`;
  const nippoLine = (p, d, label) => {
    const x = p.days[d];
    if (!x) return "";
    return `<p>${esc(label)}：${pill(x.nippo.state, x.nippo.state === "off" && x.reason ? `対象外（${x.reason}）` : x.nippo.label)}${x.nippo.submittedAt ? `<span class="ks-why">　${esc(stamp(x.nippo.submittedAt))} 提出</span>` : ""}</p>`;
  };
  // 予定を入れた日（その日より前の、いちばん近い営業日）の日報。読んである範囲にあるときだけ
  function planDay(p, date) {
    return Object.keys(p.days).filter((d) => d < date && p.days[d].bizDay).sort().pop() || null;
  }
  function relatedNippo(p, date) {
    const plan = date === D.nextBizDay ? D.date : planDay(p, date);
    return `<div class="ks-panel" data-sec="nippo"><h3>関連する日報</h3>
      ${nippoLine(p, date, `${mdw(date)} の日報`)}
      ${plan && plan !== date && p.days[plan] ? nippoLine(p, plan, `予定を入れた日（${mdw(plan)}）の日報`) : ""}
      <div class="ks-links"><a class="kei-btn sec" href="/admin-nippo.html">日報・勤怠で見る →</a></div></div>`;
  }

  function openDay(id, date) {
    const p = personOf(id);
    if (!p || !p.days[date]) return;
    const x = p.days[date], evs = eventsOf(id, date);
    drawer(`<div class="ks-dr-h"><h2>${esc(p.name)}・${esc(mdw(date))}</h2>${closeBtn}</div>
      <div class="ks-scope" data-role="scope">対象：この日の予定全体（${x.count == null ? "件数不明" : `${x.count}件`}）</div>
      <div class="ks-panel" data-sec="events"><h3>予定 ${x.mark === "has" ? pill("has", `${x.count}件`) : pill(x.mark, x.mark === "off" && x.reason ? `対象外（${x.reason}）` : x.markLabel)}</h3>
        ${x.mark === "error" ? `<p class="ks-why">予定を読み込めませんでした（予定が無いという意味ではありません）。</p>` : ""}
        ${evs.map((e) => eventBtn(e, date, "day")).join("") || (x.mark === "error" ? "" : `<p class="ks-why">業務予定はありません。</p>`)}</div>
      ${x.check ? `<div class="ks-panel" data-sec="check"><h3>時間割チェック <span class="ks-why">自動計算・AIは使っていません</span></h3>
        <p>合計 ${esc(mins(x.check.totalMinutes))}・重なり ${x.check.overlaps}件</p>${x.check.notes.length ? `<ul>${x.check.notes.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : `<p class="ks-why">指摘はありません。</p>`}</div>` : ""}
      ${relatedNippo(p, date)}
      ${S.scope === "all" ? `<div class="ks-links"><button type="button" class="kei-btn sec" onclick="KeieiSchedule.showMember('${esc(id)}','${date}')">この人の予定を見る →</button></div>` : ""}
      <!-- Phase 2：経営確認（この日全体）［問題なし］［修正依頼］［コメント］の置き場所。未実装のため、押せないボタンは出さない -->
      <div data-slot="review-actions" hidden></div>`, `${p.name} ${mdw(date)} の予定`);
  }

  function openEvent(evId, date, from) {
    const e = (D?.events || []).find((x) => x.id === evId);
    if (!e) return;
    const p = personOf(e.employeeId);
    if (!p) return;
    // 前後の空き（その日の、時刻のある業務予定で）
    const s = Date.parse(e.startsAt), t = Date.parse(e.endsAt);
    const same = eventsOf(e.employeeId, date).filter((x) => !x.allDay && x.id !== e.id);
    let gaps = "";
    if (e.allDay) gaps = `<p class="ks-why">終日の予定です。</p>`;
    else {
      const overlap = same.filter((x) => Date.parse(x.startsAt) < t && Date.parse(x.endsAt) > s);
      const before = same.filter((x) => Date.parse(x.endsAt) <= s).sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt))[0];
      const after = same.filter((x) => Date.parse(x.startsAt) >= t).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
      const dayStart = jstMs(date);
      gaps = `${overlap.length ? `<p class="ks-bad">時間が重なっている予定：${overlap.map((x) => `${esc(x.title)}（${esc(timeRange(x, date))}）`).join("、")}</p>` : ""}
        <p>前：${before ? `${esc(before.title)}（〜${esc(tOf(before.endsAt))}）から <b>${esc(mins(Math.round((s - Date.parse(before.endsAt)) / 60000)))}</b> 空き` : s > dayStart ? "この日の最初の予定です" : "—"}</p>
        <p>後：${after ? `${esc(after.title)}（${esc(tOf(after.startsAt))}〜）まで <b>${esc(mins(Math.round((Date.parse(after.startsAt) - t) / 60000)))}</b> 空き` : "この日の最後の予定です"}</p>`;
    }
    const back = from === "day" ? `<button type="button" class="ks-back" data-role="back" onclick="KeieiSchedule.openDay('${esc(e.employeeId)}','${date}')">← ${esc(mdw(date))} の予定一覧へ</button>` : "";
    drawer(`${back}<div class="ks-dr-h"><h2>${esc(e.title)}</h2>${closeBtn}</div>
      <div class="ks-scope" data-role="scope">対象：この予定1件</div>
      <div class="ks-panel" data-sec="detail"><dl class="ks-dl">
        <dt>日時</dt><dd>${esc(mdw(date))} ${esc(timeRange(e, date))}${dOf(e.startsAt) !== dOf(e.endsAt) && !e.allDay ? `<span class="ks-why">（${esc(stamp(e.startsAt))}〜${esc(stamp(e.endsAt))}）</span>` : ""}</dd>
        <dt>担当</dt><dd>${esc(p.name)}</dd>
        <dt>区分</dt><dd>${esc(CATEGORY[e.category] || e.category || "—")}</dd>
        <dt>場所</dt><dd>${esc(e.location || "—")}</dd>
        <dt>最終更新</dt><dd>${esc(stamp(e.updatedAt))}</dd></dl>
        <p class="ks-why">予定のメモは本人だけが見られるため、ここには出しません。</p></div>
      <div class="ks-panel" data-sec="gaps"><h3>前後の空き時間</h3>${gaps}</div>
      ${relatedNippo(p, date)}
      <!-- Phase 2：経営確認（この予定1件）［問題なし］［修正依頼］［コメント］の置き場所。未実装のため、押せないボタンは出さない -->
      <div data-slot="review-actions" hidden></div>`, `予定 ${e.title}`);
  }

  function close() { document.getElementById("ks-drawer")?.remove(); }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  // ---- 操作 ----------------------------------------------------------------------
  function set(group, val) {
    if (group === "scope") {
      if (S.scope === val) return;
      S.scope = val; S.tile = null;
      if (val === "member" && !S.emp) S.emp = D?.people?.[0]?.employeeId || roster[0]?.employeeId || null;
      if (val === "all" && S.period === "month") S.period = "week";
    } else if (group === "period") {
      if (S.period === val || (val === "month" && S.scope === "all")) return;
      S.period = val;
    }
    close(); load();
  }
  function move(n) {
    S.date = S.period === "month" ? addMonths(S.date, n) : addDays(S.date, S.period === "week" ? 7 * n : n);
    close(); load();
  }

  window.KeieiSchedule = {
    async open(el, isStale) {
      style(); main = el;
      if (!S.date) S.date = todayJst();
      await load(isStale);
    },
    set, move,
    toToday() { S.date = todayJst(); close(); load(); },
    setDate(v) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ""))) return; S.date = v; close(); load(); },
    pick(id) { S.emp = id; close(); load(); },
    search(v) { S.q = String(v || "").trim(); render(); },
    tile(key) { S.tile = key && S.tile !== key ? key : null; render(); },
    showMember(id, date) { S.scope = "member"; S.emp = id; S.period = "day"; S.date = date; S.tile = null; close(); load(); },
    openDay, openEvent, close,
  };
})();
