import { compactIsbn, normalizeIsbn } from "./book-isbn.js";

const endpoint = "/api/book-lending";
const esc = window.KPLayout.esc;
const statusText = { available: "貸出可", lent: "貸出中", pending: "現物確認待ち" };
const statuses = book => !book.confirmed ? "pending" : book.loan ? "lent" : "available";
const messages = { register: "登録しました。", edit: "書籍情報を更新しました。", confirm: "現物を確認し、貸出可にしました。", lend: "貸出を記録しました。", return: "返却を記録しました。" };
const actions = { register: "書籍を登録", edit: "書籍情報を編集", confirm: "現物を確認", lend: "貸出を記録", return: "返却を記録", history: "貸出履歴" };

function parseCandidates(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("書誌データを読み取れませんでした。ISBNを手入力できます。");
  const choices = new Map();
  for (const item of doc.getElementsByTagName("item")) {
    const field = tag => item.getElementsByTagNameNS("*", tag)[0]?.textContent?.trim() || "";
    const title = field("title");
    if (!title) continue;
    const volume = field("volume");
    const edition = field("edition");
    const fullTitle = [title, volume, edition].filter((v, i) => v && (!i || !title.includes(v))).join(" ");
    for (const id of item.getElementsByTagNameNS("*", "identifier")) {
      const type = id.getAttributeNS("http://www.w3.org/2001/XMLSchema-instance", "type") || "";
      if (!/(^|:)ISBN$/i.test(type)) continue;
      const isbn = normalizeIsbn(id.textContent);
      if (isbn && !choices.has(isbn)) choices.set(isbn, { isbn, title: fullTitle, publisher: field("publisher"), year: field("issued") || field("date") });
    }
  }
  return [...choices.values()];
}

function isbnLink(isbn) {
  if (!isbn) return "未確認";
  return `<a href="https://ndlsearch.ndl.go.jp/api/openurl?isbn=${encodeURIComponent(isbn)}" target="_blank" rel="noopener noreferrer" aria-label="ISBN ${esc(isbn)} の書籍情報を開く">${esc(isbn)}</a>`;
}

function bookMatches(book, query) {
  const term = query.trim().normalize("NFKC").toLowerCase();
  if (!term) return true;
  if (term.split(/\s+/).every(word => book.title.normalize("NFKC").toLowerCase().includes(word))) return true;
  const isbn = normalizeIsbn(term) || compactIsbn(term);
  return Boolean(isbn && book.isbn?.includes(isbn));
}

let refreshList;
export function openBookList(root, manage) {
  // Each page has one catalogue. Keep its filters and keyboard focus when it is reopened.
  if (!refreshList) refreshList = mount(root, manage);
  return refreshList();
}

function mount(root, manage) {
  root.innerHTML = `<div class="books-toolbar">
    <label class="books-search">書名・ISBNで検索<input type="search" name="search" placeholder="書名またはISBN" autocomplete="off"></label>
    ${manage ? `<label>貸出状況<select name="status"><option value="">すべて</option>
      <option value="available">貸出可</option><option value="lent">貸出中</option><option value="pending">現物確認待ち</option></select></label>
      <button type="button" class="btn btn-primary" data-act="register">書籍を登録</button>` : ""}
    </div><p class="books-message" role="status"></p><div class="books-list"></div>
    ${manage ? `<dialog class="books-dialog" aria-labelledby="book-dialog-title"></dialog>` : ""}`;
  const search = root.querySelector('[name="search"]');
  const filter = root.querySelector('[name="status"]');
  const list = root.querySelector(".books-list");
  const message = root.querySelector(".books-message");
  const dialog = root.querySelector("dialog");
  let books = [];
  let request = 0;
  let ready = false;

  async function refresh() {
    const current = ++request;
    ready = false;
    list.textContent = "読み込み中…";
    try {
      const result = await API.api(endpoint + (manage ? "?manage=1" : ""));
      if (current !== request) return;
      books = result.books;
      ready = true;
      draw();
    } catch (e) {
      if (current !== request) return;
      list.innerHTML = `<p>${esc(e.message)}</p><button class="btn btn-secondary btn-sm" data-act="reload">再読み込み</button>`;
    }
  }

  function draw() {
    if (!ready) return;
    const found = books.filter(b => bookMatches(b, search.value) && (!filter?.value || statuses(b) === filter.value));
    if (!found.length) {
      list.innerHTML = `<div class="empty">${search.value || filter?.value ? "条件に一致する書籍はありません。" :
        manage ? "まだ書籍が登録されていません。" : "現在、貸出可能な書籍はありません。"}</div>`;
      return;
    }
    list.innerHTML = `<div class="table-scroll"><table class="books-table"><thead><tr><th>書名</th><th>ISBN</th>
      ${manage ? "<th>貸出状況</th><th>借りた方／貸出日</th><th>操作</th>" : "<th>貸出可能な冊数</th>"}
      </tr></thead><tbody>${found.map(b => {
        if (!manage) return `<tr><td>${esc(b.title)}</td><td>${isbnLink(b.isbn)}</td><td>${b.copies}冊</td></tr>`;
        const status = statuses(b);
        const action = b.loan ? "return" : b.confirmed ? "lend" : "confirm";
        const primary = b.loan ? "返却" : b.confirmed ? "貸出" : "現物を確認";
        return `<tr><td><strong>${esc(b.title)}</strong><small>管理番号 ${esc(b.copy_no)}</small></td><td>${isbnLink(b.isbn)}</td>
          <td><span class="books-badge ${status}">${statusText[status]}</span></td>
          <td>${b.loan ? `${esc(b.loan.borrower_name)}<small>${esc(b.loan.loaned_on)}</small>` : "—"}</td>
          <td><div class="books-row-actions" data-id="${esc(b.id)}"><button class="btn btn-secondary btn-sm" data-act="${action}">${primary}</button>
          <button class="books-link" data-act="edit">編集</button>${b.confirmed ? '<button class="books-link" data-act="history">履歴</button>' : ""}</div></td></tr>`;
      }).join("")}</tbody></table></div>`;
  }
  search.addEventListener("input", draw);
  filter?.addEventListener("change", draw);
  root.addEventListener("click", event => {
    const button = event.target.closest("button[data-act]");
    if (!button || dialog?.contains(button)) return;
    if (button.dataset.act === "reload") return void refresh();
    if (!manage) return;
    const book = books.find(b => b.id === button.closest("[data-id]")?.dataset.id);
    if (button.dataset.act === "register" || book) openDialog(button.dataset.act, book);
  });

  let lookupRequest = 0;
  async function openDialog(action, book) {
    ++lookupRequest;
    const bibliographic = ["register", "confirm", "edit"].includes(action);
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const bookId = book?.id || crypto.randomUUID();
    const loanId = book?.loan?.id || crypto.randomUUID();
    const caption = action === "confirm" || action === "register" ? "確認して貸出可にする" : action === "edit" ? "保存" : actions[action];
    dialog.innerHTML = `<div class="books-dialog-head"><h2 id="book-dialog-title">${actions[action]}</h2>
      <button type="button" class="books-close" aria-label="閉じる">×</button></div>
      ${book && !bibliographic ? `<p><strong>${esc(book.title)}</strong>　管理番号 ${esc(book.copy_no)}</p>` : ""}
      <form>${bibliographic ? `
        ${action !== "edit" ? "<p>手元にある本の書名・版・ISBNを確認してください。1冊ずつ登録できます。</p>" : ""}
        <label>書名（年度・版を含む）<input name="title" maxlength="300" required value="${esc(book?.title ?? "")}"></label>
        <button type="button" class="btn btn-secondary btn-sm books-lookup">書名からISBNを検索</button>
        <div class="books-candidates" aria-live="polite"></div>
        <label>ISBN<input name="isbn" maxlength="34" required placeholder="10桁または13桁" value="${esc(book?.isbn ?? "")}"></label>` :
        action === "lend" ? `<label>借りる方の氏名<input name="borrower" autocomplete="off" maxlength="100" required></label>
          <label>貸出日<input type="date" name="date" required value="${today}" max="${today}"></label>` :
        action === "return" ? `<p>${esc(book.loan.borrower_name)} さんに ${esc(book.loan.loaned_on)} 貸出</p>
          <label>返却日<input type="date" name="date" required value="${today}" min="${esc(book.loan.loaned_on)}" max="${today}"></label>` : ""}
        <div class="books-feedback" role="status"></div>
        ${action === "history" ? "" : `<button class="btn btn-primary" type="submit">${caption}</button>`}</form>`;
    const form = dialog.querySelector("form");
    const feedback = form.querySelector(".books-feedback");
    const close = dialog.querySelector(".books-close");
    close.onclick = () => dialog.close();
    dialog.showModal();
    if (action === "history") {
      feedback.textContent = "読み込み中…";
      try {
        const { loans } = await API.api(endpoint + "?history=" + encodeURIComponent(book.id));
        feedback.innerHTML = loans.length ? `<p>直近${loans.length}件</p><table class="books-table"><thead><tr><th>借りた方</th><th>貸出日</th><th>返却日</th></tr></thead><tbody>
          ${loans.map(l => `<tr><td>${esc(l.borrower_name)}</td><td>${esc(l.loaned_on)}</td><td>${esc(l.returned_on || "貸出中")}</td></tr>`).join("")}</tbody></table>` : "貸出履歴はありません。";
      } catch (e) { feedback.textContent = e.message; }
      return;
    }
    if (bibliographic) {
      const results = form.querySelector(".books-candidates");
      const lookup = form.querySelector(".books-lookup");
      const clear = () => { ++lookupRequest; results.replaceChildren(); };
      form.elements.title.addEventListener("input", clear);
      lookup.onclick = async () => {
        const title = form.elements.title.value.trim();
        if (title.length < 2) { results.textContent = "書名を2文字以上入力してください。"; return; }
        const current = ++lookupRequest;
        results.textContent = "書誌を検索中…";
        try {
          const { xml } = await API.api(endpoint + "?lookup=" + encodeURIComponent(title));
          if (current !== lookupRequest || !dialog.open) return;
          const options = parseCandidates(xml);
          results.textContent = options.length ? "手元の本と同じ版を選んでください。" : "ISBNの候補が見つかりません。書名を短くして再検索するか、手入力してください。";
          for (const o of options) {
            const choice = document.createElement("button");
            choice.className = "books-choice";
            choice.type = "button";
            choice.textContent = `${o.title}　${[o.publisher, o.year, o.isbn].filter(Boolean).join(" ／ ")}`;
            choice.onclick = () => {
              form.elements.title.value = o.title;
              form.elements.isbn.value = o.isbn;
              clear();
              results.textContent = "選んだ版の書名とISBNを入力しました。";
            };
            results.append(choice);
          }
          const credit = document.createElement("small");
          credit.innerHTML = '書誌データ：<a href="https://ndlsearch.ndl.go.jp/" target="_blank" rel="noopener noreferrer">国立国会図書館サーチ</a>（<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>）';
          results.append(credit);
        } catch (e) { if (current === lookupRequest) results.textContent = e.message; }
      };
    }
    form.onsubmit = async event => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      if (submit.disabled) return;
      const fields = Object.fromEntries(new FormData(form));
      if (bibliographic && !normalizeIsbn(fields.isbn)) {
        feedback.textContent = "ISBNの桁数と数字を確認してください。";
        form.elements.isbn.focus();
        return;
      }
      submit.disabled = close.disabled = true;
      dialog.oncancel = e => e.preventDefault();
      feedback.textContent = "保存中…";
      try {
        await API.api(endpoint, { method: "POST", body: { action, bookId, loanId, revision: book?.revision, ...fields } });
        dialog.close();
        message.textContent = messages[action];
        await refresh();
      } catch (e) {
        feedback.textContent = e.message;
        if (e.status === 409) { await refresh(); }
      } finally {
        submit.disabled = close.disabled = false;
        dialog.oncancel = null;
      }
    };
  }
  return refresh;
}

