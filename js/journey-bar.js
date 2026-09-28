// 入社〜キャリアの共通ステータスバー（管理者・本人で同じ部品）。
//
// 中身（6段階のどこか・誰の対応か・本人向けの言い方）はサーバの lib/journey.js journeyOf が作る。
// ここは見せ方だけ。ページごとに別の実装を持たない：
//   admin-career.html（一覧・社員ドロワー）・home.html・onboarding.html・career.html が、これを読む。
//
//   KPJourney.bar(j)                          6段階のバー（✓ 完了 / ● 現在 / ○ 未着手）
//   KPJourney.panel(j, { viewer, here })      バー＋「現在 / 誰の対応か / 次にすること / CTA」
//        viewer: "member"（本人）| "admin"（管理者）
//        here:   いまのページ。本人の CTA がこのページを指すなら出さない（押しても同じ画面）
//   KPJourney.mini(j)                         一覧の1行に入る小さな版
(function () {
  const MARK = { done: "✓", now: "●", todo: "○" };
  const STATE_LABEL = { done: "完了", now: "現在", todo: "未着手" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const CSS = `
  .jb { margin:10px 0 6px; }
  .jb-steps { display:flex; list-style:none; padding:0; margin:0; overflow-x:auto; -webkit-overflow-scrolling:touch; }
  .jb-steps li { flex:1 0 auto; min-width:78px; display:flex; flex-direction:column; align-items:center; position:relative;
                 font-size:12px; color:var(--muted,#6b778c); padding:0 2px; }
  .jb-steps li::before { content:""; position:absolute; top:12px; left:-50%; width:100%; height:2px; background:#dfe4ec; z-index:0; }
  .jb-steps li:first-child::before { display:none; }
  .jb-steps li.done::before, .jb-steps li.now::before { background:#3e9c5a; }
  .jb-steps .jb-m { width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center;
                    font-weight:700; font-size:13px; background:#fff; border:2px solid #c5cfdd; color:#9aa5b5; z-index:1; }
  .jb-steps li.done .jb-m { background:#eaf5ec; border-color:#3e9c5a; color:#256b36; }
  .jb-steps li.now .jb-m { background:var(--primary,#2f6fd6); border-color:var(--primary,#2f6fd6); color:#fff; }
  .jb-steps .jb-l { margin-top:4px; white-space:nowrap; }
  .jb-steps li.now .jb-l { color:var(--primary-dark,#1b2440); font-weight:700; }
  .jb-steps li.done .jb-l { color:#256b36; }
  .jb-card { border:1px solid var(--border,#e3e8ef); border-radius:12px; padding:12px 14px; margin:10px 0 0; background:#fff; }
  .jb-card .k { font-size:11px; font-weight:700; letter-spacing:.08em; color:var(--muted,#6b778c); }
  .jb-card .now { font-size:16px; font-weight:700; color:var(--primary-dark,#1b2440); margin:1px 0 6px; }
  .jb-who { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:700; padding:3px 10px; border-radius:999px; }
  .jb-who.self { background:#fff4e0; color:#8a5a00; }
  .jb-who.company, .jb-who.advisor { background:#e8f0fc; color:#1f4f9a; }
  .jb-who.done { background:#eaf5ec; color:#256b36; }
  .jb-card .next { font-size:13.5px; margin:4px 0 10px; line-height:1.7; }
  .jb-done { font-size:12px; color:var(--muted,#6b778c); margin-top:6px; }
  .jb-mini { display:inline-flex; gap:3px; vertical-align:middle; }
  .jb-mini i { width:8px; height:8px; border-radius:50%; background:#dfe4ec; display:inline-block; }
  .jb-mini i.done { background:#3e9c5a; }
  .jb-mini i.now { background:var(--primary,#2f6fd6); box-shadow:0 0 0 2px #cfe0f7; }
  @media (max-width: 560px) {
    .jb-steps li { min-width:68px; font-size:11.5px; }
  }`;
  function ensureCss() {
    if (document.getElementById("jb-css")) return;
    const st = document.createElement("style");
    st.id = "jb-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function bar(j) {
    ensureCss();
    if (!j?.phases) return "";
    return `<div class="jb"><ol class="jb-steps" id="jr-bar" aria-label="入社〜キャリアの進み具合">${j.phases.map((p) =>
      `<li class="${esc(p.state)}" data-phase="${esc(p.key)}" aria-current="${p.state === "now" ? "step" : "false"}">
        <span class="jb-m" aria-hidden="true">${MARK[p.state] || "○"}</span>
        <span class="jb-l">${esc(p.label)}</span><span class="visually-hidden" style="position:absolute;left:-9999px;">${STATE_LABEL[p.state]}</span></li>`).join("")}</ol></div>`;
  }

  function panel(j, { viewer = "member", here = "" } = {}) {
    if (!j?.phases) return "";
    if (viewer === "admin") {
      // 管理者：バー＋いまの担当。NEXT ACTION と CTA は、画面側の既存の枠（1つだけ）に出す
      const done = j.phases.filter((p) => p.state === "done").map((p) => p.label);
      return `${bar(j)}
        <div class="jb-admin" id="jb-admin" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;">
          <span class="jb-who ${esc(j.who)}">${esc(j.whoText?.admin || "")}</span>
          ${j.actorLabel && j.who !== "done" ? `<span style="font-size:12.5px;">現在の担当：<b>${esc(j.actorLabel)}</b></span>` : ""}
        </div>
        ${done.length ? `<div class="jb-done">完了：${done.map(esc).join("・")}</div>` : ""}`;
    }
    // 本人：現在 → 誰の対応か → 次にすること → CTA（本人の操作が要るときだけ）
    const m = j.member || {};
    const cta = m.cta && !(here && m.cta.href.split("#")[0] === here && !m.cta.href.includes("#"))
      ? `<a class="btn btn-primary" id="jb-cta" href="${esc(m.cta.href)}">${esc(m.cta.label)}</a>` : "";
    return `${bar(j)}
      <div class="jb-card" id="jb-card">
        <div class="k">現在</div>
        <div class="now">${esc(m.now || "")}</div>
        <span class="jb-who ${esc(j.who)}" id="jb-who">${esc(j.whoText || "")}</span>
        <div class="k" style="margin-top:10px;">${j.who === "self" ? "次にすること" : "いまの状況"}</div>
        <p class="next">${esc(m.next || "")}</p>
        ${cta}
      </div>`;
  }

  function mini(j) {
    ensureCss();
    if (!j?.phases) return "";
    const now = j.phases.find((p) => p.state === "now");
    return `<span class="jb-mini" title="${esc(j.phases.map((p) => `${MARK[p.state]} ${p.label}`).join(" ─ "))}">${j.phases.map((p) =>
      `<i class="${esc(p.state)}"></i>`).join("")}</span> <small class="muted">${esc(now ? now.label : "完了")}</small>`;
  }

  window.KPJourney = { bar, panel, mini };
})();
