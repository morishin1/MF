(() => {
  const destinationUrl = "https://enger.jp/business";
  const enger = [
    {
      key: "enger-partner", name: "ENGER（SES・SIer向け）", service: "ENGER",
      subject: "IT人材・開発案件のご提案｜株式会社エイト",
      body: `{{company}}
ご担当者様

突然のご連絡失礼いたします。株式会社エイトの{{sender}}と申します。
当社はIT人材と開発案件をつなぐ「ENGER（エンジャー）」を運営しています。

開発メンバーをお探しの場合は、必要なスキルや稼働時期に合う人材を、所属エンジニアの参画先をお探しの場合は、ご希望に合う案件をご提案します。

「人材を探している」「案件を探している」のどちらかがございましたら、一言お返事いただけますと幸いです。

ENGERのご案内
{{url}}`,
    },
    {
      key: "enger-company", name: "ENGER（一般企業向け）", service: "ENGER",
      subject: "開発・DXを支援するIT人材のご提案｜株式会社エイト",
      body: `{{company}}
ご担当者様

突然のご連絡失礼いたします。株式会社エイトの{{sender}}と申します。
当社のIT人材サービス「ENGER（エンジャー）」では、システム開発やDXを進める企業に、必要なスキルや稼働時期に合うエンジニアをご提案しています。

開発の人手が足りない案件や、新しく立ち上げるプロジェクトがございましたら、必要なスキルや開始時期をお聞かせください。

ENGERのご案内
{{url}}`,
    },
  ].map(t => ({ ...t, id: null, destinationUrl }));
  const dialog = document.getElementById("quick-attack");
  const box = document.getElementById("qa-content");
  const status = document.getElementById("qa-status");
  const meter = document.getElementById("qa-meter");
  const title = document.getElementById("qa-title");
  const esc = SalesLayout.esc;
  let run;
  let current;
  let busy = false;
  let choices;
  let opener;

  function httpUrl(value) {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  }

  const eligible = c => c.attackReady && !c.lastFailedAt && Boolean(httpUrl(c.formUrl));
  const canAttempt = c => !c.hidden && !c.ngReason && !["lost", "excluded"].includes(c.status);
  const option = (value, title, active) => `<option value="${esc(value)}"${value === active ? " selected" : ""}>${esc(title)}</option>`;
  const button = (kind, label, primary = false) =>
    `<button type="button" data-qa="${kind}" class="btn ${primary ? "btn-primary" : "btn-secondary"}">${label}</button>`;
  const controls = html => `<div class="qa-controls">${html}</div>`;
  const companyUrl = id => `/sales/company-tools.html?attack=${encodeURIComponent(id)}`;

  // Keep explicitly assigned offers. ENGER is the default for unassigned/ENGER companies.
  function initialTemplate(company, available) {
    if (company.service && !/^enger$/i.test(company.service.trim())) {
      const matches = available.filter(t => t.service === company.service);
      return matches.length === 1 ? matches[0] : null;
    }
    const partner = /\b(?:SES|SIer|SIer系)\b|システムインテグレータ/i.test(
      [company.industry, ...(company.businessTypes || [])].filter(Boolean).join(" ").normalize("NFKC"),
    );
    return enger[partner ? 0 : 1];
  }

  function renderText(text, trackingUrl) {
    const { company, service } = current;
    const vars = { company: company.name, sender: run.sender, service, url: trackingUrl };
    return String(text || "").replace(/\{\{\s*(company|sender|url|service)\s*\}\}/g, (_, key) => vars[key] || "");
  }

  function loadTemplates() {
    return API.listSalesTemplates().then(r => (r.templates || [])
      .filter(t => !t.archived && t.body?.trim()).map(t => ({ ...t, key: t.id })), () => []);
  }

  function get(id) { return document.getElementById(id); }
  function message(text = "") { status.textContent = text; }
  function progress() { meter.textContent = `送信完了 ${run.sent}社 ／ 送信できず ${run.failed}社`; }

  function settings() {
    const { company, template, service, campaignId, detail } = current;
    const campaigns = detail.campaigns || [];
    return `<details class="qa-settings"${template ? "" : " open"}>
      <summary>設定を変更</summary>
      <label for="qa-template">テンプレート</label>
      <select id="qa-template">${option("", "営業文を選ぶ", template?.key || "")}
        ${choices.map(t => option(t.key, t.name, template?.key)).join("")}</select>
      <label for="qa-campaign">キャンペーン</label>
      <select id="qa-campaign">${option("", "なし", campaignId || "")}
        ${campaigns.map(c => option(c.id, c.name, campaignId)).join("")}
        ${campaignId && !campaigns.some(c => c.id === campaignId) ? option(campaignId, "現在のキャンペーン", campaignId) : ""}</select>
      <label for="qa-service">提案サービス</label>
      <input id="qa-service" value="${esc(service)}" maxlength="100">
      <a href="${companyUrl(company.id)}" target="_blank" rel="noopener noreferrer">別のチャネルで送る・従来の画面を開く</a>
    </details>`;
  }

  function render() {
    progress();
    const { company, template, approach, subject, body, copied, showFailure } = current;
    title.textContent = company.name;
    const url = httpUrl(company.formUrl);
    const ready = Boolean(approach && template && body.trim());
    const reasonOptions = current.detail.sendFailReasons || [];
    box.innerHTML = `
      ${url ? "" : `<p class="qa-note">問い合わせフォームのURLが未登録です。</p>
        <details class="qa-settings"><summary>フォームURLを登録</summary>
          <label for="qa-form-url">問い合わせフォームのURL</label>
          <input id="qa-form-url" type="url" placeholder="https://…">
          ${button("form-url", "登録する")}
        </details>`}
      ${ready ? `
        ${subject ? `<div class="qa-subject"><div><b>件名</b><p id="qa-subject-view">${esc(subject)}</p></div>
          <button type="button" class="btn btn-secondary btn-sm" data-qa="subject" aria-label="件名をコピー">コピー</button></div>` : ""}
        <div class="qa-preview" id="qa-preview">${esc(body)}</div>
        <details class="qa-editor">
          <summary>全文を見る・編集</summary>
          <label for="qa-subject">件名</label><input id="qa-subject" value="${esc(subject)}" maxlength="300">
          <label for="qa-body">本文</label><textarea id="qa-body" rows="10" maxlength="20000">${esc(body)}</textarea>
        </details>
      ` : `<p>${template ? "営業文を準備できませんでした。" : "提案サービスに合わせて営業文を選んでください。"}</p>`}
      ${settings()}
      ${showFailure ? `<div class="qa-failure">
        <label for="qa-reason">送信できなかった理由</label>
        <select id="qa-reason"><option value="">理由を選ぶ</option>${reasonOptions.map(r => option(r.key, r.label, "")).join("")}</select>
        <label for="qa-note">メモ（「その他」は必須）</label><input id="qa-note" maxlength="1000">
        ${button("fail-save", "記録して次へ", true)} ${button("fail-back", "戻る")}
      </div>` : ""}
      ${controls(`
        ${ready && url ? `<a id="qa-copy" class="btn ${copied ? "btn-secondary" : "btn-primary"}" data-qa="copy" href="${esc(url)}"
          target="_blank" rel="noopener noreferrer">本文をコピーしてフォームを開く</a>` : ""}
        <a id="qa-open-only" class="btn btn-secondary" href="${esc(url)}" target="_blank" rel="noopener noreferrer" hidden>フォームを開く</a>
        <button id="qa-sent" type="button" class="btn btn-primary" data-qa="sent"${copied && url && ready ? "" : " hidden"}>送信完了を記録して次へ</button>
        ${!showFailure && reasonOptions.length ? button("fail", "送れなかった") : ""}
        ${button("skip", "後で対応")}
      `)}
    `;
  }

  function renderUnavailable(id, name, error) {
    title.textContent = name || "フォームアタック";
    box.innerHTML = `<p>${esc(errText(error, "営業文を準備できませんでした。"))}</p>`
      + controls(`${button("retry", "再試行")} ${button("skip", "次へ")}
        <a href="${companyUrl(id)}" target="_blank" rel="noopener noreferrer">従来の画面を開く</a>`);
  }

  async function prepare() {
    if (!current.template) return;
    const { company, template, campaignId } = current;
    const response = await API.prepareSalesAttack({
      companyId: company.id, channel: "form", templateId: template.id, campaignId,
      destinationUrl: template.destinationUrl || undefined,
    });
    current.approach = response.approach;
    current.subject = renderText(template.subject, response.trackingUrl);
    current.body = renderText(template.body, response.trackingUrl);
    current.copied = false;
  }

  async function openCompany(picked) {
    current = { picked };
    title.textContent = picked.name || "フォームアタック";
    box.textContent = "準備中…";
    message();
    run.seen.add(picked.id);
    try {
      const [detail, available] = await Promise.all([API.getSalesCompany(picked.id), run.templates]);
      if (!canAttempt(detail.company)) {
        throw new Error("この企業はアタックの対象外です。");
      }
      choices = [...enger, ...available];
      const template = initialTemplate(detail.company, available);
      Object.assign(current, {
        company: detail.company, detail, template, service: template?.service || detail.company.service || "",
        campaignId: detail.company.campaignId || null, body: "", subject: "", copied: false,
      });
      if (template && httpUrl(current.company.formUrl)) await prepare();
      render();
      box.scrollTop = 0;
      get("qa-copy")?.focus({ preventScroll: true });
    } catch (error) {
      renderUnavailable(picked.id, picked.name, error);
    }
  }

  async function next() {
    message();
    let row = run.queue.shift();
    try {
      while (!row && run.fetchPage && !run.exhausted) {
        const data = await run.fetchPage(run.page);
        const remaining = (data.companies || []).filter(c => eligible(c) && !run.seen.has(c.id));
        run.exhausted = data.page >= data.totalPages;
        run.page = data.page + 1;
        run.queue.push(...remaining);
        row = run.queue.shift();
      }
    } catch (error) {
      current = null;
      title.textContent = "次の企業を取得できませんでした";
      box.innerHTML = `<p>${esc(errText(error, "もう一度お試しください。"))}</p>${controls(button("skip", "再試行", true))}`;
      return;
    }
    if (row) return openCompany(row);
    current = null;
    title.textContent = "フォームアタック";
    box.innerHTML = "<p>この条件で続けて送れる未送信企業はありません。</p>" + controls(button("close", "一覧へ戻る", true));
  }

  async function start(options) {
    if (dialog.open) return;
    opener = document.activeElement;
    run = { ...options, seen: new Set(), sent: 0, failed: 0, page: 1, exhausted: false, templates: loadTemplates() };
    run.queue = options.rows.filter(row => eligible(row) && row.id !== options.picked?.id);
    dialog.showModal();
    progress();
    await operate(() => options.picked ? openCompany(options.picked) : next());
  }

  function syncEditor() {
    if (!get("qa-body")) return;
    current.subject = get("qa-subject").value;
    current.body = get("qa-body").value;
  }

  function setCopied(copied) {
    current.copied = copied;
    get("qa-sent").hidden = !copied;
    get("qa-copy")?.classList.toggle("btn-primary", !copied);
    get("qa-copy")?.classList.toggle("btn-secondary", copied);
  }

  async function copyBody() {
    syncEditor();
    if (!current.body.trim()) {
      message("本文を入力してください。");
      return;
    }
    const snapshot = current;
    const body = snapshot.body;
    try {
      await navigator.clipboard.writeText(body);
      if (current !== snapshot || snapshot.body !== body) return;
      message("本文をコピーしました。フォームで送信したら結果を記録してください。");
    } catch {
      if (current !== snapshot || snapshot.body !== body) return;
      const field = get("qa-body");
      field.closest("details").open = true;
      field.focus();
      field.select();
      message("自動コピーできませんでした。選択されている本文をコピーしてください。");
    }
    setCopied(true);
    get("qa-open-only").hidden = false;
  }

  async function record(sent) {
    syncEditor();
    if (sent) {
      if (!current.approach || !current.copied || !current.body.trim()) return;
      await API.markSalesAttackSent({
        id: current.approach.id, channel: "form", templateId: current.template.id, campaignId: current.campaignId,
        service: current.service, body: current.body, subject: current.subject,
      });
      run.sent++;
    } else {
      const reason = get("qa-reason").value;
      const note = get("qa-note").value.trim();
      if (!reason || (reason === "other" && !note)) {
        message(reason ? "「その他」の場合はメモを入力してください。" : "送信できなかった理由を選んでください。");
        return;
      }
      if (!current.approach) {
        const r = await API.prepareSalesAttack({ companyId: current.company.id, campaignId: current.campaignId, channel: "form" });
        current.approach = r.approach;
      }
      await API.markSalesAttackFailed({ id: current.approach.id, channel: "form", reason, note });
      run.failed++;
    }
    progress();
    SalesLayout.announceAttackResult();
    await next();
  }

  async function saveUrl() {
    const formUrl = httpUrl(get("qa-form-url").value.trim());
    if (!formUrl) return message("https:// または http:// のフォームURLを入力してください。");
    await API.updateSalesCompany({ id: current.company.id, formUrl });
    current.company.formUrl = formUrl;
    if (current.template) await prepare();
    render();
    message("フォームURLを登録しました。");
  }

  async function changeTemplate(key) {
    current.template = choices.find(t => t.key === key) || null;
    current.approach = null;
    current.copied = false;
    if (current.template?.service) current.service = current.template.service;
    try { if (httpUrl(current.company.formUrl)) await prepare(); }
    finally { render(); }
  }

  async function operate(action) {
    if (busy) return;
    busy = true;
    const buttons = [...dialog.querySelectorAll("button, select, input, textarea")].filter(x => !x.disabled);
    buttons.forEach(x => { x.disabled = true; });
    dialog.setAttribute("aria-busy", "true");
    try { await action(); }
    catch (error) { message(errText(error, "操作を完了できませんでした。")); }
    finally {
      busy = false;
      buttons.forEach(x => { x.disabled = false; });
      dialog.removeAttribute("aria-busy");
    }
  }

  dialog.addEventListener("click", event => {
    const target = event.target.closest("[data-qa]");
    const action = target?.dataset.qa;
    if (!action) return;
    if (busy) { event.preventDefault(); return; }
    if (action === "close") { dialog.close(); return; }
    if (action === "copy") {
      if (!get("qa-body").value.trim()) event.preventDefault();
      void copyBody();
      return;
    }
    if (action === "subject") {
      syncEditor();
      if (!navigator.clipboard) { message("件名を手動でコピーしてください。"); return; }
      navigator.clipboard.writeText(current.subject)
        .then(() => message("件名をコピーしました。"), () => message("件名を手動でコピーしてください。"));
      return;
    }
    if (action === "fail" || action === "fail-back") {
      syncEditor();
      current.showFailure = action === "fail";
      render();
      if (action === "fail" && !httpUrl(current.company.formUrl) && get("qa-reason")) get("qa-reason").value = "no_form";
      get("qa-reason")?.focus();
      return;
    }
    const handlers = {
      retry: () => openCompany(current.picked), skip: next, sent: () => record(true),
      "fail-save": () => record(false), "form-url": saveUrl,
    };
    if (handlers[action]) void operate(handlers[action]);
  });

  dialog.addEventListener("change", event => {
    const { id, value } = event.target;
    if (id === "qa-campaign") current.campaignId = value || null;
    if (id === "qa-service") current.service = value.trim();
    if (id === "qa-template") void operate(() => changeTemplate(value));
  });

  dialog.addEventListener("input", event => {
    if (!["qa-body", "qa-subject"].includes(event.target.id)) return;
    if (current.copied) {
      setCopied(false);
      message("文面を変更しました。もう一度コピーできます。");
    }
    syncEditor();
    get("qa-preview").textContent = current.body;
    if (get("qa-subject-view")) get("qa-subject-view").textContent = current.subject;
  });

  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    const closed = run;
    run = current = null;
    closed?.done();
    opener?.focus({ preventScroll: true });
  });

  window.SalesQuickAttack = { start };
})();
