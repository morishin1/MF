(() => {
  const endpoint = "/api/sales/proposals/coordination";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const jst = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  function date(value) {
    if (!value) return "未入力";
    if (/^\d{4}-\d\d-\d\d$/.test(value)) return value.replaceAll("-", "/");
    const time = Date.parse(value);
    return Number.isFinite(time) ? jst.format(time) : String(value);
  }

  function sourceFields(source) {
    const reply = (mail, line) => [mail ? "メール " + mail : "メール 未記録",
      line ? "LINE " + line.response + "（" + date(line.at) + "）" : ""].filter(Boolean).join(" ／ ");
    const fields = [
      ["企業の回答", reply(source.companyResponse, source.line.company)],
      ["人材の回答", reply(source.candidateResponse, source.line.candidate)],
      ["回答期限", "企業 " + date(source.companyDue) + " ／ 人材 " + date(source.candidateDue)],
      ["決定期限", date(source.decisionDue)],
      ["ENGERの進捗", source.stage || "未入力"],
      ["ENGERの担当", [source.proposer, source.closer].filter(Boolean).join(" ／ ") || "未入力"],
    ];
    return `<dl class="epc-fields">${fields.map(([label, value]) =>
      `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
      <details class="epc-contacts"><summary>ENGERの連絡履歴（${source.contacts.length}件）</summary>
        ${source.contacts.length ? `<ul>${source.contacts.map(contact => `<li>
          <strong>${esc(contact.label)}</strong> <span>${esc(date(contact.at))} ${esc(contact.author)}</span>
          ${contact.text ? `<p>${esc(contact.text)}</p>` : ""}
        </li>`).join("")}</ul>` : "<p>連絡履歴はまだありません。</p>"}
      </details>`;
  }

  function mount(root, key, { standalone = false, onLoaded } = {}) {
    const identifier = key.id ? { id: key.id } : { sourceId: key.sourceId };
    let board, draft, busy = false;

    function render() {
      const { source, record, canSave, canConfirm } = board;
      root.innerHTML = `
        ${standalone ? `<h2>${esc([source.company, source.job].filter(Boolean).join(" ／ ") || "提案詳細")}</h2>
          <p>Salesの進捗 ${esc(board.salesStatus || "未設定")}</p>` : ""}
        <div class="epc-heading"><h3>ENGERの入力と認識合わせ</h3><button type="button" class="btn btn-secondary btn-sm" data-epc-reload>最新情報を表示</button></div>
        ${sourceFields(source)}
        ${record?.sourceChanged ? '<p class="epc-warning" role="status">ENGERの入力が更新されています。最新情報を見てSalesが共有内容を更新してください。</p>' : ""}
        ${record ? `<dl class="epc-fields epc-record">
          <div><dt>確認したこと・決まったこと</dt><dd>${esc(record.decision)}</dd></div>
          <div><dt>次の対応・担当・期限</dt><dd>${esc(record.nextStep)}</dd></div>
        </dl><p class="epc-status">${record.sourceChanged ? "再確認が必要" : record.engerConfirmedAt ? "Sales・ENGER 確認済み" : "ENGER 確認待ち"}</p>`
          : '<p class="pp-simple-meta">この提案の共有記録はまだありません。</p>'}
        ${draft ? `<form class="epc-form">
          <label>確認したこと・決まったこと<textarea name="decision" rows="2" maxlength="1500" required>${esc(draft.decision)}</textarea></label>
          <label>次の対応・担当・期限<textarea name="nextStep" rows="2" maxlength="1000" placeholder="例：Salesの田中が明日12時までに企業へ回答" required>${esc(draft.nextStep)}</textarea></label>
          <div><button class="btn btn-primary btn-sm" type="submit">保存してENGERに共有</button>
          <button class="btn btn-secondary btn-sm" type="button" data-epc-cancel>閉じる</button></div>
        </form>` : `<div class="epc-actions">
          ${canSave ? `<button class="btn btn-secondary btn-sm" type="button" data-epc-edit>${record ? "認識合わせを更新" : "認識合わせを記録"}</button>` : ""}
          ${canConfirm && !record?.sourceChanged && !record?.engerConfirmedAt
            ? '<button class="btn btn-primary btn-sm" type="button" data-epc-confirm>ENGERで確認済みにする</button>' : ""}
        </div>`}
        ${standalone ? `<p class="epc-actions">
          <a href="https://dx.enger.jp/proposals/${encodeURIComponent(source.id)}">ENGERの提案詳細へ</a>
          ${board.canOpenSales ? `<a href="/sales/proposals.html?id=${encodeURIComponent(board.id)}">Salesの提案詳細へ</a>` : ""}
        </p>` : ""}
        <p class="epc-message" role="status"></p>`;
    }

    function captureDraft() {
      const form = root.querySelector("form");
      if (draft && form) Object.assign(draft, Object.fromEntries(new FormData(form)));
    }

    async function load() {
      board = await API.api(endpoint + "?" + new URLSearchParams(identifier));
      if (root.isConnected) {
        render();
        onLoaded?.();
      }
      return board;
    }

    function message(value) {
      const line = root.querySelector(".epc-message");
      if (line) line.textContent = value;
      else root.innerHTML = `<p class="epc-message" role="status">${esc(value)}</p><button type="button" class="btn btn-secondary btn-sm" data-epc-reload>再表示</button>`;
    }

    async function perform(task, button) {
      if (busy) return;
      busy = true;
      if (button) button.disabled = true;
      try { return await task(); }
      catch (error) { message(error?.hint || "共有情報を読み込めませんでした。再表示してください。"); }
      finally {
        busy = false;
        if (button) button.disabled = false;
      }
    }

    async function post(action, revision, sourceRevision, values) {
      await API.api(endpoint, { method: "POST", body: {
        ...identifier, action, revision, sourceRevision, ...values,
      }, invalidates: [] });
      draft = null;
      try { await load(); } catch { message("保存しました。最新情報を表示して確認してください。"); }
    }

    root.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || busy) return;
      if (button.hasAttribute("data-epc-reload")) {
        captureDraft();
        perform(async () => {
          await load();
          if (draft) message("入力中の内容を保持しています。内容を見直してから保存してください。");
          if (draft && draft.revision === (board.record?.revision || 0)) draft.sourceRevision = board.source.revision;
        }, button);
      } else if (button.hasAttribute("data-epc-edit")) {
        draft = { decision: board.record?.decision || "", nextStep: board.record?.nextStep || "",
          revision: board.record?.revision || 0, sourceRevision: board.source.revision };
        render();
        root.querySelector("textarea")?.focus();
      } else if (button.hasAttribute("data-epc-cancel")) {
        draft = null;
        render();
        root.querySelector("[data-epc-edit]")?.focus();
      } else if (button.hasAttribute("data-epc-confirm")) {
        perform(() => post("confirm", board.record.revision, board.source.revision), button);
      }
    });
    root.addEventListener("submit", event => {
      event.preventDefault();
      if (!draft) return;
      captureDraft();
      const { revision, sourceRevision, decision, nextStep } = draft;
      perform(() => post("save", revision, sourceRevision, { decision, nextStep }), event.submitter);
    });
    return perform(load);
  }

  window.EngerProposalCoordination = { mount };
})();
