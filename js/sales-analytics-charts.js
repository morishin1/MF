// 分析画面の軽いグラフ（外部ライブラリなし・インラインSVG）。表示だけで、保存・送信はしない。
//
// ■ 数字は必ず文字でも出す
//   棒や円は「どこが多い／少ないか」を一目で見るためのもの。正確な件数は横に文字で出し、
//   画面読み上げでも同じ内容が分かるようにする（グラフだけに情報を持たせない）。
// ■ 押せる棒・凡例は <button data-chart-key="…">
//   押したときの動き（根拠の表へ絞り込む・内訳を開く）は呼び出し側が決める。
(function () {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const num = (n) => (Number.isFinite(n) ? n.toLocaleString("ja-JP") : "—");
  const PALETTE = ["#a3adbf", "#7d97c7", "#4f6fa8", "#2f4b7c", "#2e7d57", "#c39735"];

  /**
   * 横棒グラフ。
   * @param {{key:string,label:string,value:number,unit?:string,sub?:string,tone?:"warn"|"muted"}[]} rows
   * @param {{title?:string, caption?:string, max?:number, clickable?:boolean, id?:string, actionLabel?:string}} [opts]
   *   sub は呼び出し側で組み立てた HTML（esc 済みであること）
   */
  function bars(rows, opts = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const top = Number.isFinite(opts.max) ? opts.max : Math.max(0, ...list.map((r) => Number(r.value) || 0));
    const max = Math.max(1, top);
    const tag = opts.clickable ? "button" : "div";
    const action = opts.actionLabel || "根拠を見る";
    const summary = list.map((r) => `${r.label} ${num(r.value)}${r.unit || ""}`).join("、");
    return `<figure class="sc-chart"${opts.id ? ` id="${esc(opts.id)}"` : ""}>
      ${opts.title ? `<figcaption class="sc-title">${esc(opts.title)}</figcaption>` : ""}
      <div class="sc-rows" role="group" aria-label="${esc(opts.title || "グラフ")}：${esc(summary)}">${list.map((r) => {
        const v = Math.max(0, Number(r.value) || 0);
        // 0より大きいのに細すぎて見えない棒は、最低1%で描く（0件は描かない）
        const w = v ? Math.max(1, Math.round((v / max) * 1000) / 10) : 0;
        const attrs = opts.clickable
          ? ` type="button" data-chart-key="${esc(r.key)}" aria-label="${esc(r.label)} ${esc(num(v))}${esc(r.unit || "")}。${esc(action)}"`
          : "";
        return `<${tag} class="sc-row${r.tone ? ` sc-${esc(r.tone)}` : ""}"${attrs}>
          <span class="sc-label">${esc(r.label)}</span>
          <svg class="sc-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="sc-track" x="0" y="0" width="100" height="10" rx="2"></rect>${w ? `<rect class="sc-fill" x="0" y="0" width="${w}" height="10" rx="2"></rect>` : ""}</svg>
          <span class="sc-val">${esc(num(v))}<small>${esc(r.unit || "")}</small></span>
          ${r.sub ? `<span class="sc-sub">${r.sub}</span>` : ""}
        </${tag}>`;
      }).join("")}</div>
      ${opts.caption ? `<p class="sc-caption">${esc(opts.caption)}</p>` : ""}
    </figure>`;
  }

  /**
   * ドーナツ（内訳）。合計0なら描かずに説明だけ返す。
   * @param {{key:string,label:string,value:number,color?:string}[]} segs
   * @param {{title?:string, unit?:string, centerLabel?:string, caption?:string, clickable?:boolean, id?:string, empty?:string}} [opts]
   */
  function donut(segs, opts = {}) {
    const list = (Array.isArray(segs) ? segs : []).map((s, i) => ({ ...s, value: Math.max(0, Number(s.value) || 0), color: s.color || PALETTE[i % PALETTE.length] }));
    const total = list.reduce((s, x) => s + x.value, 0);
    const unit = opts.unit || "";
    const pct = (v) => (total ? `${Math.round((v / total) * 1000) / 10}%` : "—");
    if (!total) {
      return `<figure class="sc-chart sc-donut"${opts.id ? ` id="${esc(opts.id)}"` : ""}>${opts.title ? `<figcaption class="sc-title">${esc(opts.title)}</figcaption>` : ""}
        <p class="sc-caption">${esc(opts.empty || "表示できる件数がありません。")}</p></figure>`;
    }
    // 円周100の円（r=15.915）。12時の位置から時計回りに積む
    let start = 0;
    const arcs = list.filter((s) => s.value).map((s) => {
      const dash = (s.value / total) * 100;
      const arc = `<circle class="sc-arc" cx="21" cy="21" r="15.915" fill="none" stroke="${esc(s.color)}" stroke-width="7"
        stroke-dasharray="${dash.toFixed(3)} ${(100 - dash).toFixed(3)}" stroke-dashoffset="${(25 - start).toFixed(3)}"${opts.clickable ? ` data-chart-key="${esc(s.key)}"` : ""}></circle>`;
      start += dash;
      return arc;
    }).join("");
    const label = `${opts.title || "内訳"}：` + list.map((s) => `${s.label} ${num(s.value)}${unit}（${pct(s.value)}）`).join("、");
    const tag = opts.clickable ? "button" : "div";
    return `<figure class="sc-chart sc-donut"${opts.id ? ` id="${esc(opts.id)}"` : ""}>
      ${opts.title ? `<figcaption class="sc-title">${esc(opts.title)}</figcaption>` : ""}
      <div class="sc-donut-body">
        <svg class="sc-ring" viewBox="0 0 42 42" role="img" aria-label="${esc(label)}">
          <circle cx="21" cy="21" r="15.915" fill="none" stroke="#edf0f5" stroke-width="7"></circle>${arcs}
          <text x="21" y="20.5" text-anchor="middle" class="sc-ring-n">${esc(num(total))}</text>
          <text x="21" y="26" text-anchor="middle" class="sc-ring-u">${esc(opts.centerLabel || unit)}</text>
        </svg>
        <div class="sc-legend">${list.map((s) => `<${tag} class="sc-leg"${opts.clickable ? ` type="button" data-chart-key="${esc(s.key)}" aria-label="${esc(s.label)} ${esc(num(s.value))}${esc(unit)}（${esc(pct(s.value))}）。対象を見る"` : ""}>
          <i style="background:${esc(s.color)}" aria-hidden="true"></i><span class="sc-leg-l">${esc(s.label)}</span>
          <b>${esc(num(s.value))}${esc(unit)}</b><small>${esc(pct(s.value))}</small></${tag}>`).join("")}</div>
      </div>
      ${opts.caption ? `<p class="sc-caption">${esc(opts.caption)}</p>` : ""}
    </figure>`;
  }

  /** 読込中・取得失敗・未設定・0件 を同じ形で出す（グラフの場所を空白にしない） */
  function state(kind, text, { retry = false, retryAttr = "data-chart-retry" } = {}) {
    const role = kind === "error" ? "alert" : "status";
    return `<div class="sc-state sc-state-${esc(kind)}" data-state="${esc(kind)}" role="${role}"${kind === "loading" ? ' aria-busy="true"' : ""}>
      <span>${esc(text)}</span>${retry ? ` <button type="button" class="sc-retry" ${retryAttr}>再試行</button>` : ""}</div>`;
  }

  window.SalesCharts = { bars, donut, state, esc, num, PALETTE };
})();
