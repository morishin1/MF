// KEIEI日報まとめ：期間別PREP .md出力 → ローカルAI結果の取り込み → 経営者確認 → 本人公開。
(() => {
  "use strict";
  const FIELDS = [
    ["conclusion", "結論（Point）"],
    ["reason", "理由（Reason）"],
    ["evidence", "具体例・根拠（Example）"],
    ["recommendation", "再結論・改善提案（Point）"],
    ["good_points", "良かった点"],
    ["improvement_points", "改善点"],
    ["next_actions", "来週の行動"],
  ];
  const names = Object.fromEntries(FIELDS.map(([k, v]) => [v, k]));
  let root = null, memberId = null, dateFrom = "", dateTo = "", generation = 0, dirty = false;
  const esc = (s) => KeieiLayout.esc(String(s ?? ""));
  const q = (id) => root?.querySelector("#" + id);
  const period = () => ({ from: dateFrom, to: dateTo });
  const status = (text, error = false, id = "kw-prep-message") => {
    const x = q(id);
    if (x) { x.textContent = text; x.style.color = error ? "#a73b36" : "#286f44"; }
  };
  const title = (label, key) => '<label class="kw-prep-label">' + esc(label)
    + '<textarea maxlength="6000" data-prep-field="' + key + '" id="kw-prep-' + key
    + '" rows="' + (["good_points", "improvement_points", "next_actions"].includes(key) ? 3 : 2)
    + '" placeholder="根拠となる事実・具体的な行動を記載"></textarea></label>';

  function addStyle() {
    if (document.getElementById("kw-prep-style")) return;
    const s = document.createElement("style");
    s.id = "kw-prep-style";
    s.textContent = `
      .kw-prep-toolbar { background:#f6f8fc; border:1px solid #dfe7f1; border-radius:12px; padding:14px 16px; margin:0 0 15px; }
      .kw-prep-toolbar h2 { margin:0 0 5px; font-size:16px; }
      .kw-prep-toolbar p,.kw-prep-editor p { margin:5px 0 12px; font-size:12px; color:#627183; line-height:1.7; }
      .kw-prep-step { font-size:12.5px; color:#415579; margin:8px 0 12px; }
      .kw-prep-row { display:flex; gap:8px; align-items:end; flex-wrap:wrap; }
      .kw-prep-row label { display:flex; flex-direction:column; gap:4px; color:#596474; font-size:11.5px; }
      .kw-prep-row input,.kw-prep-row select { border:1px solid #cbd5e3; padding:8px 10px; border-radius:8px; background:white; font-size:13px; max-width:100%; }
      .kw-prep-btn { appearance:none; cursor:pointer; border:1px solid #b8c8d9; padding:9px 12px; border-radius:8px; background:#fff; color:#243c61; font-size:12.5px; font-weight:700; }
      .kw-prep-btn.primary { background:#214d8b; color:#fff; border-color:#214d8b; }
      .kw-prep-btn:disabled { opacity:.55; cursor:default; }
      .kw-prep-editor { border-top:1px solid #dbe3ec; margin-top:20px; padding-top:16px; }
      .kw-prep-editor h3 { font-size:16px; margin:0 0 5px; }
      .kw-prep-label { display:block; margin:11px 0; font-size:12px; font-weight:700; color:#435269; }
      .kw-prep-label textarea { display:block; box-sizing:border-box; resize:vertical; width:100%; border:1px solid #cad4e2; border-radius:8px; background:#fff; margin-top:5px; padding:10px; font-size:13px; line-height:1.6; }
      .kw-prep-main { display:grid; grid-template-columns:repeat(1,minmax(0,1fr)); gap:0; }
      .kw-prep-optional { background:#fafbfc; padding:12px; margin:12px 0; border:1px solid #e7ebef; border-radius:8px; }
      .kw-prep-optional summary { cursor:pointer; font-size:12.5px; font-weight:700; }
      .kw-prep-buttons { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
      .kw-prep-banner { padding:9px 11px; border-radius:8px; background:#edf4fb; font-size:12px; color:#3d536b; margin:10px 0; }
    `;
    document.head.appendChild(s);
  }

  function renderToolbar(main, { from, to, selected }) {
    root = main;
    addStyle();
    dateFrom = from; dateTo = to; memberId = selected || null; dirty = false;
    const box = q("kw-prep-toolbar");
    if (!box) return;
    box.innerHTML = `<h2>週次AI分析｜良かった点と改善点を明確にする</h2>
      <p>①日報をPREPプロンプト付きMarkdownで出力 → ②ローカルAIに読み込ませる → ③結果を確認して本人へ公開。</p>
      <div class="kw-prep-row">
        <label>出力期間（開始）<input id="kw-prep-from" aria-label="PREP分析の開始日" type="date" value="${esc(dateFrom)}" max="${esc(to)}"></label>
        <label>出力期間（終了）<input id="kw-prep-to" aria-label="PREP分析の終了日" type="date" value="${esc(dateTo)}"></label>
        <label>出力する人<select id="kw-prep-scope" aria-label="PREP分析の出力対象">
          <option value="member">選択した社員</option><option value="all">対象社員全員</option>
        </select></label>
        <button class="kw-prep-btn primary" id="kw-prep-export" type="button">PREP付き .md をダウンロード</button>
      </div>
      <p>上の集計は対象週の数字です。MDの出力と本人への公開には、ここで選んだ期間を使用します（最大35日）。個人情報を含むため、承認されたローカルAIのみで分析してください。</p>
      <div role="status" aria-live="polite" id="kw-prep-message"></div>`;
    const validateChange = () => {
      const fromNew = q("kw-prep-from")?.value || "";
      const toNew = q("kw-prep-to")?.value || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromNew) || !/^\d{4}-\d{2}-\d{2}$/.test(toNew)
          || fromNew > toNew || (Date.parse(toNew) - Date.parse(fromNew)) / 86400000 >= 35) {
        q("kw-prep-from").value = dateFrom;
        q("kw-prep-to").value = dateTo;
        status("日付を確認してください。対象期間は1〜35日です。", true);
        return;
      }
      if (dirty && !confirm("未保存の編集内容があります。期間を切り替えますか？")) {
        q("kw-prep-from").value = dateFrom; q("kw-prep-to").value = dateTo; return;
      }
      dateFrom = fromNew; dateTo = toNew; dirty = false;
      status("対象期間を変更しました。分析結果もこの期間で管理します。");
      renderEditor(main, memberId);
    };
    q("kw-prep-from").addEventListener("change", validateChange);
    q("kw-prep-to").addEventListener("change", validateChange);
    q("kw-prep-export").addEventListener("click", download);
  }

  const getBody = () => Object.fromEntries(FIELDS.map(([key]) => [key, q("kw-prep-" + key)?.value?.trim() || ""]));
  const msg = (text, bad = false) => status(text, bad, "kw-prep-editor-message");
  function renderEditor(main, id) {
    root = main; memberId = id || null; dirty = false;
    const box = q("kw-prep-feedback");
    if (!box) return;
    if (!memberId) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="kw-prep-editor">
      <h3>この社員への週次フィードバック</h3>
      <p>対象期間：<b id="kw-prep-period">${esc(dateFrom)}〜${esc(dateTo)}</b>。
        分析結果は下書き保存だけでは本人に見えません。「本人へ公開」で初めてホームに表示されます。</p>
      <div class="kw-prep-banner" id="kw-prep-published">公開状況を確認中…</div>
      <label class="kw-prep-label">ローカルAIのMarkdown結果を貼り付ける
        <textarea id="kw-prep-raw" rows="6" placeholder="## 結論（Point）&#10;...&#10;## 良かった点&#10;...&#10;## 改善点&#10;...&#10;## 来週の行動&#10;..."></textarea>
      </label>
      <button type="button" class="kw-prep-btn" id="kw-prep-extract">7見出しを読み取って入力欄へ反映</button>
      <div class="kw-prep-main">
        ${title("良かった点（具体的成果＋根拠）", "good_points")}
        ${title("改善点（何を変えるか）", "improvement_points")}
        ${title("来週の行動（何を／期限／完了条件）", "next_actions")}
      </div>
      <details class="kw-prep-optional"><summary>PREP分析の詳細（結論・理由・根拠・改善提案）</summary>
        ${FIELDS.slice(0, 4).map(([key, label]) => title(label, key)).join("")}
      </details>
      <div class="kw-prep-buttons">
        <button type="button" class="kw-prep-btn" id="kw-prep-save">下書きを保存</button>
        <button type="button" class="kw-prep-btn primary" id="kw-prep-publish">確認して本人へ公開</button>
        <button type="button" class="kw-prep-btn" id="kw-prep-withdraw" hidden>公開を取り消す</button>
      </div>
      <p role="status" aria-live="polite" id="kw-prep-editor-message"></p>
      <p>AIの文章は最終評価ではありません。誤った数値・原因の推測・人格評価がないか、経営者が確認してから公開してください。</p>
    </div>`;
    for (const x of box.querySelectorAll("textarea[data-prep-field]")) x.addEventListener("input", () => { dirty = true; });
    q("kw-prep-extract").addEventListener("click", extract);
    q("kw-prep-save").addEventListener("click", () => save("save"));
    q("kw-prep-publish").addEventListener("click", () => save("publish"));
    q("kw-prep-withdraw").addEventListener("click", withdraw);
    refresh(id, { ...period() });
  }

  function parseSections(raw) {
    const re = /^##\s+(.+)\s*$/gm;
    const matched = [...raw.matchAll(re)];
    const out = {};
    for (let i=0; i<matched.length; i++) {
      const name = matched[i][1].trim();
      const key = names[name];
      if (!key || out[key]) continue;
      const next = matched[i+1]?.index ?? raw.length;
      out[key] = raw.slice(matched[i].index + matched[i][0].length, next).trim().slice(0,6000);
    }
    return out;
  }
  function extract() {
    const parsed = parseSections(q("kw-prep-raw")?.value || "");
    if (!Object.keys(parsed).length) {
      msg("見出しを読み取れませんでした。プロンプトの7見出しを維持したMarkdownを貼り付けてください。", true);
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      const field = q("kw-prep-" + key); if (field) field.value = value;
    }
    dirty = true;
    msg(Object.keys(parsed).length + "項目を反映しました。内容を確認し、必要に応じて修正してください。");
  }

  async function refresh(id, dates) {
    const tick = ++generation;
    try {
      const params = new URLSearchParams({ mode: "feedback", employeeId: id, from: dates.from, to: dates.to });
      const r = await API.api("/api/keiei/weekly-prep?" + params);
      if (tick !== generation || memberId !== id || dateFrom !== dates.from || dateTo !== dates.to) return;
      const editable = r.draft && (!r.published || (r.draft.updatedAt || "") > (r.published.publishedAt || ""))
        ? r.draft : (r.published || r.draft);
      for (const [key] of FIELDS) {
        const f = q("kw-prep-" + key); if (f) f.value = editable?.[key.replace(/_([a-z])/g, (_,c)=>c.toUpperCase())] || "";
      }
      q("kw-prep-published").textContent = r.published
        ? "本人へ公開中（公開日：" + (r.published.publishedAt || "").slice(0, 10) + "）。下書きを編集しても、再公開するまで公開済み内容は変わりません。"
        : "本人へ未公開。AIの分析結果を確認後に公開してください。";
      q("kw-prep-withdraw").hidden = !r.published;
      if (r.draft) msg("下書きがあります。内容を確認して公開できます。");
    } catch (e) {
      if (tick !== generation) return;
      msg(e.hint || e.message || "保存状況を読み込めませんでした", true);
    }
  }

  async function download() {
    const btn = q("kw-prep-export"); if (!btn) return;
    const scope = q("kw-prep-scope")?.value || "member";
    if (scope !== "all" && !memberId) return status("左から社員を選んでください", true);
    btn.disabled = true; status("対象の日報を準備中…");
    try {
      const params = new URLSearchParams({ mode: "export", scope, from: dateFrom, to: dateTo });
      if (scope === "member") params.set("employeeId", memberId);
      const r = await API.api("/api/keiei/weekly-prep?" + params);
      const file = new Blob(["\uFEFF", r.markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(file);
      const a = document.createElement("a"); a.href = url; a.download = r.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
      status((r.count?.employees || 0) + "人・" + (r.count?.reports || 0) + "日報のPREP付きMarkdownを出力しました。ローカルAIで分析してください。");
    } catch (e) {
      status(e.hint || e.message || "MDファイルを出力できませんでした", true);
    } finally { btn.disabled = false; }
  }

  async function save(action) {
    if (!memberId) return;
    const values = getBody();
    if (action === "publish") {
      if (!values.good_points || !values.improvement_points || !values.next_actions)
        return msg("本人への公開には「良かった点・改善点・来週の行動」の3つが必要です。", true);
      if (!confirm("この内容を本人のホーム画面へ公開します。日報の事実と数値は確認しましたか？")) return;
    }
    const currentId = memberId, range = { ...period() };
    const btn = q(action === "save" ? "kw-prep-save" : "kw-prep-publish");
    if (btn) btn.disabled = true;
    try {
      await API.api("/api/keiei/weekly-prep", {
        method: "POST",
        body: { action, employeeId: currentId, from: range.from, to: range.to, ...values },
      });
      if (currentId !== memberId || range.from !== dateFrom || range.to !== dateTo) return;
      dirty = false;
      msg(action === "save" ? "下書きを保存しました。本人には表示されません。" : "本人のホーム画面へ公開しました。");
      await refresh(currentId, range);
    } catch (e) { msg(e.hint || e.message || "保存できませんでした", true); }
    finally { if (btn) btn.disabled = false; }
  }

  async function withdraw() {
    if (!memberId || !confirm("公開を取り消しますか？本人のホームから非表示になります。")) return;
    const id = memberId, range = { ...period() };
    try {
      await API.api("/api/keiei/weekly-prep", { method: "POST", body: { action: "withdraw", employeeId: id, ...range } });
      if (id !== memberId) return;
      msg("公開を取り消しました。");
      await refresh(id, range);
    } catch(e) { msg(e.hint || e.message || "公開を取り消せませんでした", true); }
  }
  window.KeieiPrep = {
    renderToolbar,
    renderEditor,
    maySwitch() { return !dirty || confirm("未保存の分析内容があります。切り替えますか？"); },
  };
})();
