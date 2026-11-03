// Sales dashboard: choose the next action first, and request large analysis
// only when the user opens Rankings or Analysis. All existing API/data rules stay
// in their original modules; this file only controls presentation.
(() => {
  const $ = (id) => document.getElementById(id);
  const VIEWS = ["today", "company", "analysis"];
  const QUEUES = ["click", "replied", "follow", "attack"];
  const NOTES = {
    click: "最初に対応する企業です。上位3社の状況を確認して、連絡結果を記録します。",
    replied: "返信が届いた企業です。条件確認と面談調整を優先します。",
    follow: "期限と前回履歴を確認して、フォロー内容を記録します。",
    attack: "アタック候補の一覧です。表示件数すべてが今日の必須作業という意味ではありません。",
  };
  let activeView = "today";
  let activeQueue = "click";
  let queueTouched = false;
  let authorized = false;
  let reportLoaded = false;

  const queryView = () => {
    const wanted = new URL(location.href).searchParams.get("tab");
    return wanted === "rankings" ? "today" : VIEWS.includes(wanted) ? wanted : "today";
  };

  function showView(view, { writeUrl = false } = {}) {
    activeView = VIEWS.includes(view) ? view : "today";
    for (const key of VIEWS) {
      const selected = key === activeView;
      const tab = $("db-tab-" + key);
      const panel = $("db-panel-" + key);
      if (tab) {
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      if (panel) panel.hidden = !selected;
    }
    if (writeUrl) {
      const url = new URL(location.href);
      if (activeView === "today") url.searchParams.delete("tab");
      else url.searchParams.set("tab", activeView);
      history.pushState({ salesTab: activeView }, "", url);
    }
    // The analytics API also supplies rankings. One call, shared data and
    // one report instance: no repeated scan on every tab click.
    if (activeView === "company") window.SalesCompanyReference?.loadIfVisible?.();
    if (authorized && !reportLoaded && (activeView === "analysis" || $("db-merged-rankings")?.open === true)) {
      reportLoaded = true;
      window.SalesDashboardReport?.load();
    }
  }

  function showQueue(key, { touched = false } = {}) {
    if (!QUEUES.includes(key)) return;
    activeQueue = key;
    queueTouched = queueTouched || touched;
    for (const name of QUEUES) {
      const panel = $("sec-" + name);
      if (panel) panel.hidden = name !== activeQueue;
      const button = $("db-queue-" + name);
      if (button) button.setAttribute("aria-pressed", String(name === activeQueue));
    }
    const note = $("db-queue-guidance");
    if (note) note.textContent = NOTES[key];
  }

  function updateQueues(sections) {
    // On first load, show the highest-priority non-empty lane. Never
    // silently steal a manually selected lane on subsequent refreshes.
    if (!queueTouched) {
      const first = QUEUES.find(key => Number(sections?.[key]?.total) > 0) || "click";
      showQueue(first);
    } else {
      showQueue(activeQueue);
    }
    const count = Number(sections?.[activeQueue]?.total) || 0;
    const label = {
      click: "リード・未対応", replied: "返信あり",
      follow: "今日フォロー", attack: "アタック候補",
    }[activeQueue];
    const focus = $("db-focus-label");
    if (focus) focus.textContent = count
      ? `まずは「${label}」から。対象 ${count.toLocaleString("ja-JP")}社のうち上位3社を表示しています。`
      : `「${label}」は現在0件です。他の区分を選んでください。`;
  }

  function setup() {
    showView(queryView());
    showQueue("click");
    for (const view of VIEWS) {
      const tab = $("db-tab-" + view);
      if (!tab) continue;
      tab.addEventListener("click", () => showView(view, { writeUrl: true }));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const pos = VIEWS.indexOf(view);
        const to = event.key === "Home" ? 0 : event.key === "End" ? VIEWS.length - 1
          : (pos + (event.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length;
        showView(VIEWS[to], { writeUrl: true });
        $("db-tab-" + VIEWS[to])?.focus();
      });
    }
    // Event delegation survives the existing API.morph() redraws.
    $("sum")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-queue]");
      if (button && $("sum").contains(button)) showQueue(button.dataset.queue, { touched: true });
    });
    $("db-ranking-refresh")?.addEventListener("click", () => {
      if (authorized) window.SalesDashboardReport?.load();
    });
    $("db-merged-rankings")?.addEventListener("toggle", event => {
      if (event.target.open && authorized && !reportLoaded) {
        reportLoaded = true;
        window.SalesDashboardReport?.load();
      }
    });
    window.addEventListener("popstate", () => showView(queryView()));
  }

  setup();
  window.SalesDashboardTabs = {
    ready() {
      authorized = true;
      if (activeView === "analysis" || $("db-merged-rankings")?.open === true) showView(activeView);
    },
    currentQueue: () => activeQueue,
    currentView: () => activeView,
    periodChanged({loadVisible = true} = {}) {
      reportLoaded = false;
      if (loadVisible && authorized && (activeView === "analysis" || $("db-merged-rankings")?.open === true)) {
        reportLoaded = true;
        window.SalesDashboardReport?.load();
      }
    },
    updateQueues,
    selectView: (key) => showView(key, { writeUrl: true }),
  };
})();
