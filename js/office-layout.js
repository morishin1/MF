// Office の /office/ 配下の画面（ホーム・月次業務・請求・支払・勤務表・契約条件）の共通部品。
//
// ■ 見た目の枠（ヘッダー・左メニュー）は、Office の他の画面（人事・労務／経理・事務／社内管理）と同じ
//   2026-10-03 の Office UI/UX 再設計で、月次業務の専用ヘッダーと「GWへ戻る」を廃止した。
//   枠は js/layout.js（KPLayout）の Office 共通の左メニュー・ヘッダーで描く。ここに枠を持たない。
//   ここに残すのは、/office/ の画面どうしで共通の中身の見た目（一覧・ドロワー・状態のラベル）と道具だけ。
//
// ■ 権限
//   月末月初業務の画面（月次業務・請求・支払・勤務表・契約条件）を開けるのは、経営者・責任者・経理だけ
//   （サーバの canAccessOffice、DB の gw_is_office と同じ）。入口は /api/me の access.office だけで決める
//   （KPLayout.init の access: "office"）。Office ホーム（/office/）だけは、Office に入れる人の全員
//   （officeHr・officeFinance・office のどれか）が開け、中身を担当の分だけ出す（opts.access で渡す）。
//   画面側で役割名を並べ直さない（メニューに出たのに API が 403、を作らない。test/accessparity.mjs が見張る）。
//   古い応答（access が無い）のときは、入れない側に倒す。
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 各画面の鍵 → Office の左メニューの鍵（js/layout.js の OFFICE_GROUPS「月末月初業務」の match）
  const ACTIVE = { home: "office_home", monthly: "office_monthly", billing: "office_billing", timesheet: "office_timesheet", terms: "office_terms" };

  function css() {
    if (document.getElementById("office-layout-css")) return;
    const style = document.createElement("style");
    style.id = "office-layout-css";
    style.textContent = `
      /* アイコンは幅を 1em に固定する。フォントの読込前・読込に失敗したときに、
         アイコン名（chevron_right など）の文字がそのまま幅をとって、横にはみ出さないように */
      body.of-app .material-symbols-outlined { display:inline-block; width:1em; overflow:hidden;
        white-space:nowrap; line-height:1; flex:none; }

      /* Office 共通の枠の中で、上の余白を詰める（いちばん先に押すものを、上に） */
      body.of-app .wrap { padding-top:18px; }
      body.of-app .of-head .kp-subnav { margin:8px 0 10px; }

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
      a.of-btn { text-decoration:none; }
      .of-btn .material-symbols-outlined { font-size:16px; }
      .of-btn:disabled { opacity:.55; cursor:default; }
      .of-btn:focus-visible, button:focus-visible {
        outline:2px solid #1b2440; outline-offset:2px; }

      /* 月次進捗（Office ホーム・月次業務で共通）。全体の割合＋工程ごとの 済 / 対象 */
      .of-prog { display:grid; gap:9px; }
      .of-prog .all { display:flex; align-items:baseline; gap:8px; font-size:12.5px; color:#4a5068; font-weight:700; }
      .of-prog .all b { font-size:22px; font-weight:900; color:#1b2440; font-variant-numeric:tabular-nums; }
      .of-prog .row { display:grid; grid-template-columns:120px 1fr 64px; align-items:center; gap:10px; font-size:12.5px; color:#1b2440; }
      .of-prog .bar { height:8px; background:#efefeb; border-radius:99px; overflow:hidden; }
      .of-prog .bar i { display:block; height:100%; background:#1b2440; border-radius:99px; }
      .of-prog .num { text-align:right; font-variant-numeric:tabular-nums; font-weight:700; }
      .of-prog .num.ok::before { content:"✓ "; color:#2f6f3a; }
      @media (max-width: 560px) { .of-prog .row { grid-template-columns:96px 1fr 56px; } }

      /* 月の切り替え（月次業務・請求・支払で共通） */
      .of-head { display:flex; align-items:flex-end; justify-content:space-between; gap:12px 16px; flex-wrap:wrap; margin-bottom:14px; }
      .of-head .of-sub { margin:0; }
      .of-month { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      .of-month input[type="month"] { margin:0; width:auto; font-family:inherit; font-size:14px; font-weight:700; }

      .of-drawer-bg { position:fixed; inset:0; background:rgba(27,36,64,.35); z-index:40; }
      .of-drawer { position:fixed; top:0; right:0; bottom:0; width:560px; max-width:100vw; background:#f6f6f2;
                   z-index:41; box-shadow:-8px 0 24px rgba(27,36,64,.15); overflow-y:auto; }

    `;
    document.head.appendChild(style);
  }

  // 入口は、Office の左メニュー・ヘッダーの近道と同じ値（/api/me の access = サーバの canAccessOffice）だけで決める。
  // 役割名は画面側で持たない。access が無い（古い応答）ときは入れない。API.warm にも渡す
  function allows(me) { return Boolean(me?.access?.office); }

  // 枠（ヘッダー・Office の左メニュー）は KPLayout が描く。入れない人は KPLayout がホームへ送り返す（null）
  async function init(opts = {}) {
    css();
    // 未ログインはログイン画面へ（/office/ の画面は、これまでどおり index.html から入り直す）
    if (!window.API || !window.KPLayout || !API.isLoggedIn()) { location.href = "/index.html"; return null; }
    const got = await KPLayout.init({ active: ACTIVE[opts.active] || ACTIVE.monthly, access: opts.access || "office" });
    if (!got) return null;
    document.body.classList.add("of-app");
    for (const w of document.querySelectorAll(".wrap")) w.classList.add("of-wrap");
    return { me: got.me };
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

  /**
   * 月次進捗の行。/api/office の summary.progress（勤務表回収・稼働確認・売上請求・仕入請求・月次完了）に、
   * 支払（支払を管理している行のうち、支払済み）を月次完了の前に足す。数え方はサーバの印のまま（画面で判定を増やさない）
   */
  function progressOf(data) {
    const list = ((data && data.summary && data.summary.progress) || []).map((p) => ({ ...p }));
    const payRows = ((data && data.rows) || []).filter((r) => r.cols && r.cols.payment
      && !["not_applicable", "unmanaged"].includes(r.cols.payment.state));
    if (payRows.length) {
      const at = list.findIndex((p) => p.key === "done");
      const pay = { key: "payment", label: "支払", done: payRows.filter((r) => r.cols.payment.state === "paid").length, of: payRows.length };
      list.splice(at < 0 ? list.length : at, 0, pay);
    }
    return list;
  }
  function progressHtml(list) {
    const sum = list.reduce((a, p) => [a[0] + p.done, a[1] + p.of], [0, 0]);
    const pct = (d, o) => (o ? Math.round((d / o) * 100) : 0);
    const all = sum[1] ? `<div class="all">全体 <b>${pct(sum[0], sum[1])}%</b></div>` : "";
    return all + list.map((p) => `<div class="row"><span>${esc(p.label)}</span>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${p.of}" aria-valuenow="${p.done}" aria-label="${esc(p.label)}"><i style="width:${pct(p.done, p.of)}%"></i></div>
        <span class="num${p.of && p.done >= p.of ? " ok" : ""}">${p.done} / ${p.of}</span></div>`).join("");
  }

  /**
   * 契約期限の確認が要る行：契約期間の終わり（periodTo）が today から30日以内（過ぎたものも含む）で、
   * 更新の確認がまだ（renewalStatus が未確認）。/api/office の行の値だけで決める
   */
  function expiring(r, today) {
    if (!r || !r.periodTo || !today) return false;
    if (r.renewalStatus && r.renewalStatus !== "pending") return false;
    const t = new Date(`${today}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 30);
    return r.periodTo <= t.toISOString().slice(0, 10);
  }

  /** 請求・支払がまだ終わっていない行：売上請求が未送付／BP請求書が未受領／支払が済んでいない（支払を管理している行だけ） */
  const PAY_OPEN = ["waiting", "unregistered", "matching", "mismatch", "approved", "scheduled"];
  function billingOpen(r) {
    const c = (r && r.cols) || {};
    return (c.salesInvoice && c.salesInvoice.state !== "sent")
      || (c.vendorInvoice && c.vendorInvoice.state === "not_received")
      || (c.payment && PAY_OPEN.includes(c.payment.state));
  }

  window.OfficeLayout = { init, allows, esc, pill, fmt, fmtDay, progressOf, progressHtml, expiring, billingOpen, PAY_OPEN };
})();
