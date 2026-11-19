(() => {
  const stages = [
    ["unsent", "未送信"], ["sent", "送信済み"], ["responded", "反応あり"], ["scheduled", "商談予定"], ["done", "商談済み"],
  ];
  const filters = ["q", "owner", "region", "industry", "service", "campaign", "next"];
  const initial = new URLSearchParams(location.search);
  let stage = stages.some(([key]) => key === initial.get("stage")) ? initial.get("stage") : "unsent";
  let currentPage = Math.max(1, Number(initial.get("page")) || 1);
  let seq = 0;
  let statsOpen = false;
  let quickRows = [];
  const queue = el("queue");
  const stagePicker = el("stages");
  const sortPicker = el("f-sort");
  const sortOptions = [...sortPicker.options].map(option => option.value);
  const requestedSort = [initial.get("sort"), initial.get("order")].join(":");
  sortPicker.value = sortOptions.includes(requestedSort) ? requestedSort : "";
  const values = Object.fromEntries(filters.map(k => [k, initial.get(k) || ""]));
  values.owner = initial.has("owner") ? initial.get("owner") : initial.get("scope") === "all" ? "" : "mine";
  el("f-q").value = values.q;

  detailHost.centered = true;
  detailHost.urlFor = (id) => {
    const url = new URL(location.href);
    url.searchParams.delete("meeting");
    if (id) url.searchParams.set("id", id); else url.searchParams.delete("id");
    return url;
  };
  detailHost.onChange = () => {
    load();
    if (statsOpen) loadStats();
  };
  detailHost.openAttack = openAttack;

  SalesLayout.init({ active: "attack" }).then(ctx => {
    if (!ctx) return;
    myName = ctx.me?.gw?.employee?.display_name || "";
    myEmployeeId = ctx.me?.gw?.employee?.id || null;
    el("attack-stats").hidden = !ctx.canForce;
    load();
    if (initial.get("id")) openCompany(initial.get("id"), Boolean(initial.get("meeting")));
  });

  function updateUrl() {
    const url = new URL(location.href);
    url.searchParams.set("stage", stage);
    url.searchParams.delete("scope");
    for (const k of filters) {
      if (values[k] || k === "owner") url.searchParams.set(k, values[k]);
      else url.searchParams.delete(k);
    }
    const [sort, order] = sortPicker.value.split(":");
    if (sort) { url.searchParams.set("sort", sort); url.searchParams.set("order", order); }
    else { url.searchParams.delete("sort"); url.searchParams.delete("order"); }
    if (currentPage > 1) url.searchParams.set("page", currentPage); else url.searchParams.delete("page");
    history.replaceState({}, "", url);
  }

  function setOptions(k, options) {
    const current = values[k];
    const all = options.some(([val]) => val === current) || !current ? options : [...options, [current, current]];
    el("f-" + k).replaceChildren(...all.map(([val, label]) => new Option(label, val, false, val === current)));
  }

  function renderFilters(data) {
    const toOptions = list => (list || []).map(item => [item, item]);
    const master = data.masters || {};
    members = data.members || [];
    setOptions("owner", [["mine", "自分の担当＋担当なし"], ["", "担当：全員"], ["me", "自分"], ["none", "担当なし"],
      ...members.map(m => [m.id, m.display_name || "名前未登録"])]);
    setOptions("region", [["", "地域：すべて"], ...toOptions(master.prefectures), ["none", "地域未設定"]]);
    setOptions("industry", [["", "業種：すべて"], ...toOptions(master.industries)]);
    setOptions("service", [["", "提案サービス：すべて"], ...toOptions(master.services)]);
    setOptions("campaign", [["", "キャンペーン：すべて"], ...(data.campaigns || []).map(c => [c.id, c.name]), ["none", "キャンペーンなし"]]);
    setOptions("next", [["", "次の対応：すべて"], ...(data.nextFilters || []).map(n => [n.key, n.label])]);
  }

  function renderStages(counts = {}) {
    for (const [key, label] of stages) {
      let button = stagePicker.querySelector(`[data-stage="${key}"]`);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.stage = key;
        stagePicker.append(button);
      }
      button.setAttribute("aria-pressed", String(key === stage));
      button.replaceChildren(document.createTextNode(label));
      if (Number.isInteger(counts[key])) {
        const count = document.createElement("span");
        count.className = "at-badge";
        count.textContent = counts[key].toLocaleString("ja-JP");
        button.append(count);
      }
    }
  }

  async function load() {
    const request = ++seq;
    const [sort, order] = sortPicker.value.split(":");
    renderStages();
    queue.classList.add("loading");
    queue.setAttribute("aria-busy", "true");
    el("qa-start").hidden = true;
    el("count").textContent = "";
    el("pager").replaceChildren();
    try {
      const data = await API.listSalesCompanyPage({ ...values, view: "attack", stage, page: currentPage, sort, order });
      if (request !== seq) return;
      currentPage = data.page;
      updateUrl();
      renderFilters(data);
      renderStages(data.counts);
      quickRows = data.companies || [];
      el("qa-start").hidden = stage !== "unsent" || !data.total;
      renderRows(quickRows);
      renderPager(data);
    } catch (error) {
      if (request !== seq) return;
      queue.innerHTML = `<div class="banner err" role="alert">一覧を取得できませんでした。 ${esc(errText(error, ""))}
        <button type="button" class="btn btn-secondary btn-sm" data-action="retry">再読み込み</button></div>`;
    } finally {
      if (request === seq) {
        queue.classList.remove("loading");
        queue.setAttribute("aria-busy", "false");
      }
    }
  }

  function button(action, label, primary = false) {
    return `<button type="button" class="btn ${primary ? "btn-primary" : "btn-secondary"} btn-sm" data-action="${action}">${label}</button>`;
  }

  const needsClickFollowup = c => c.clickCount > 0 && !c.lpAppliedAt && !c.lpCandidate
    && !c.meetingStatus && !["replied", "meeting", "proposal", "won"].includes(c.status);
  const phoneOf = c => String(c.phone || "").replace(/[^0-9+]/g, "");

  function rowActions(c) {
    if (c.stage === "unsent") return c.attackReady ? button("attack", "フォームアタック", true) : "";
    if (c.stage === "sent") return c.attackReady ? button("attack", "フォームアタック") : "";
    if (c.stage === "scheduled") return button("meeting", "商談予定を見る", true);
    if (c.stage === "done" || c.status === "won") return "";
    if (c.meetingStatus === "scheduling") return button("meeting", "日程調整を見る", true);
    if (c.lpCandidate && !c.lpAppliedAt) return button("detail", "申込を確認する", true);
    if (!needsClickFollowup(c)) return button("meeting", "商談を予定する", true);
    const phone = phoneOf(c);
    return /\d/.test(phone)
      ? `<a class="btn btn-primary btn-sm" href="tel:${esc(phone)}">電話する</a> ${button("call", "電話した")}`
      : button("follow", "フォローする", true);
  }

  function httpUrl(raw) {
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  }

  function renderRows(rows) {
    if (!rows.length) {
      queue.innerHTML = '<div class="sl-empty">条件に合う企業はありません。 <a href="/sales/?companyAdd=1">企業を追加</a></div>';
      return;
    }
    queue.innerHTML = rows.map(c => {
      const url = httpUrl(c.meetingUrl);
      const recentClick = c.lastClickAt && Date.now() - Date.parse(c.lastClickAt) <= 30 * 60000;
      const next = needsClickFollowup(c) ? (/\d/.test(phoneOf(c)) ? "電話する" : "フォローする")
        : c.lpCandidate && !c.lpAppliedAt ? "申込の会社を確認する" : c.next;
      return `<article class="at-row" data-id="${esc(c.id)}" data-name="${esc(c.name)}">
        <div class="at-info">
          <button type="button" class="at-name" data-action="detail">${esc(c.name)}</button>
          <div class="at-meta">
            ${statusPill(c.status, c.statusLabel)}
            <span>担当：${esc(c.ownerName || "未定")}</span>
            ${c.service ? `<span>${esc(c.service)}</span>` : ""}
            ${c.campaignName ? `<span>${esc(c.campaignName)}</span>` : ""}
          </div>
          <div class="at-meta">
            ${c.meetingAt ? `<strong>商談日時：${esc(fmt(c.meetingAt))}</strong>` : ""}
            ${c.meetingStatus === "scheduling" ? '<span class="at-note">予約待ち</span>' : ""}
            ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">会議URL</a>` : c.meetingAt ? "<span>会議URL未登録</span>" : ""}
            ${c.conductedAt ? `<span>実施記録：${esc(fmt(c.conductedAt))}</span>` : ""}
            ${c.lastSentAt ? `<span>最終送信：${esc(fmt(c.lastSentAt))}${c.lastAttacker ? `（${esc(c.lastAttacker)}）` : ""}</span>` : ""}
            ${c.lastFailedAt ? `<span class="at-note">送信できず：${esc(fmt(c.lastFailedAt))}</span>` : ""}
          </div>
          <div class="at-meta">
            ${c.lpAppliedAt ? "<strong>MGNDigital申込あり</strong>" : ""}
            ${c.lpCandidate && !c.lpAppliedAt ? "<strong>既存企業候補あり・要確認</strong>" : ""}
            ${c.lpServices?.length ? `<span>希望：${esc(c.lpServices.join("、"))}</span>` : ""}
            ${c.clickCount ? `<span>${c.mgnClick ? "MGNDigital LP " : ""}クリック ${c.clickCount}回${c.lastClickAt ? `（最終 ${esc(fmt(c.lastClickAt))}）` : ""}</span>` : ""}
            ${recentClick ? '<span class="at-note">30分以内にクリック</span>' : ""}
            ${c.unhandledClick ? '<span class="at-note">要フォロー</span>' : ""}
          </div>
          <div class="at-meta">
            <span>次の対応：${esc(next)}${c.nextDue ? `（${esc(fmtDay(c.nextDue))}${c.overdue ? "・期限超過" : ""}）` : ""}</span>
            ${c.stage === "unsent" && !c.formUrl ? '<span class="at-note">フォームURL未登録</span>' : ""}
          </div>
        </div>
        <div class="at-actions">${["scheduled","done"].includes(c.stage)?`<a class="btn btn-primary btn-sm" href="/sales/enger-meeting.html?salesCompanyId=${encodeURIComponent(c.id)}" target="_blank" rel="noopener noreferrer">ENGER商談を開始</a>`:""}${rowActions(c)}</div>
      </article>`;
    }).join("");
  }

  function renderPager(data) {
    el("count").textContent = `${data.total.toLocaleString("ja-JP")}社`;
    if (data.totalPages <= 1) return;
    el("pager").innerHTML = `
      <button class="btn btn-secondary btn-sm" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>前へ</button>
      <span>${data.page} / ${data.totalPages}</span>
      <button class="btn btn-secondary btn-sm" data-page="${data.page + 1}" ${data.page >= data.totalPages ? "disabled" : ""}>次へ</button>`;
  }

  function openAttack(id) {
    const row = quickRows.find(c => c.id === id);
    const picked = row || (id ? { id } : null);
    const from = row ? quickRows.indexOf(row) + 1 : 0;
    const continuing = stage === "unsent";
    const [sort, order] = sortPicker.value.split(":");
    const params = { ...values, view: "attack", stage: "unsent", sort, order };
    if (detailOpenId) closeModal();
    return SalesQuickAttack.start({
      picked,
      rows: continuing ? quickRows.slice(from) : [],
      fetchPage: continuing ? page => API.listSalesCompanyPage({ ...params, page }) : null,
      sender: myName || "ENGER事業部",
      done: detailHost.onChange,
    });
  }

  async function openCompany(id, showMeeting = false, follow = false) {
    if (!(await openDetail(id))) return;
    if (showMeeting) openMeeting();
    else if (follow) openEvent("follow");
  }

  let statsSeq = 0;
  async function loadStats() {
    const request = ++statsSeq;
    const box = el("attack-stats-body");
    box.textContent = "集計中…";
    try {
      const data = await API.listSalesCompanyPage({ view: "attack-stats" });
      if (request !== statsSeq) return;
      box.innerHTML = data.stats.length ? `<table class="sl-table">
        <thead><tr><th scope="col">担当者</th><th scope="col">送信件数</th><th scope="col">商談獲得件数</th></tr></thead>
        <tbody>${data.stats.map(row => `<tr><th scope="row">${esc(row.name)}</th><td>${row.sent}</td><td>${row.booked}</td></tr>`).join("")}</tbody>
      </table>` : "集計対象の記録はありません。";
    } catch (error) {
      if (request === statsSeq) box.textContent = `集計を取得できませんでした。 ${errText(error, "")}`;
    }
  }

  let searchTimer;
  const resetPage = () => { currentPage = 1; updateUrl(); load(); };
  el("f-q").addEventListener("input", event => {
    values.q = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(resetPage, 300);
  });
  for (const k of filters.filter(k => k !== "q")) {
    el("f-" + k).addEventListener("change", event => { values[k] = event.target.value; resetPage(); });
  }
  sortPicker.addEventListener("change", resetPage);
  stagePicker.addEventListener("click", event => {
    const nextStage = event.target.closest("[data-stage]")?.dataset.stage;
    if (!nextStage || stage === nextStage) return;
    stage = nextStage;
    resetPage();
  });
  queue.addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "retry") return load();
    const row = event.target.closest("[data-id]");
    if (!action || !row) return;
    const { id, name } = row.dataset;
    if (action === "attack") openAttack(id);
    else if (action === "call") openCallLog(id, name);
    else openCompany(id, action === "meeting", action === "follow");
  });
  el("pager").addEventListener("click", event => {
    const page = Number(event.target.dataset.page);
    if (page < 1 || !Number.isInteger(page)) return;
    currentPage = page;
    updateUrl();
    load();
  });
  el("attack-stats").addEventListener("toggle", event => {
    statsOpen = event.target.open;
    if (statsOpen) loadStats();
  });
  el("qa-start").addEventListener("click", () => openAttack());
  if (typeof BroadcastChannel === "function") {
    const channel = new BroadcastChannel("sales-attack-result");
    channel.addEventListener("message", () => {
      if (el("quick-attack").open) return;
      if (detailOpenId) reloadDetail(); else detailHost.onChange();
    });
  }
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || el("quick-attack").open) return;
    if (el("action-root").firstElementChild) closeAction();
    else if (el("detail-box")) closeModal();
  });

  renderStages();
})();
