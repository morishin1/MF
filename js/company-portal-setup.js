(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let selectedCompany = null;
  let detail = null;
  function notice(value, ok) {
    const node = $("notice");
    node.textContent = value;
    node.className = ok === false ? "cp-alert" : ok === true ? "cp-ok" : "cp-muted";
  }
  function create(tag, value, className) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function field(title, value, kind) {
    const wrap = create("div");
    const label = create("label", title);
    const input = kind === "summary" ? document.createElement("textarea") : document.createElement("input");
    if (kind !== "summary") input.type = kind === "url" ? "url" : "text";
    input.className = "cp-input";
    input.value = value || "";
    input.maxLength = kind === "summary" ? 2000 : kind === "url" ? 1500 : 160;
    wrap.append(label, input);
    return { wrap, input };
  }
  async function call(path, method, data) {
    return window.API.api(path, { method: method || "GET", ...(data ? { body: data } : {}) });
  }
  async function search() {
    const query = $("searchCompany").value.trim();
    if (query.length < 2) { notice("2文字以上で検索してください", false); return; }
    try {
      const result = await call("/api/company-portal/manage?q=" + encodeURIComponent(query));
      const root = $("searchResults");
      root.replaceChildren();
      for (const company of result.companies || []) {
        const button = create("button", company.name, "cp-btn");
        button.type = "button";
        button.addEventListener("click", () => load(company.id));
        root.append(button);
      }
      if (!result.companies?.length) root.append(create("p", "該当企業がありません", "cp-muted"));
    } catch (error) { notice(error.message, false); }
  }
  function displayAccounts(accounts) {
    const root = $("accounts");
    root.replaceChildren();
    if (!accounts.length) return;
    root.append(create("h3", "発行済みアカウント", "cp-section-title"));
    for (const account of accounts) {
      const row = create("div", undefined, "cp-topline");
      row.style.padding = "7px 0";
      row.append(create("span", account.email + (account.active ? " · 利用中" : " · 停止中"), "cp-muted"));
      if (account.active) {
        const stop = create("button", "利用停止", "cp-btn small");
        stop.type = "button";
        stop.addEventListener("click", async () => {
          if (!confirm("このアカウントの商談ページの利用を停止しますか？")) return;
          try {
            await call("/api/company-portal/manage", "POST", {
              action: "disable", companyId: selectedCompany, accessId: account.id,
            });
            await load(selectedCompany);
            notice("利用を停止しました", true);
          } catch (error) { notice(error.message, false); }
        });
        row.append(stop);
      }
      root.append(row);
    }
  }
  function displayShares() {
    const root = $("shareList");
    root.replaceChildren();
    const shares = new Map((detail.shares || [])
      .filter((share) => share.active).map((share) => [share.proposal_id, share]));
    for (const proposal of detail.proposals || []) {
      const saved = shares.get(proposal.id);
      const card = create("article", undefined, "cp-setup-item");
      const label = create("label", undefined, "cp-check");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = Boolean(saved);
      label.append(check, create("span", proposal.job_title || proposal.title));
      card.append(label);
      card.append(create("div", "Sales内部のタイトル：" + proposal.title + " / " + (proposal.service || "未設定"), "cp-muted"));
      const publicTitle = field("企業向けタイトル", saved?.public_title || proposal.job_title || "ご提案", "text");
      const summary = field("企業向けサマリー", saved?.public_summary || "", "summary");
      const documentUrl = field("公開資料URL（https:// のみ・任意）", saved?.document_url || "", "url");
      card.append(publicTitle.wrap, summary.wrap, documentUrl.wrap);
      card.values = () => check.checked ? {
        proposalId: proposal.id, title: publicTitle.input.value.trim(),
        summary: summary.input.value.trim(), documentUrl: documentUrl.input.value.trim(),
      } : null;
      root.append(card);
    }
    if (!detail.proposals?.length) root.append(create("p",
      "この企業に紐づく提案がありません。先にSalesで企業と提案を結び付けてください。", "cp-muted"));
  }
  async function load(id) {
    notice("企業情報を取得しています…");
    try {
      const data = await call("/api/company-portal/manage?companyId=" + encodeURIComponent(id));
      selectedCompany = id;
      detail = data;
      $("companyHeading").textContent = data.company.name;
      $("settings").hidden = false;
      displayShares();
      displayAccounts(data.accounts || []);
      notice("公開する提案を選択し、企業向けの文言をご確認ください");
      history.replaceState(null, "", "/sales/portal-setup.html?companyId=" + encodeURIComponent(id));
    } catch (error) { notice(error.message, false); }
  }
  $("searchButton").addEventListener("click", search);
  $("searchCompany").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); search(); }
  });
  $("issueForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedCompany) return;
    $("issueButton").disabled = true;
    try {
      const result = await call("/api/company-portal/manage", "POST", {
        action: "issue", companyId: selectedCompany, email: $("issueEmail").value.trim(),
      });
      await load(selectedCompany);
      const root = $("credentials");
      root.hidden = false;
      root.replaceChildren();
      root.append(create("strong", "ログイン発行完了"), create("p", "メール：" + result.email));
      if (result.temporaryPassword) {
        root.append(create("p", "仮パスワード（今回のみ表示）"));
        root.append(create("code", result.temporaryPassword));
        root.append(create("p", "相手に安全な方法でお伝えください。初回ログイン時に変更が必要です。", "cp-muted"));
      } else {
        root.append(create("p", "既存ユーザーに利用権限を付与しました。既存のパスワードをご利用ください。"));
      }
      notice("企業ログインを発行しました", true);
    } catch (error) { notice(error.message, false); }
    finally { $("issueButton").disabled = false; }
  });
  $("saveShares").addEventListener("click", async () => {
    if (!selectedCompany) return;
    const items = [...document.querySelectorAll(".cp-setup-item")]
      .map((node) => node.values?.()).filter(Boolean);
    $("saveShares").disabled = true;
    try {
      const result = await call("/api/company-portal/manage", "POST", {
        action: "publish", companyId: selectedCompany, items,
      });
      await load(selectedCompany);
      notice(result.publishedCount + "件を企業向けに公開しました", true);
    } catch (error) { notice(error.message, false); }
    finally { $("saveShares").disabled = false; }
  });
  (async () => {
    if (!window.API?.isLoggedIn()) { location.replace("/"); return; }
    const id = new URLSearchParams(location.search).get("companyId");
    if (id) await load(id);
  })();
})();
