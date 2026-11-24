// Sales reads proposal outcomes; ENGER remains the place to confirm and update them.
window.SalesProposalCompanyAnalysis = (() => {
  "use strict";
  const ENDPOINT = "/api/sales/proposals/company-analysis";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DEFAULTS = { period: "all", q: "", service: "", owner: "", focus: "all", sort: "recent", page: 1, pageSize: 20, company: "" };
  const PERIODS = [["all", "全期間"], ["this_week", "今週"], ["last_week", "先週"], ["this_month", "今月"], ["last_month", "先月"]];
  const FOCUSES = [["all", "すべての企業"], ["passed", "合格・稼働実績あり"], ["loss", "見送りあり"], ["waiting", "進行中・結果待ち"], ["unlinked", "企業の紐付けを確認"]];
  const SORTS = [["recent", "最近の動き順"], ["sent", "送信件数順"], ["meeting", "面談実施件数順"], ["passed", "合格・稼働実績順"], ["company", "企業名順"]];
  const PHASES = { contact: "連絡前・連絡時", proposal: "提案後", interview: "面談後", unknown: "段階未確認" };
  const SIDES = { job: "案件側", company: "案件側", client: "案件側", talent: "人材側", candidate: "人材側", both: "双方", external: "外部要因", unknown: "確認先未確認" };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const text = value => value && typeof value === "object" ? String(value.label || value.name || "") : String(value ?? "");
  const num = value => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("ja-JP") : "—";
  const amount = value => typeof value === "number" && Number.isFinite(value) ? value : null;
  const percent = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(value) + "%" : "—";
  const errorText = (error, fallback) => {
    if (error?.status === 401) return "ログインの有効期限を確認できません。再ログインしてからお試しください。";
    if (error?.status === 403) return "この企業分析を閲覧する権限がありません。利用権限と所属を管理者に確認してください。";
    if (error?.status === 404) return "該当する企業の履歴を確認できませんでした。企業の紐付けや絞り込み条件を確認してください。";
    const message = error?.hint || error?.message;
    return message && !/^[a-z][a-z0-9_]*$/i.test(message) ? String(message) : fallback;
  };
  const day = (value, withTime = false) => {
    if (!value) return "日付未記録";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "日付未記録";
    return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(date);
  };
  const optionsHtml = (items, current) => items.map(([value, label]) => '<option value="' + esc(value) + '"' + (String(current) === String(value) ? " selected" : "") + ">" + esc(label) + "</option>").join("");
  const sourceHref = id => UUID.test(String(id || "")) ? "https://dx.enger.jp/proposals/" + encodeURIComponent(id) : null;
  const safeHref = (href, proposal) => {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      if (url.origin === "https://dx.enger.jp" && UUID.test(String(proposal.sourceProposalId || "")) &&
          url.pathname === "/proposals/" + proposal.sourceProposalId) return sourceHref(proposal.sourceProposalId);
      if ([window.location.origin, "https://gw.8grp.co.jp"].includes(url.origin) && url.pathname === "/sales/proposals.html" &&
          UUID.test(String(proposal.salesProposalId || "")) && url.searchParams.get("id") === proposal.salesProposalId) {
        return "/sales/proposals.html?id=" + encodeURIComponent(proposal.salesProposalId);
      }
    } catch {}
    return null;
  };
  let host = null, api = null, hooks = {}, state = { ...DEFAULTS }, data = null;
  let listSequence = 0, detailSequence = 0, timer = null, dialog = null;
  let selectedKey = "", selectedName = "", selectedTab = "proposals", selectedPage = 1, detailData = null, opener = null;

  function metric(label, numerator, denominator, rate, extra = "") {
    const d = amount(denominator);
    return '<div class="spca-metric"><span>' + esc(label) + '</span><strong>' + (d === 0 ? "—" : esc(percent(rate))) +
      '</strong><small>' + esc(num(numerator)) + " / " + esc(num(denominator)) + "件" +
      (d === 0 ? "・対象なし" : "") + "</small>" + (extra ? '<small class="spca-pending">' + esc(extra) + "</small>" : "") + "</div>";
  }
  function metricsHtml(company) {
    const m = company.metrics || {};
    return metric("送信 → 面談", m.meetings, m.sent, m.meetingRate) +
      metric("面談後の合格", m.passed, m.resultKnown, m.passRate) +
      metric("結果の確認", m.resultKnown, m.resultDue, m.resultCoverage,
        amount(m.resultPending) > 0 ? "結果待ち " + num(m.resultPending) + "件" : "");
  }
  function identityHtml(company) {
    if (!company.identity || company.identity.kind === "id") return "";
    return '<span class="spca-identity ' + (company.identity.kind === "name" ? "" : "spca-identity-warn") + '">' +
      esc(company.identity.label || (company.identity.kind === "name" ? "企業名で照合" : "企業の紐付けを確認")) + "</span>";
  }
  function historyHtml(company, expanded = false) {
    const h = company.history || {};
    const cells = [["合格", h.passed], ["稼働・受注", h.won], ["見送り", h.lost]];
    if (expanded) cells.unshift(["提案", h.total], ["進行中", h.active]);
    return '<div class="spca-history-values">' + cells.map(([label, count]) =>
      "<span>" + esc(label) + " <b>" + esc(num(count)) + "</b>件</span>").join("") + "</div>";
  }
  function causePreview(company) {
    const causes = Array.isArray(company.causes) ? company.causes.slice(0, 2) : [];
    const reason = causes.length ? causes.map(c => esc(c.label || "理由未確認") + " " + esc(num(c.count)) + "件").join("・") : "見送り理由の記録なし";
    return '<span class="spca-cause-preview">' + reason + "</span>" +
      (company.next?.label ? '<small class="spca-next-preview">' + esc(company.next.label) + "</small>" : "");
  }
  function companyHeading(company, index) {
    return '<button class="spca-company-name" type="button" data-spca-action="open" data-index="' + index + '">' + esc(company.name || "企業名未登録") + "</button>" +
      '<div class="spca-company-meta">' + identityHtml(company) +
      (amount(company.history?.active) > 0 ? '<span>進行中 ' + esc(num(company.history.active)) + "件</span>" : "") + "</div>" +
      (company.latest ? '<small class="spca-latest">' + esc(day(company.latest.at)) + "・" + esc(company.latest.label || "履歴あり") + "</small>" : '<small class="spca-latest">履歴の日付未記録</small>');
  }
  function renderCompanies(companies) {
    if (!companies.length) return '<div class="spca-empty">条件に合う企業がありません。期間や絞り込み条件を変えてください。</div>';
    const rows = companies.map((company, index) => '<tr data-company-index="' + index + '">' +
      "<td>" + companyHeading(company, index) + "</td>" +
      metricsHtml(company).replaceAll('<div class="spca-metric">', '<td><div class="spca-metric">').replaceAll("</div>", "</div></td>") +
      '<td><span class="spca-small-label">全履歴</span>' + historyHtml(company) + "</td>" +
      "<td>" + causePreview(company) + "</td></tr>").join("");
    const cards = companies.map((company, index) => '<article class="spca-company-card" data-company-index="' + index + '">' +
      '<header>' + companyHeading(company, index) + '</header><div class="spca-card-metrics">' + metricsHtml(company) + "</div>" +
      '<div class="spca-card-history"><span class="spca-small-label">全履歴</span>' + historyHtml(company) + "</div>" +
      '<div class="spca-card-cause">' + causePreview(company) + "</div></article>").join("");
    return '<div class="spca-table-wrap"><table class="sl-table spca-table"><thead><tr><th>提案先の企業</th><th>送信 → 面談</th><th>面談後の合格</th><th>結果の確認</th><th>過去の結果</th><th>主な見送り理由・確認事項</th></tr></thead><tbody>' +
      rows + '</tbody></table></div><div class="spca-company-cards">' + cards + "</div>";
  }
  function pager(pagination, detail = false) {
    const p = pagination || {};
    const page = amount(p.page) || 1, pages = amount(p.pages) || 1, total = amount(p.total) || 0, size = amount(p.pageSize) || 20;
    if (!total) return "";
    const first = (page - 1) * size + 1, last = Math.min(page * size, total);
    return '<nav class="spca-pagination" aria-label="' + (detail ? "企業の提案履歴" : "企業一覧") + 'のページ切替"><span>' +
      esc(num(total)) + (detail ? "件" : "社") + "中 " + esc(num(first)) + "–" + esc(num(last)) + (detail ? "件" : "社") + '</span><div><button type="button" data-spca-action="' +
      (detail ? "detail-page" : "page") + '" data-page="' + (page - 1) + '"' + (page <= 1 ? " disabled" : "") + '>前へ</button><span>' + esc(num(page)) + " / " + esc(num(pages)) +
      '</span><button type="button" data-spca-action="' + (detail ? "detail-page" : "page") + '" data-page="' + (page + 1) + '"' + (page >= pages ? " disabled" : "") + ">次へ</button></div></nav>";
  }
  function coverageHtml(current) {
    const status = current.dataStatus || {}, notes = Array.isArray(status.notes) ? status.notes : [];
    const unavailable = status.engerAvailable === false;
    if (!unavailable && !notes.length) return "";
    return '<aside class="spca-coverage' + (unavailable ? " spca-coverage-warn" : "") + '">' +
      (unavailable ? '<p>ENGERの履歴を取得できていないため、確認できる記録の範囲を表示しています。</p>' : "") +
      (notes.length ? '<details' + (unavailable ? " open" : "") + '><summary>集計の対象・確認事項（' + notes.length + "）</summary><ul>" +
        notes.map(note => "<li>" + esc(text(note)) + "</li>").join("") + "</ul></details>" : "") + "</aside>";
  }
  function renderResults() {
    if (!host || !data) return;
    const summary = data.summary || {}, companies = Array.isArray(data.companies) ? data.companies : [];
    const cards = [["提案先の企業", summary.companies, "社", "検索・担当条件の範囲"], ["送信確認", summary.sent, "件", data.period?.label || "選択した期間"],
      ["過去の合格", summary.passed, "件", "送信日が不明な過去の合格も含む"], ["結果待ち", summary.resultPending, "件", "選択した送信期間の面談"]];
    host.querySelector(".spca-summary").innerHTML = cards.map(([label, value, unit, note]) =>
      '<div><span>' + esc(label) + '</span><strong>' + esc(num(value)) + "<small>" + unit + '</small></strong><small>' + esc(note) + "</small></div>").join("");
    host.querySelector(".spca-results").innerHTML = coverageHtml(data) + renderCompanies(companies) + pager(data.pagination);
    host.querySelector(".spca-period-note").innerHTML = '<strong>' + esc(data.period?.label || "全期間") + '</strong>に送信日を確認できる提案の、その後の実績です。合格率は合否判明分、結果確認率は面談実施分で集計します。' +
      (amount(summary.unknownSent) > 0 ? '<span>送信日未確認 ' + esc(num(summary.unknownSent)) + "件は、率の集計から外して全履歴に表示しています。</span>" : "");
    host.querySelector(".spca-observed").textContent = data.dataStatus?.observedAt ? "確認時点：" + day(data.dataStatus.observedAt, true) : "";
    const serviceOptions = (data.filters?.services || []).map(item => {
      const value = typeof item === "string" ? item : item.key || item.value || item.id;
      return [value, value === "unknown" ? "事業未確認" : typeof item === "string" ? item : item.label || item.name || value];
    });
    const ownerOptions = (data.filters?.owners || []).map(item => [item.id, item.name]);
    host.querySelector('[data-spca-filter="service"]').innerHTML = optionsHtml([["", "すべて"], ...serviceOptions], state.service);
    host.querySelector('[data-spca-filter="owner"]').innerHTML = optionsHtml([["", "すべて"], ["me", "自分"], ["none", "担当未割当"], ...ownerOptions.filter(([id]) => !["", "me", "none", "all"].includes(id))], state.owner);
    host.querySelector(".spca-count").textContent = num(data.pagination?.total ?? summary.companies) + "社";
  }
  function emitState() {
    if (typeof hooks.onStateChange === "function") hooks.onStateChange({ ...state });
  }
  function query(params) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== "" && value !== null && value !== undefined) qs.set(key, String(value));
    return ENDPOINT + "?" + qs;
  }
  function currentParams(extra = {}) { return { ...state, ...extra }; }
  async function load(params = {}) {
    if (!host) throw new Error("企業分析の表示先がありません。");
    clearTimeout(timer);
    for (const key of Object.keys(DEFAULTS)) if (Object.hasOwn(params, key)) state[key] = params[key];
    for (const control of host.querySelectorAll("[data-spca-filter]")) control.value = String(state[control.dataset.spcaFilter] ?? "");
    const seq = ++listSequence;
    host.setAttribute("aria-busy", "true");
    host.querySelector(".spca-load-state").textContent = "企業ごとの提案結果を確認しています…";
    if (!data) host.querySelector(".spca-results").innerHTML = '<div class="spca-empty">企業ごとの提案結果を確認しています…</div>';
    emitState();
    try {
      const { company: requestedCompany, ...listParams } = currentParams();
      const response = await api(query(listParams));
      if (seq !== listSequence) return;
      if (!Array.isArray(response?.companies) || !response?.summary || !response?.pagination) throw new Error("企業分析のデータを確認できませんでした。");
      data = response;
      renderResults();
      host.querySelector(".spca-load-state").textContent = "";
      if (requestedCompany && state.company === requestedCompany) await openCompany(requestedCompany, { page: selectedPage, tab: selectedTab });
    } catch (error) {
      if (seq !== listSequence) return;
      data = null;
      host.querySelector(".spca-summary").replaceChildren();
      host.querySelector(".spca-count").textContent = "";
      host.querySelector(".spca-period-note").textContent = "";
      host.querySelector(".spca-observed").textContent = "";
      host.querySelector(".spca-results").innerHTML = '<div class="spca-error" role="alert"><strong>企業分析を表示できませんでした</strong><p>' +
        esc(errorText(error, "しばらくしてから再度お試しください。")) + '</p><button type="button" data-spca-action="retry">再読み込み</button></div>';
      host.querySelector(".spca-load-state").textContent = "";
    } finally { if (seq === listSequence) host.setAttribute("aria-busy", "false"); }
  }
  function proposalLink(proposal, label = "ENGERで確認") {
    const href = safeHref(proposal.href, proposal);
    if (proposal.source === "enger" && href) return '<a class="spca-source-link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '<span aria-hidden="true"> ↗</span></a>';
    if (proposal.source === "sales" && UUID.test(String(proposal.salesProposalId || ""))) {
      if (typeof hooks.onOpenProposal === "function") return '<button class="spca-source-link" type="button" data-spca-action="manual" data-proposal="' + esc(proposal.salesProposalId) + '">Salesの記録を確認</button>';
      if (href) return '<a class="spca-source-link" href="' + esc(href) + '">Salesの記録を確認</a>';
    }
    return '<span class="spca-unlinked">確認先の連携を確認</span>';
  }
  function nextHtml(company) {
    if (!company.next?.label) return "";
    const href = sourceHref(company.next.sourceProposalId);
    const manual = !href && UUID.test(String(company.next.salesProposalId || "")) ? proposalLink({
      source: "sales", salesProposalId: company.next.salesProposalId, href: "/sales/proposals.html?id=" + encodeURIComponent(company.next.salesProposalId),
    }) : "";
    return '<aside class="spca-next"><div><strong>' + esc(company.next.label) + "</strong>" +
      (company.next.detail ? "<p>" + esc(company.next.detail) + "</p>" : "") + "</div>" +
      (href ? '<a class="spca-source-link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">ENGERで確認 ↗</a>' : manual) + "</aside>";
  }
  function proposalList(company) {
    const proposals = Array.isArray(company.proposals) ? company.proposals : [];
    if (!proposals.length) return '<div class="spca-empty">この企業の提案履歴はありません。</div>';
    return '<p class="spca-panel-note">送付・合否・見送り理由は提案元の画面で確認します。ENGERと連携した提案には、確認リンクを表示しています。</p><div class="spca-proposal-list">' + proposals.map(proposal => {
      const priorLoss = proposal.lossIsCurrent === false && [proposal.lossReason, proposal.lossPhase, proposal.lossSide, proposal.lossDetail]
        .some(value => text(value) && !["未確認", "記録なし"].includes(text(value)));
      return '<details class="spca-proposal"><summary><div><strong>' + esc(proposal.jobTitle || "案件名未登録") + '</strong><span>' + esc(proposal.talentName || "人材名未登録") +
      '・' + esc(proposal.currentStage || proposal.resultLabel || "状態未確認") + '</span></div><small>' + (proposal.sentAt ? "送信 " + esc(day(proposal.sentAt)) : "送信日未確認") +
      '</small></summary><div class="spca-proposal-body">' +
      (priorLoss ? '<p class="spca-panel-note">現在の状態は「' + esc(proposal.currentStage || "未確認") + '」です。見送りの理由・段階・側は過去の記録です。</p>' : "") + "<dl>" +
      [["提案日", proposal.proposedAt ? day(proposal.proposedAt) : "未確認"], ["面談", proposal.meetingLabel || "実施状況未確認"], ["結果", proposal.resultLabel || "未確認"],
        ["担当", proposal.ownerName || "未割当"],
        ...(proposal.identity && proposal.identity.kind !== "id" ? [["企業の照合", proposal.identity.label || (proposal.identity.kind === "name" ? "企業名で照合" : "企業の紐付けを確認")]] : []),
        [priorLoss ? "過去の見送り理由" : "見送り理由", text(proposal.lossReason) || "記録なし"],
        [priorLoss ? "過去の見送り段階" : "見送りの段階", PHASES[text(proposal.lossPhase)] || text(proposal.lossPhase) || "未確認"],
        [priorLoss ? "過去の見送りの側" : "見送りの側", SIDES[text(proposal.lossSide)] || text(proposal.lossSide) || "未確認"]]
        .map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl>" +
      (proposal.lossDetail ? '<p class="spca-loss-detail">' + esc(proposal.lossDetail) + "</p>" : "") +
      '<div class="spca-proposal-foot">' + proposalLink(proposal) + (proposal.unknownSent ? "<small>送信日未確認のため、率の集計には含めていません。</small>" : "") + "</div></div></details>"
    }).join("") + "</div>" + pager(company.detailPagination, true);
  }
  function breakdown(title, items, empty) {
    const values = Array.isArray(items) ? items : [];
    const max = Math.max(1, ...values.map(item => amount(item.count) || 0));
    return '<section class="spca-breakdown"><h3>' + esc(title) + "</h3>" + (values.length ?
      '<ul>' + values.map(item => '<li><span>' + esc(item.label || "未確認") + '</span><b>' + esc(num(item.count)) +
        '件</b><div class="spca-bar" aria-hidden="true"><span style="width:' + Math.min(100, Math.max(0, (amount(item.count) || 0) * 100 / max)) + '%"></span></div></li>').join("") + "</ul>" :
      '<p class="spca-panel-note">' + esc(empty) + "</p>") + "</section>";
  }
  function causeList(company) {
    return '<p class="spca-panel-note">記録された理由・段階・確認先を分けて表示しています。記録のない原因は推測していません。</p><div class="spca-breakdowns">' +
      breakdown("なぜ見送りになったか", company.causes, "見送り理由の記録はありません。") +
      breakdown("どの段階で止まったか", company.phases, "見送りの段階は記録されていません。") +
      breakdown("どちら側の理由か", company.sides, "見送りの側は記録されていません。") + "</div>" +
      '<p class="spca-panel-note">個別の理由や補足は「提案履歴」で確認できます。</p>';
  }
  function interactionList(company) {
    const interactions = Array.isArray(company.interactions) ? company.interactions : [];
    const total = amount(company.interactionsTotal), limited = company.interactionsLimited || (total !== null && total > interactions.length);
    if (!interactions.length) return '<div class="spca-empty">この企業の提案に紐づくやり取りはありません。</div>';
    return '<p class="spca-panel-note">提案に紐づく履歴を新しい順に表示しています。' +
      (limited || interactions.length >= 30 ? "直近" + esc(num(interactions.length)) + "件を表示しています。" : "") +
      '</p><div class="spca-interactions">' + interactions.map(item => {
        const href = sourceHref(item.sourceProposalId);
        return '<details class="spca-interaction"><summary><time>' + esc(day(item.at, true)) + "</time><strong>" + esc(item.label || "活動記録") +
          '</strong></summary><div>' + (item.detail ? '<p>' + esc(item.detail) + "</p>" : '<p class="spca-panel-note">補足の記録はありません。</p>') +
          (href ? '<a class="spca-source-link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">ENGERの提案を確認 ↗</a>' : "") + "</div></details>";
      }).join("") + "</div>";
  }
  function dialogHeader() {
    return '<header class="spca-dialog-head"><div><span class="spca-small-label">企業別の提案分析</span><h2 id="spca-dialog-title">' +
      esc(selectedName || "企業の分析") + '</h2></div><button class="spca-close" type="button" data-spca-action="close" aria-label="企業分析を閉じる">×</button></header>';
  }
  function renderDetail() {
    const company = detailData;
    if (!company || !dialog) return;
    selectedName = company.name || selectedName;
    const tabs = [["proposals", "提案履歴"], ["causes", "見送り理由"], ["interactions", "やり取り"]];
    dialog.innerHTML = dialogHeader() + '<div class="spca-dialog-summary">' + identityHtml(company) +
      '<div class="spca-detail-metrics">' + metricsHtml(company) + '</div><p class="spca-panel-note">率は' + esc(data?.period?.label || "選択した送信期間") +
      'の送信確認分です。過去の結果は下の全履歴で確認できます。</p><details class="spca-all-history"><summary>全履歴：合格 ' +
      esc(num(company.history?.passed)) + '件・稼働／受注 ' + esc(num(company.history?.won)) + '件</summary>' +
      historyHtml(company, true) + (amount(company.history?.unknownSent) > 0 ? '<p class="spca-panel-note">送信日未確認 ' + esc(num(company.history.unknownSent)) +
      "件も全履歴に含めています。</p>" : "") + "</details></div>" +
      '<div class="spca-tabs" role="tablist" aria-label="企業分析の内容">' + tabs.map(([key, label]) =>
        '<button type="button" role="tab" id="spca-tab-' + key + '" aria-controls="spca-panel-' + key + '" aria-selected="' + (selectedTab === key) +
        '" tabindex="' + (selectedTab === key ? "0" : "-1") + '" data-spca-tab="' + key + '">' + label + "</button>").join("") + "</div>" +
      '<div class="spca-dialog-scroll">' + nextHtml(company) + tabs.map(([key]) => '<section id="spca-panel-' + key + '" role="tabpanel" aria-labelledby="spca-tab-' + key + '"' +
        (selectedTab === key ? "" : " hidden") + ">" + (key === "proposals" ? proposalList(company) : key === "causes" ? causeList(company) : interactionList(company)) + "</section>").join("") + "</div>";
  }
  async function openCompany(key, { page = 1, tab = "proposals", trigger = null } = {}) {
    if (!key || !dialog) return;
    const isNew = selectedKey !== key || !dialog.open;
    if (isNew) {
      opener = trigger || document.activeElement;
      selectedName = (data?.companies || []).find(company => company.key === key)?.name || "企業の分析";
    }
    selectedKey = key; selectedPage = page; selectedTab = tab;
    state.company = key;
    emitState();
    const seq = ++detailSequence;
    dialog.innerHTML = dialogHeader() + '<div class="spca-dialog-scroll"><p class="spca-empty" role="status">提案履歴と見送り理由を確認しています…</p></div>';
    if (!dialog.open) dialog.showModal();
    dialog.setAttribute("aria-busy", "true");
    try {
      const response = await api(query(currentParams({ company: key, page })));
      if (seq !== detailSequence || !dialog.open) return;
      if (!response?.company || response.company.key !== key) throw new Error("この企業の履歴を確認できませんでした。");
      detailData = response.company;
      renderDetail();
      if (isNew) dialog.querySelector(".spca-close")?.focus();
    } catch (error) {
      if (seq !== detailSequence || !dialog.open) return;
      dialog.innerHTML = dialogHeader() + '<div class="spca-dialog-scroll"><div class="spca-error" role="alert"><strong>企業の履歴を表示できませんでした</strong><p>' +
        esc(errorText(error, "再度お試しください。")) + '</p><button type="button" data-spca-action="detail-retry">再読み込み</button></div></div>';
    } finally { if (seq === detailSequence) dialog.setAttribute("aria-busy", "false"); }
  }
  function selectTab(key, focus = false) {
    if (!["proposals", "causes", "interactions"].includes(key)) return;
    selectedTab = key;
    for (const button of dialog.querySelectorAll("[data-spca-tab]")) {
      const selected = button.dataset.spcaTab === key;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    for (const panel of dialog.querySelectorAll('[role="tabpanel"]')) panel.hidden = panel.id !== "spca-panel-" + key;
  }
  function close(notify = true) {
    detailSequence++;
    if (state.company) {
      state.company = "";
      if (notify) emitState();
    }
    if (dialog?.open) dialog.close();
  }
  function onClick(event) {
    const tab = event.target.closest("[data-spca-tab]");
    if (tab) { selectTab(tab.dataset.spcaTab); return; }
    const target = event.target.closest("[data-spca-action]");
    const action = target?.dataset.spcaAction;
    if (action === "close") { close(); return; }
    if (action === "retry") { load(); return; }
    if (action === "detail-retry") { openCompany(selectedKey, { page: selectedPage, tab: selectedTab }); return; }
    if (action === "page") { load({ page: Number(target.dataset.page) }); return; }
    if (action === "detail-page") { openCompany(selectedKey, { page: Number(target.dataset.page), tab: selectedTab }); return; }
    if (action === "manual") {
      const id = target.dataset.proposal;
      if (UUID.test(id) && typeof hooks.onOpenProposal === "function") { close(); hooks.onOpenProposal(id); }
      return;
    }
    if (action === "open") {
      const company = data?.companies?.[Number(target.dataset.index)];
      if (company) openCompany(company.key, { trigger: target });
      return;
    }
    if (event.target.closest("a,button,input,select,summary")) return;
    const row = event.target.closest("[data-company-index]");
    if (row && host?.contains(row)) {
      const company = data?.companies?.[Number(row.dataset.companyIndex)];
      if (company) openCompany(company.key, { trigger: row.querySelector(".spca-company-name") });
    }
  }
  function onTabKey(event) {
    const target = event.target.closest("[data-spca-tab]");
    if (!target || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const keys = ["proposals", "causes", "interactions"], index = keys.indexOf(target.dataset.spcaTab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length;
    event.preventDefault(); selectTab(keys[next], true);
  }
  function onFilterChange(event) {
    const key = event.target.dataset.spcaFilter;
    if (!Object.hasOwn(DEFAULTS, key) || key === "q") return;
    load({ [key]: event.target.value, page: 1 });
  }
  function onSearch(event) {
    if (event.target.dataset.spcaFilter !== "q") return;
    clearTimeout(timer);
    const value = event.target.value;
    timer = setTimeout(() => load({ q: value, page: 1 }), 250);
  }
  function mount(element, options = {}) {
    close(false);
    clearTimeout(timer);
    listSequence++;
    if (host) {
      host.removeEventListener("click", onClick);
      host.removeEventListener("change", onFilterChange);
      host.removeEventListener("input", onSearch);
    }
    dialog?.remove();
    host = typeof element === "string" ? document.querySelector(element) : element;
    if (!host) throw new Error("企業分析の表示先がありません。");
    hooks = options;
    api = typeof options.api === "function" ? options.api : window.API?.api?.bind(window.API);
    if (!api) throw new Error("企業分析のデータ取得機能を利用できません。");
    state = { ...DEFAULTS }; data = null; detailData = null; selectedKey = ""; selectedTab = "proposals";
    host.classList.add("spca");
    host.innerHTML = '<div class="spca-heading"><div><h2>企業ごとの提案結果</h2><p>どの企業に提案し、面談・合格につながったかを履歴から確認します。</p></div><span class="spca-count"></span></div>' +
      '<div class="spca-summary" aria-label="企業別の実績概要"></div><div class="spca-tools">' +
      '<label class="spca-search"><span>企業・案件・人材を検索</span><input type="search" data-spca-filter="q" placeholder="企業名・案件名・人材名"></label>' +
      '<label><span>送信した期間</span><select data-spca-filter="period">' + optionsHtml(PERIODS, state.period) + "</select></label>" +
      '<label><span>絞り込み</span><select data-spca-filter="focus">' + optionsHtml(FOCUSES, state.focus) + "</select></label>" +
      '<label><span>並び順</span><select data-spca-filter="sort">' + optionsHtml(SORTS, state.sort) + "</select></label></div>" +
      '<details class="spca-extra"><summary>サービス・担当で絞り込む</summary><div><label><span>サービス</span><select data-spca-filter="service"><option value="">すべて</option></select></label>' +
      '<label><span>担当</span><select data-spca-filter="owner"><option value="">すべて</option></select></label></div></details>' +
      '<p class="spca-period-note"></p><p class="spca-load-state" role="status" aria-live="polite"></p><div class="spca-results"></div><p class="spca-observed"></p>';
    host.addEventListener("click", onClick);
    host.addEventListener("change", onFilterChange);
    host.addEventListener("input", onSearch);
    dialog = document.createElement("dialog");
    dialog.className = "spca-dialog";
    dialog.setAttribute("aria-labelledby", "spca-dialog-title");
    dialog.addEventListener("click", event => { if (event.target === dialog) close(); else onClick(event); });
    dialog.addEventListener("keydown", onTabKey);
    dialog.addEventListener("cancel", () => { detailSequence++; });
    const mountedDialog = dialog;
    dialog.addEventListener("close", () => {
      if (dialog !== mountedDialog) return;
      if (state.company) { state.company = ""; emitState(); }
      if (opener?.isConnected) opener.focus();
    });
    document.body.append(dialog);
    return window.SalesProposalCompanyAnalysis;
  }
  return { mount, load, refresh: () => load(), close };
})();
