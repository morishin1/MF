// Sales提案管理の列：主担当3段階は常に表示。その他は表示/非表示・順序変更をブラウザに保存。
(function () {
  "use strict";
  const META = [
    { key:"date", label:"提案日時", sort:"sent" },
    { key:"company", label:"企業", sort:"company" },
    { key:"proposal", label:"提案担当", sort:"proposal_owner" },
    { key:"cs", label:"CS担当", sort:"cs_owner" },
    { key:"closing", label:"クロージング担当", sort:"closing_owner" },
    { key:"status", label:"進捗" }, { key:"next", label:"次の行動・期限" },
    { key:"service", label:"種別" }, { key:"title", label:"提案内容" },
    { key:"elapsed", label:"経過", sort:"elapsed" }, { key:"phone", label:"電話" },
    { key:"mail", label:"メール" }, { key:"sync", label:"連携" },
  ];
  const FIXED = ["date","company","proposal","cs","closing"];
  const KEY = "eight_sales_proposal_columns_v1";
  const defaults = () => ({
    order: META.map((m) => m.key),
    visible: META.map((m) => m.key).filter((key) => !["phone","mail","sync","elapsed"].includes(key)),
  });
  let pref = defaults();
  let onChanged = () => {}, onSort = () => {}, onOpen = () => {}, onClose = () => {};
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || "null");
    if (Array.isArray(stored?.order) && Array.isArray(stored?.visible)) {
      const all = new Set(META.map((m) => m.key));
      const order = [...new Set(stored.order.filter((k) => all.has(k)))];
      pref.order = [...order, ...META.map((m) => m.key).filter((k) => !order.includes(k))];
      pref.visible = [...new Set([...stored.visible.filter((k) => all.has(k)), ...FIXED])];
    }
  } catch {}
  const safe = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  const columns = () => pref.order.filter((k) => pref.visible.includes(k)).map((k) => META.find((c) => c.key === k));
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch {}
    onChanged();
  };
  const head = (sort) => '<th class="pp-check-col"><input type="checkbox" id="pp-all" aria-label="表示中の操作可能な提案をすべて選択" onchange="ppSelectAll(this.checked)"></th>' +
    columns().map((m) => {
      const selected = sort === m.sort || (sort === "sent_asc" && m.sort === "sent");
      return '<th>' + (m.sort ? '<button type="button" onclick="SalesProposalColumns.sort(\'' + m.sort +
        '\')" title="' + safe(m.label) + 'で並べ替え">' + safe(m.label) +
        (selected ? ' <span aria-hidden="true">' + (sort === "sent_asc" ? "↑" : "↓") + '</span>' : ' ↕') +
        '</button>' : safe(m.label)) + '</th>';
    }).join("");
  const cellHtml = (r, render) => columns().map((m) => '<td class="' +
    (["date","elapsed","phone","mail"].includes(m.key) ? "nw" : "") + '">' +
    render(m.key,r) + '</td>').join("");
  const editorHtml = () =>
    '<h2>提案一覧の列を変更</h2>' +
    '<p class="sl-muted">矢印で並べ替え。不要な列は非表示にできます。3担当と提案日時・企業は必ず表示します。</p>' +
    pref.order.map((key,i) => {
      const m = META.find((x) => x.key === key), mandatory = FIXED.includes(key);
      return '<div class="pp-col-row"><label><input type="checkbox" ' +
        (pref.visible.includes(key) ? 'checked ' : '') + (mandatory ? 'disabled ' : '') +
        'onchange="SalesProposalColumns.toggle(\'' + key + '\',this.checked)">' + safe(m.label) +
        '</label><button type="button" ' + (i === 0 ? "disabled" : "") +
        ' onclick="SalesProposalColumns.move(\'' + key + '\',-1)">↑</button>' +
        '<button type="button" ' + (i === pref.order.length - 1 ? "disabled" : "") +
        ' onclick="SalesProposalColumns.move(\'' + key + '\',1)">↓</button></div>';
    }).join("") +
    '<div class="sl-modal-foot"><button class="btn btn-secondary" onclick="SalesProposalColumns.reset()">初期配置へ</button>' +
    '<button class="btn btn-primary" onclick="SalesProposalColumns.close()">完了</button></div>';
  const ui = {
    init(callbacks) {
      onChanged = callbacks.changed;
      onSort = callbacks.sort;
      onOpen = callbacks.open;
      onClose = callbacks.close;
    },
    head, cellHtml, columns, editorHtml, open: () => onOpen(editorHtml()), close: () => onClose(),
    sort: (key) => onSort(key),
    toggle(key,value) {
      if (FIXED.includes(key) || !META.some((m) => m.key === key)) return;
      const next = new Set(pref.visible);
      if (value) next.add(key); else next.delete(key);
      pref.visible = [...next];
      save();
    },
    move(key,offset) {
      const i = pref.order.indexOf(key), j = i + offset;
      if (i < 0 || j < 0 || j >= pref.order.length || Math.abs(offset) !== 1) return;
      [pref.order[i],pref.order[j]] = [pref.order[j],pref.order[i]];
      save(); onOpen(editorHtml());
    },
    reset() { pref = defaults(); save(); onOpen(editorHtml()); },
  };
  window.SalesProposalColumns = ui;
}());
