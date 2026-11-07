/* Sales dashboard meeting launcher. Read-only until the Sales company detail is opened. */
(() => {
  "use strict";
  const dialog = document.getElementById("db-meeting-dialog");
  if (!dialog) return;
  const $ = id => document.getElementById(id);
  const input = $("db-meeting-search");
  const segment = $("db-meeting-segment");
  const results = $("db-meeting-results");
  const status = $("db-meeting-status");
  const previous = $("db-meeting-prev");
  const next = $("db-meeting-next");
  let page = 1;
  let sequence = 0;
  let timer = null;
  let restoreFocus = null;

  const setStatus = message => { status.textContent = message; };
  const text = (tag, value, className = "") => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = String(value == null ? "" : value);
    return el;
  };

  const companyLink = r => {
    if (r.companyId) {
      const params = new URLSearchParams({
        companyId: r.companyId,
        meeting: r.blocked ? "info" : "prep"
      });
      return "/sales/company-segments.html?" + params.toString();
    }
    return r.salesId ? "/sales/companies.html?id=" + encodeURIComponent(r.salesId) : "";
  };

  function render(rows) {
    results.replaceChildren();
    if (!rows.length) {
      results.append(text("p", "該当する企業がありません。検索条件や区分を変更してください。", "db-meeting-empty"));
      return;
    }
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "db-meeting-result";
      const details = document.createElement("div");
      details.className = "db-meeting-result-info";
      details.append(text("strong", r.name || "企業名未登録"));
      const labels = [];
      if (r.statusLabel) labels.push(r.statusLabel);
      if (r.owner) labels.push("担当：" + r.owner);
      if (r.lastContact) labels.push("最終接点：" + String(r.lastContact).slice(0, 10));
      details.append(text("small", labels.join(" ／ ") || "企業情報を確認してください。"));
      if (!r.companyId) details.append(text("small", "ENGER企業ID未連携：商談準備は使用できません。", "db-meeting-warn"));
      if (r.blocked) details.append(text("small", "NG・連絡先の要確認あり。先に企業情報を確認してください。", "db-meeting-warn"));
      const link = companyLink(r);
      if (link) {
        const action = document.createElement("a");
        action.href = link;
        action.className = "db-meeting-go";
        action.textContent = r.companyId && !r.blocked ? "商談準備へ" : "企業情報を確認";
        action.setAttribute("aria-label", String(r.name || "企業") + "の" + action.textContent);
        row.append(details, action);
      } else {
        row.append(details, text("span", "操作不可", "db-meeting-unavailable"));
      }
      results.append(row);
    }
  }

  async function load() {
    const n = ++sequence;
    const params = new URLSearchParams({
      segment: segment.value,
      q: input.value.trim().slice(0, 100),
      page: String(page),
      sort: "name",
      direction: "asc"
    });
    previous.disabled = next.disabled = true;
    setStatus("企業リストを検索中…");
    results.replaceChildren();
    try {
      const data = await API.api("/api/sales/company-lifecycle?" + params.toString());
      if (n !== sequence || !dialog.open) return;
      if (!data.complete || !Array.isArray(data.rows) || !Number.isFinite(Number(data.selectedCount))) {
        throw Error("企業リストの完全性を確認できませんでした。");
      }
      render(data.rows);
      const count = Number(data.selectedCount);
      $("db-meeting-page").textContent = count ? (page + " / " + Math.max(1, Math.ceil(count / 50)) + "ページ") : "0件";
      previous.disabled = page <= 1;
      next.disabled = page * 50 >= count;
      setStatus(count.toLocaleString("ja-JP") + "社が該当します。企業を選ぶとSalesの商談画面へ進みます。");
    } catch (error) {
      if (n !== sequence || !dialog.open) return;
      results.append(text("p", error?.hint || "企業リストを取得できませんでした。ログイン状態を確認して再検索してください。", "db-meeting-empty"));
      $("db-meeting-page").textContent = "未取得";
      setStatus("企業リストを取得できませんでした。");
    }
  }

  function open() {
    if (dialog.open) return;
    restoreFocus = document.activeElement;
    page = 1;
    input.value = "";
    segment.value = "all";
    dialog.showModal();
    input.focus();
    void load();
  }

  document.querySelectorAll("[data-meeting-launch]").forEach(button => button.addEventListener("click", open));
  $("db-meeting-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    sequence++;
    clearTimeout(timer);
    if (restoreFocus?.isConnected) restoreFocus.focus();
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    page = 1;
    timer = setTimeout(() => void load(), 300);
  });
  segment.addEventListener("change", () => { page = 1; void load(); });
  $("db-meeting-search-form").addEventListener("submit", e => {
    e.preventDefault();
    clearTimeout(timer);
    page = 1;
    void load();
  });
  previous.addEventListener("click", () => { if (page > 1) { page--; void load(); } });
  next.addEventListener("click", () => { page++; void load(); });
})();
