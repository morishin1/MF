(() => {
  const $ = id => document.getElementById(id);
  const root = new URLSearchParams(location.search);
  const focus = root.get("id") && { id: root.get("id"), kind: root.get("kind") };
  const stageLabels = { meeting: "面談・商談", proposal: "提案", negotiation: "条件交渉", won: "受注", lost: "見送り" };
  const milestoneLabels = { sentOn: "提案送信", meetingOn: "面談実施", offerOn: "オファー", wonOn: "受注", joinedOn: "参画" };
  const money = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });
  const dialog = $("ep-dialog");
  const period = $("ep-period");
  const day = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  let mode = root.get("view") === "analysis" ? "analysis" : "progress";
  let filter = mode === "progress" ? "attention" : "cohort";
  let result;
  let selectedPeriod;
  let comparison;
  let limit = 40;
  let generation = 0;

  function element(tag, content, className) {
    const node = document.createElement(tag);
    if (content != null) node.textContent = content;
    if (className) node.className = className;
    return node;
  }

  function button(text, click, className = "btn btn-secondary btn-sm") {
    const node = element("button", text, className);
    node.type = "button";
    node.addEventListener("click", click);
    return node;
  }

  function anchor(text, href) {
    const node = element("a", text);
    node.href = href;
    return node;
  }

  function setFilter(value) {
    filter = value;
    limit = 40;
    render();
  }

  function render() {
    if (!result) return;
    $("ep-content").hidden = false;
    $("ep-analysis").hidden = mode !== "analysis";
    for (const tab of document.querySelectorAll("[data-mode]")) {
      tab.classList.toggle("on", tab.dataset.mode === mode);
      tab.setAttribute("aria-pressed", String(tab.dataset.mode === mode));
    }
    $("ep-filters").hidden = mode === "analysis";
    $("ep-filters").replaceChildren(...Object.entries({ attention: "要対応", all: "すべて", unlinked: "案件未登録" }).map(([key, label]) => {
      const node = button(label, () => setFilter(key), key === filter ? "on" : "");
      node.setAttribute("aria-pressed", String(key === filter));
      return node;
    }));
    $("ep-won").textContent = money.format(result.won);
    $("ep-forecast").textContent = money.format(result.forecast);
    const cohort = new Set(result.metrics[0].ids);
    const reasons = new Map();
    for (const row of result.rows) {
      if (row.lost && cohort.has(row.id) && row.kind === "proposal") {
        const reason = row.lossReason || "理由未記録";
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
    }
    $("ep-metrics").replaceChildren(...result.metrics.map(metric => {
      const node = button(null, () => setFilter(metric.key === filter ? "cohort" : metric.key), "");
      node.setAttribute("aria-pressed", String(metric.key === filter));
      node.append(element("small", metric.label), element("strong", metric.ids.length + "件"));
      if (metric.key !== "sentOn") node.append(element("small", metric.rate === null ? "移行率 —" : "移行率 " + metric.rate + "%"));
      const previous = comparison?.find(item => item.key === metric.key);
      if (previous) node.append(element("small", "前期間 " + previous.ids.length + "件"
        + (previous.rate === null ? "" : "・移行率 " + previous.rate + "%"), "sl-muted"));
      return node;
    }));
    const metric = result.metrics.find(item => [item.key, "pending:" + item.key].includes(filter));
    const pending = metric?.pendingIds.length ? [button("移行未確認 " + metric.pendingIds.length + "件",
      () => setFilter(filter === "pending:" + metric.key ? metric.key : "pending:" + metric.key),
      filter.startsWith("pending:") ? "on" : "")] : [];
    $("ep-reasons").replaceChildren(...pending, ...[...reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => {
      const key = "reason:" + reason;
      const node = button(reason + " " + count + "件", () => setFilter(filter === key ? "cohort" : key), filter === key ? "on" : "");
      node.setAttribute("aria-pressed", String(filter === key));
      return node;
    }));
    const selected = result.metrics.find(metric => metric.key === filter);
    const pendingSelection = filter.startsWith("pending:");
    const selection = new Set(pendingSelection ? metric?.pendingIds : selected?.ids);
    let rows = result.rows.filter(row => {
      if (row.id === focus?.id && row.kind === focus.kind && mode === "progress") return true;
      if (filter === "attention") return Boolean(row.issue);
      if (filter === "unlinked") return !row.dealId && !row.closed;
      if (filter === "all") return true;
      if (row.kind !== "proposal" || !cohort.has(row.id)) return false;
      if (filter.startsWith("reason:")) return row.lost && (row.lossReason || "理由未記録") === filter.slice(7);
      return filter === "cohort" || selection.has(row.id);
    });
    const weight = row => row.id === focus?.id && row.kind === focus.kind ? -1 : row.issue === "overdue" ? 0 : row.issue === "missing" ? 1 : 2;
    rows.sort((a, b) => weight(a) - weight(b)
      || (a.nextDueOn || "9999").localeCompare(b.nextDueOn || "9999") || (b.stalledDays ?? -1) - (a.stalledDays ?? -1));
    if (mode === "progress") {
      const seen = new Set();
      rows = rows.filter(row => !row.dealId || (!seen.has(row.dealId) && seen.add(row.dealId)));
    }
    $("ep-list-title").textContent = (pendingSelection ? metric.label + "への移行未確認"
      : selected?.label || (filter.startsWith("reason:") ? filter.slice(7) : "対象一覧")) + " " + rows.length + "件";
    $("ep-rows").replaceChildren(...rows.slice(0, limit).map(renderRow));
    if (!rows.length) {
      const row = element("tr");
      const cell = element("td", "該当する記録はありません。");
      cell.colSpan = 6;
      row.append(cell);
      $("ep-rows").append(row);
    }
    $("ep-more").hidden = rows.length <= limit;
    $("ep-status").textContent = result.offerAccess ? "" : "この権限で閲覧できるENGER提案を表示しています。";
  }

  function renderRow(row) {
    const tr = element("tr");
    const title = element("td");
    title.append(element("strong", row.companyName || "企業未紐付け", "sl-nm"),
      element("span", row.title + (row.kind === "offer" ? "（オファー）" : ""), "sl-sub2"));
    const current = Object.keys(milestoneLabels).reverse().find(key => row.milestones[key]);
    const progress = element("td", row.lost ? "見送り" : row.milestones.joinedOn ? "参画"
      : stageLabels[row.dealStage] || row.sourceStatus || milestoneLabels[current] || "未記録");
    if (row.lossReason) progress.append(element("span", row.lossReason, "sl-sub2"));
    const owner = element("td", row.ownerName || "担当未設定");
    owner.append(element("span", row.nextAction || (row.closed ? "—" : "次の行動が未設定"), "sl-sub2"));
    const action = element("td");
    action.append(button(row.dealId ? "案件を開く" : "詳細", () => open(row)));
    tr.append(title, progress, owner, element("td", row.nextDueOn || "—", row.issue === "overdue" ? "sl-hot" : ""),
      element("td", row.stalledDays === null ? "—" : row.stalledDays + "日"), action);
    return tr;
  }

  function input(name, label, type, value, attributes = {}) {
    const wrapper = element("label", label);
    const control = element("input");
    Object.assign(control, { name, type, value: value ?? "" }, attributes);
    wrapper.append(control);
    return wrapper;
  }

  function select(name, label, options, value) {
    const wrapper = element("label", label);
    const control = element("select");
    control.name = name;
    for (const [key, text] of options) {
      const option = element("option", text);
      option.value = key;
      control.append(option);
    }
    control.value = value || "";
    wrapper.append(control);
    return wrapper;
  }

  async function save(form, endpoint, method, body, row) {
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    $("ep-dialog-status").textContent = "保存中…";
    try {
      await API.api(endpoint, { method, body });
      const loaded = await load(row);
      if (loaded && dialog.open) dialog.close();
      if (loaded) $("ep-status").textContent = "保存しました。";
      if (!loaded && dialog.open) $("ep-dialog-status").textContent = "保存しました。再表示で最新の内容を確認してください。";
    } catch (error) {
      $("ep-dialog-status").textContent = error.hint || "保存できませんでした。画面を更新して再度お試しください。";
    } finally {
      submit.disabled = false;
    }
  }

  function editor(row) {
    const form = element("form");
    const grid = element("div", null, "ep-edit-grid");
    grid.append(select("ownerId", "担当者", [["", "未設定"], ...result.employees.map(e => [e.id, e.name])], row.ownerId),
      select("stage", "案件の段階", Object.entries(stageLabels), row.dealStage),
      input("amount", "案件金額（円）", "number", row.amount, { min: 0, max: 100000000000, step: 1 }),
      input("expectedCloseOn", "受注見込み日", "date", row.expectedCloseOn),
      input("meetingHeldOn", "面談実施日", "date", row.milestones.meetingOn, { max: result.today }),
      input("wonOn", "受注日", "date", row.milestones.wonOn, { max: result.today }),
      input("joinedOn", "参画日", "date", row.milestones.joinedOn, { max: result.today }));
    const saveButton = element("button", "保存", "btn btn-primary");
    saveButton.type = "submit";
    form.append(input("nextAction", "次の行動", "text", row.nextAction, { maxLength: 240 }),
      input("nextDueOn", "対応期限", "date", row.nextDueOn), grid,
      input("lostReason", "見送り理由", "text", row.dealStage === "lost" ? row.lossReason : "", { maxLength: 500 }), saveButton);
    form.elements.lostReason.setAttribute("list", "ep-loss-reasons");
    const updateFields = () => {
      const stage = form.elements.stage.value;
      for (const field of ["wonOn", "joinedOn"]) form.elements[field].disabled = stage !== "won";
      form.elements.lostReason.disabled = stage !== "lost";
    };
    form.elements.stage.addEventListener("change", updateFields);
    updateFields();
    form.addEventListener("submit", event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const body = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value || null]));
      if (body.stage !== "lost") body.lostReason = null;
      if (body.stage !== "won") {
        body.wonOn = null;
        body.joinedOn = null;
      }
      if (body.meetingHeldOn === row.milestones.meetingOn && !row.recordedMeetingOn) body.meetingHeldOn = null;
      void save(form, "/api/sales/deals", "PATCH", { ...body, id: row.dealId, expectedUpdatedAt: row.updatedAt }, row);
    });
    return form;
  }

  async function open(row) {
    $("ep-dialog-title").textContent = row.companyName || row.title;
    $("ep-dialog-status").textContent = "";
    const host = $("ep-dialog-body");
    const original = row.kind === "proposal" ? "/sales/proposals.html?id=" + encodeURIComponent(row.id)
      : "/sales/company-segments.html?companyId=" + encodeURIComponent(row.engerCompanyId);
    const timeline = element("div", null, "ep-timeline");
    for (const [key, label] of Object.entries(milestoneLabels)) {
      const item = element("span", label);
      item.append(element("strong", row.milestones[key] || "未記録", "sl-sub2"));
      timeline.append(item);
    }
    host.replaceChildren(element("p", row.title), anchor(row.kind === "proposal" ? "元の提案・履歴を開く" : "企業のオファーを開く", original), timeline);
    if (!dialog.open) dialog.showModal();
    if (row.dealId) {
      host.append(editor(row));
      return;
    }
    const form = element("form");
    const submit = element("button", "案件にする", "btn btn-primary");
    submit.type = "submit";
    form.append(submit);
    host.append(form);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const selection = new FormData(form).get("dealId");
      const dealId = selection === "new" ? null : selection;
      void save(form, "/api/sales/enger-progress", "POST", { kind: row.kind, id: row.id, dealId }, row);
    });
    submit.disabled = true;
    if (row.companyId) {
      await showDealChoices(form, submit, row.companyId);
      return;
    }
    submit.hidden = true;
    const prepare = button("営業先を紐づけて案件候補を確認", async () => {
      prepare.disabled = true;
      $("ep-dialog-status").textContent = "既存案件を確認しています…";
      try {
        const data = await API.api("/api/sales/enger-progress", {
          method: "POST", body: { kind: row.kind, id: row.id, prepare: true },
        });
        if (!dialog.open || !form.isConnected) return;
        if (await showDealChoices(form, submit, data.companyId)) {
          prepare.remove();
          submit.hidden = false;
          $("ep-dialog-status").textContent = "";
        }
      } catch (error) {
        if (dialog.open && form.isConnected) $("ep-dialog-status").textContent = error.hint || "営業先を確認できませんでした。";
      } finally {
        prepare.disabled = false;
      }
    });
    form.prepend(prepare);
  }

  async function showDealChoices(form, submit, companyId) {
    try {
      const data = await API.api("/api/sales/deals?companyId=" + encodeURIComponent(companyId));
      if (!dialog.open || !form.isConnected) return false;
      if (data.deals.length) {
        const options = [["", "選択してください"], ...data.deals.map(deal => [deal.id, deal.title + "（" + deal.stageLabel + "）"]),
          ["new", "新規案件を作る"]];
        const field = select("dealId", "同じ企業の案件", options, "");
        field.querySelector("select").required = true;
        field.querySelector("select").addEventListener("change", event => {
          submit.textContent = event.target.value && event.target.value !== "new" ? "既存案件に紐づける" : "案件にする";
        });
        form.prepend(field);
      }
      submit.disabled = false;
      return true;
    } catch (error) {
      if (dialog.open && form.isConnected) $("ep-dialog-status").textContent = error.hint || "既存案件を確認できませんでした。";
      return false;
    }
  }

  async function load(selected = focus) {
    const request = ++generation;
    $("ep-status").textContent = "読み込み中…";
    const params = new URLSearchParams(new FormData(period));
    if (selected) {
      params.set("id", selected.id);
      params.set("kind", selected.kind);
    }
    try {
      const data = await API.api("/api/sales/enger-progress?" + params);
      if (request !== generation) return false;
      result = data;
      selectedPeriod = { since: params.get("since"), until: params.get("until") };
      comparison = null;
      $("ep-compare-status").textContent = "";
      render();
      return true;
    } catch (error) {
      if (request === generation) $("ep-status").textContent = error.hint || "データを読み込めませんでした。もう一度表示を押してください。";
      return false;
    }
  }

  $("ep-compare").onclick = async () => {
    if (!selectedPeriod) return;
    const request = generation;
    const control = $("ep-compare");
    const status = $("ep-compare-status");
    const { since, until } = selectedPeriod;
    const dayMs = 86400000;
    const gap = Date.parse(until) - Date.parse(since) + dayMs;
    const earlier = value => new Date(Date.parse(value) - gap).toISOString().slice(0, 10);
    const params = new URLSearchParams({ since: earlier(since), until: earlier(until), asOf: earlier(result.today), summary: "1" });
    control.disabled = true;
    status.textContent = "比較データを読み込み中…";
    try {
      const previous = await API.api("/api/sales/enger-progress?" + params);
      if (request !== generation) return;
      comparison = previous.metrics;
      status.textContent = params.get("since") + " 〜 " + params.get("until") + " と比較（両期間で終了日から同じ日数までを集計）";
      render();
    } catch (error) {
      if (request === generation) status.textContent = error.hint || "比較データを取得できませんでした。";
    } finally {
      control.disabled = false;
    }
  };

  $("ep-close").onclick = () => dialog.close();
  $("ep-more").onclick = () => { limit += 40; render(); };
  period.elements.since.value = mode === "analysis" ? day().slice(0, 7) + "-01"
    : new Date(Date.parse(day()) - 89 * 86400000).toISOString().slice(0, 10);
  period.elements.until.value = day();
  period.elements.since.max = period.elements.until.max = day();
  period.addEventListener("submit", event => { event.preventDefault(); void load(); });
  for (const tab of document.querySelectorAll("[data-mode]")) {
    tab.onclick = () => { mode = tab.dataset.mode; setFilter(mode === "progress" ? "attention" : "cohort"); };
  }
  SalesLayout.init({ active: mode === "analysis" ? "analytics" : "proposals" }).then(async ctx => {
    if (!ctx || !(await load()) || !focus) return;
    const row = result.rows.find(item => item.id === focus.id && item.kind === focus.kind);
    if (row) await open(row);
    else $("ep-status").textContent = "対象の記録が見つからないか、閲覧権限がありません。";
  });
})();
