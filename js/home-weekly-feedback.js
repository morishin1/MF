// 本人ホーム：経営者が公開した週次結果のみ。公開前・他人のデータは出さない。
(() => {
  "use strict";
  const esc = (s) => KPLayout.esc(String(s ?? ""));
  let entries = [], selected = 0;
  const el = () => document.getElementById("home-weekly-feedback");
  function installStyles() {
    if (document.getElementById("home-weekly-feedback-style")) return;
    const style = document.createElement("style");
    style.id = "home-weekly-feedback-style";
    style.textContent = `
      #home-weekly-feedback[hidden] { display:none!important; }
      #home-weekly-feedback { margin:14px 0 18px; padding:17px 18px; background:#fff; border:1px solid #dce5ed; border-radius:13px; }
      .hw-head { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
      .hw-head h2 { margin:0; font-size:17px; color:#1d3152; }
      .hw-head small { display:block; margin-top:3px; color:#69798a; }
      .hw-head select { padding:8px 10px; border:1px solid #d3dce5; border-radius:8px; background:#fff; max-width:100%; }
      .hw-conclusion { padding:11px 13px; background:#f4f7fb; border-radius:8px; line-height:1.65; font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere; }
      .hw-columns { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:11px 0; }
      .hw-col { border:1px solid #e2e6ec; border-radius:9px; padding:12px; min-width:0; }
      .hw-col h3 { margin:0 0 7px; font-size:13px; color:#1d3152; }
      .hw-col p { margin:0; font-size:13px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }
      .hw-details summary { cursor:pointer; font-size:12px; font-weight:700; color:#416099; }
      .hw-details div { font-size:12px; white-space:pre-wrap; line-height:1.7; padding:9px; }
      .hw-foot { margin:9px 0 0; color:#6e7480; font-size:11.5px; }
      @media(max-width:750px){.hw-columns {grid-template-columns:1fr;}}
    `;
    document.head.appendChild(style);
  }
  function show() {
    const box = el();
    if (!box || !entries.length) return;
    const f = entries[selected] || entries[0];
    const section = (head, value) => '<section class="hw-col"><h3>' + esc(head) + '</h3><p>' + esc(value || "記録なし") + "</p></section>";
    box.innerHTML = `
      <div class="hw-head"><div><h2>今週の振り返り・次に改善すること</h2>
        <small>経営者が確認して公開した内容です。本人の成長と次週の行動に活用してください。</small></div>
        <select aria-label="過去の週次振り返りを選択" id="hw-week">
          ${entries.map((x, i) => '<option value="' + i + '"' + (i === selected ? ' selected' : '') + ">"
            + esc(x.periodStart + "〜" + x.periodEnd) + "</option>").join("")}
        </select>
      </div>
      <div class="hw-conclusion">${esc(f.conclusion || "今回の振り返りを確認してください。")}</div>
      <div class="hw-columns">
        ${section("良かった点", f.goodPoints)}
        ${section("改善点", f.improvementPoints)}
        ${section("次週の行動", f.nextActions)}
      </div>
      ${(f.reason || f.evidence || f.recommendation) ? `<details class="hw-details"><summary>根拠と経営者のコメントを見る</summary>
        ${f.reason ? '<div><b>理由</b>\n' + esc(f.reason) + '</div>' : ""}
        ${f.evidence ? '<div><b>日報の根拠</b>\n' + esc(f.evidence) + '</div>' : ""}
        ${f.recommendation ? '<div><b>改善の提案</b>\n' + esc(f.recommendation) + '</div>' : ""}</details>` : ""}
      <p class="hw-foot">これは人事の確定評価点ではなく、日報を基にした改善のフィードバックです。不明な点は管理者に確認してください。</p>
    `;
    box.hidden = false;
    box.querySelector("#hw-week")?.addEventListener("change", (event) => {
      const n = Number(event.target.value);
      if (!Number.isInteger(n) || n < 0 || n >= entries.length) return;
      selected = n; show();
    });
  }
  async function load() {
    const box = el();
    if (!box) return;
    try {
      const r = await API.api("/api/nippo/feedback");
      entries = Array.isArray(r.history) ? r.history : [];
      selected = 0;
      if (!entries.length) { box.hidden = true; return; }
      installStyles(); show();
    } catch (e) {
      // 他人のフィードバックやエラー本文は露出させず、ページ全体はそのまま利用させる。
      box.hidden = true;
      console.warn("[home-weekly-feedback] unavailable:", e?.status || "error");
    }
  }
  window.HomeWeeklyFeedback = { load };
})();
