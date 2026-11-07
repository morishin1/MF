// KEIEI週次振り返り：操作する段階だけを見せる4ステップバー。
// MD出力は端末内での一時状態。下書き・公開状態だけを既存APIの応答で確定する。
(() => {
  "use strict";
  const STEPS = [
    { n: 1, title: "対象を選ぶ", hint: "社員・期間" },
    { n: 2, title: "MDを出力", hint: "ローカルAIへ" },
    { n: 3, title: "結果を登録", hint: "MDアップロード" },
    { n: 4, title: "確認・公開", hint: "本人へ反映" },
  ];
  const s = { root: null, employeeId: null, from: "", to: "", step: 1,
    exported: false, imported: false, draft: false, published: false, loaded: false, manual: false };
  const instructions = {
    1: "左の社員一覧から対象者を選んでください。対象週も上部で切り替えられます。",
    2: "出力期間と対象者を確認し「PREP付きMDをダウンロード」を押してください。ファイルをローカルAIで分析します。",
    3: "ローカルAIの分析結果（MD）を読み込みます。ファイルの選択、またはMarkdownの貼り付けができます。",
    4: "「良かった点」「改善点」「来週の行動」を事実と照合し、下書き保存または本人への公開を選んでください。",
  };
  function installStyle() {
    if (document.getElementById("kw-flow-css")) return;
    const st = document.createElement("style");
    st.id = "kw-flow-css";
    st.textContent = [
      ".kw-flow{background:#fff;border:1px solid #dfe5ee;border-radius:12px;padding:12px 14px;margin:9px 0 12px;min-width:0;}",
      ".kw-flow-title{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;}",
      ".kw-flow-title strong{font-size:14px;color:#23334b;}",
      ".kw-flow-title small{font-size:11px;color:#65758a;}",
      ".kw-flow-track{height:4px;background:#e7ebf1;border-radius:99px;overflow:hidden;margin:4px 4px 11px;}",
      ".kw-flow-track>span{display:block;height:100%;background:#3179bd;transition:width .2s;}",
      ".kw-flow-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;}",
      ".kw-flow-step{min-width:0;display:flex;align-items:center;gap:9px;text-align:left;padding:9px;border:1px solid #dfe4eb;border-radius:9px;background:#fafbfc;cursor:pointer;color:#586475;}",
      ".kw-flow-step:hover{border-color:#82a5d6;background:#f5f8ff;}",
      ".kw-flow-step:focus-visible{outline:3px solid #7aa9ec;outline-offset:1px;}",
      ".kw-flow-step .kw-flow-number{width:26px;height:26px;border:2px solid #cad1db;border-radius:50%;flex:none;display:grid;place-items:center;background:#fff;font-size:12px;font-weight:800;}",
      ".kw-flow-step .kw-flow-copy{min-width:0;display:flex;flex-direction:column;gap:2px;}",
      ".kw-flow-step .kw-flow-copy b{font-size:12.5px;line-height:1.35;}",
      ".kw-flow-step .kw-flow-copy small{font-size:10.5px;line-height:1.3;}",
      ".kw-flow-step.done{color:#266a45;background:#f4faf6;border-color:#c6e4d1;}",
      ".kw-flow-step.done .kw-flow-number{background:#2e8054;border-color:#2e8054;color:#fff;}",
      ".kw-flow-step.active{color:#174a84;background:#edf5ff;border-color:#578bd0;box-shadow:inset 0 -2px 0 #457bc2;}",
      ".kw-flow-step.active .kw-flow-number{background:#285f9e;border-color:#285f9e;color:#fff;}",
      ".kw-flow-step.active.done .kw-flow-number{background:#2e8054;border-color:#2e8054;}",
      ".kw-flow-step[disabled]{cursor:default;opacity:.55;}",
      ".kw-flow-next{margin:10px 0 0;padding:10px 12px;background:#f1f6fc;border-radius:8px;color:#304b6e;font-size:12.5px;line-height:1.6;}",
      ".kw-flow-next b{margin-right:8px;color:#194b87;}",
      ".kw-page[data-kw-step='1'] #kw-prep-toolbar,.kw-page[data-kw-step='3'] #kw-prep-toolbar,.kw-page[data-kw-step='4'] #kw-prep-toolbar{display:none;}",
      ".kw-page[data-kw-step='1'] #kw-prep-feedback,.kw-page[data-kw-step='2'] #kw-prep-feedback{display:none;}",
      ".kw-page[data-kw-step='3'] .kw-prep-review,.kw-page[data-kw-step='4'] .kw-prep-import{display:none;}",
      ".kw-page[data-kw-step='3'] .kw-prep-editor,.kw-page[data-kw-step='4'] .kw-prep-editor{margin-top:0;padding-top:0;border-top:0;}",
      "@media(max-width:900px){.kw-flow-steps{grid-template-columns:repeat(2,minmax(0,1fr));}.kw-flow-step{padding:8px;}}",
      "@media(max-width:450px){.kw-flow{padding:10px;}.kw-flow-copy b{font-size:12px;}.kw-flow-step{gap:6px;}}"
    ].join("\n");
    document.head.appendChild(st);
  }
  function reset(employeeId, from, to) {
    s.employeeId = employeeId || null;
    s.from = from || "";
    s.to = to || "";
    s.step = s.employeeId ? 2 : 1;
    s.exported = false;
    s.imported = false;
    s.draft = false;
    s.published = false;
    s.loaded = false;
    s.manual = false;
  }
  function render() {
    const page = s.root?.querySelector(".kw-page");
    const target = s.root?.querySelector("#kw-prep-workflow");
    if (!page || !target) return;
    page.dataset.kwStep = String(s.step);
    const complete = [!!s.employeeId, s.exported, s.imported || s.draft || s.published, s.published];
    const statuses = [
      s.employeeId ? "選択済" : "未選択",
      s.exported ? "この画面で出力済" : "出力は未確認",
      complete[2] ? "登録済" : "未登録",
      s.published ? "本人へ公開済" : s.draft ? "下書きあり" : s.loaded ? "未公開" : "状態確認中",
    ];
    const progress = s.published ? 100 : (complete[2] ? 75 : s.exported ? 50 : s.employeeId ? 25 : 0);
    const buttons = STEPS.map((x, i) => {
      const active = s.step === x.n;
      const cls = (complete[i] ? " done" : "") + (active ? " active" : "");
      const disabled = !s.employeeId && x.n !== 1 ? " disabled" : "";
      return '<button type="button" class="kw-flow-step' + cls + '" data-kw-flow-step="' + x.n + '"' +
        (active ? ' aria-current="step"' : "") + disabled + '>' +
        '<span class="kw-flow-number" aria-hidden="true">' + (complete[i] ? "✓" : x.n) + "</span>" +
        '<span class="kw-flow-copy"><b>' + x.title + '</b><small>' + statuses[i] + "</small></span></button>";
    }).join("");
    const next = s.published && s.step === 4
      ? "公開済みです。内容を変更する場合は修正し、再度「本人へ公開」を押してください。"
      : instructions[s.step];
    target.innerHTML = '<section class="kw-flow" aria-label="週次振り返りの進行状況">' +
      '<div class="kw-flow-title"><strong>週次振り返りの進め方</strong><small>ステップを押すと必要な操作だけ表示</small></div>' +
      '<div class="kw-flow-track" role="progressbar" aria-label="完了した工程" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progress + '"><span style="width:' + progress + '%"></span></div>' +
      '<div class="kw-flow-steps">' + buttons + '</div>' +
      '<div class="kw-flow-next" role="status" aria-live="polite"><b>今すること</b>' + next + "</div></section>";
    target.querySelectorAll("[data-kw-flow-step]").forEach((el) =>
      el.addEventListener("click", () => choose(Number(el.dataset.kwFlowStep))));
  }
  function choose(n) {
    if (!STEPS.some((x) => x.n === n) || (n !== 1 && !s.employeeId)) return;
    s.step = n;
    s.manual = true;
    render();
  }
  function init(root, employeeId, from, to) {
    s.root = root;
    installStyle();
    if (employeeId !== s.employeeId || from !== s.from || to !== s.to) reset(employeeId, from, to);
    render();
  }
  function selectMember(employeeId) {
    if (employeeId !== s.employeeId) reset(employeeId, s.from, s.to);
    render();
  }
  function onStatus(draft, published) {
    s.draft = !!draft;
    s.published = !!published;
    s.loaded = true;
    if (!s.manual) s.step = s.draft || s.published ? 4 : s.exported ? 3 : s.employeeId ? 2 : 1;
    render();
  }
  function onExport() {
    s.exported = true;
    s.manual = true;
    s.step = 3;
    render();
  }
  function onImport() {
    s.imported = true;
    s.manual = true;
    s.step = 4;
    render();
  }
  function onSaved(action) {
    s.draft = true;
    if (action === "publish") s.published = true;
    s.loaded = true;
    s.manual = true;
    s.step = 4;
    render();
  }
  function onWithdraw() {
    s.published = false;
    s.loaded = true;
    render();
  }
  window.KeieiWorkflow = { init, selectMember, onStatus, onExport, onImport, onSaved, onWithdraw, choose };
})();
