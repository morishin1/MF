// 退職証明書の発行を本人が申請する欄（退職者ポータル /retiree/ と、退職手続き中のマイページで共通）。
//
//   ・記載してほしい項目を選ぶ（労働基準法22条：選んだ項目だけが証明書に載る）
//   ・申請ボタンの直前に、NDA等の誓約のチェック（必須。チェックしないと押せない）
//   ・「発行を申請する」→ 人事へ。申請中・発行済み・差し戻しを、その場で出す
// 使い方：CertRequest.mount(箱, { state: {options, request}, submit: (body) => Promise<{request}> })
//   state は GET の certRequest（退職者ポータル）／ GET /api/employees/cert-request（マイページ）。
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const at = (iso) => {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const j = new Date(t + 9 * 3600000), p = (n) => String(n).padStart(2, "0");
    return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
  };
  const CSS = `
    .cq { background:#fff; border:1px solid #e2e2dc; border-radius:12px; padding:16px; color:#1b2440; }
    .card .cq { border:0; padding:0; }
    .cq h3 { font-size:15px; margin:0 0 4px; }
    .cq .lead { font-size:12.5px; color:#6b7080; line-height:1.8; margin:0 0 12px; }
    .cq .items { display:flex; flex-direction:column; gap:6px; margin:0 0 14px; }
    .cq label.it { display:flex; align-items:center; gap:10px; border:1px solid #e2e2dc; border-radius:9px; padding:10px 12px; font-size:14px; cursor:pointer; }
    .cq label.it input, .cq label.nda input { width:18px; height:18px; margin:0; flex:0 0 auto; }
    .cq label.nda { display:flex; align-items:flex-start; gap:10px; background:#fffaf0; border:1px solid #f0d9b5; border-radius:9px; padding:12px; font-size:13.5px; line-height:1.7; cursor:pointer; }
    .cq label.nda input { margin-top:3px; }
    .cq .req { color:#b3261e; font-size:11.5px; font-weight:700; margin-left:4px; white-space:nowrap; }
    .cq .go { margin-top:14px; width:100%; border:0; border-radius:9px; padding:12px; font:inherit; font-size:14.5px; font-weight:700; background:#1b2440; color:#fff; cursor:pointer; }
    .cq .go[disabled] { opacity:.45; cursor:not-allowed; }
    .cq .st { border-radius:9px; padding:12px; font-size:13.5px; line-height:1.8; }
    .cq .st.wait { background:#e8effd; color:#2c4f9e; }
    .cq .st.done { background:#e3f4e7; color:#1f6f3a; }
    .cq .st.back { background:#fff3e0; color:#9c4221; margin-bottom:12px; }
    .cq .st ul { margin:4px 0 0; padding-left:18px; }
    .cq .msg { font-size:12.5px; color:#b3261e; margin-top:8px; }
    .cq .again { background:none; border:0; color:#2c4f9e; text-decoration:underline; font:inherit; font-size:12.5px; cursor:pointer; padding:0; margin-top:8px; }`;
  function style() {
    if (document.getElementById("cq-style")) return;
    const s = document.createElement("style"); s.id = "cq-style"; s.textContent = CSS; document.head.appendChild(s);
  }

  function mount(box, { state, submit }) {
    style();
    let st = state, again = false;
    const form = () => `
      <div class="items" role="group" aria-label="証明書に記載してほしい項目">
        ${st.options.items.map((i) => `<label class="it"><input type="checkbox" name="cq-item" value="${esc(i.key)}">${esc(i.label)}</label>`).join("")}
      </div>
      <label class="nda"><input type="checkbox" id="cq-nda"><span>${esc(st.options.ndaText)}<span class="req">（必須）</span></span></label>
      <button type="button" class="go" id="cq-go" disabled>発行を申請する</button>
      <div class="msg" id="cq-msg" role="alert"></div>`;
    function render() {
      const r = st.request;
      let body;
      if (r && r.status === "requested") {
        body = `<div class="st wait" data-cq="requested"><b>申請しました（${esc(at(r.requestedAt))}）</b>。人事が内容を確認しています。発行されると、書類の一覧からダウンロードできます。
          <ul>${r.items.map((i) => `<li>${esc(i.label)}</li>`).join("")}</ul>
          <div style="font-size:12px;margin-top:4px;">誓約：${esc(at(r.nda.agreedAt))} 誓約済</div></div>`;
      } else if (r && r.status === "issued" && !again) {
        body = `<div class="st done" data-cq="issued"><b>発行しました（${esc(at(r.decidedAt))}）</b>。書類の一覧の「退職証明書」から見る・ダウンロードできます。</div>
          <button type="button" class="again" id="cq-again">別の項目で、もう一度申請する</button>`;
      } else {
        body = `${r && r.status === "cancelled" ? `<div class="st back" data-cq="cancelled">前の申請は差し戻されました。内容を見直して、もう一度申請してください。</div>` : ""}${form()}`;
      }
      box.innerHTML = `<section class="cq" data-cq-box>
        <h3>退職証明書の発行を申請する</h3>
        <p class="lead">証明書に記載してほしい項目だけを選んでください。選んだ項目だけが記載されます（選ばなかった項目は記載しません）。</p>
        ${body}</section>`;
      const go = box.querySelector("#cq-go");
      if (go) {
        const sync = () => {
          const n = box.querySelectorAll('input[name="cq-item"]:checked').length;
          go.disabled = !(n > 0 && box.querySelector("#cq-nda").checked);
        };
        box.querySelectorAll('input[name="cq-item"], #cq-nda').forEach((i) => i.addEventListener("change", sync));
        go.addEventListener("click", async () => {
          const items = [...box.querySelectorAll('input[name="cq-item"]:checked')].map((i) => i.value);
          const ndaAgreed = box.querySelector("#cq-nda").checked;
          if (!items.length || !ndaAgreed) return;
          go.disabled = true; go.textContent = "申請しています…";
          try {
            const res = await submit({ items, ndaAgreed });
            st = { ...st, request: res.request }; again = false; render();
          } catch (e) {
            go.textContent = "発行を申請する"; sync();
            box.querySelector("#cq-msg").textContent = e.hint || e.message || "申請できませんでした";
          }
        });
      }
      box.querySelector("#cq-again")?.addEventListener("click", () => { again = true; render(); });
    }
    render();
  }
  window.CertRequest = { mount };
})();
