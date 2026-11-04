// タスクの引き出し（右から出る詳細）。
//
// ■ 一覧は「探す場所」、引き出しは「処理する場所」
//
//   行を押しても、別の画面へ飛ばさない。背面の一覧はそのまま残す。
//   閉じたときに同じ場所へ戻れないと、「確認 → 戻る → また探す」が毎回起きる。
//
// ■ PCは右から、スマホは下から
//
//   狭い画面で右から細い板が出ても読めない。下から全面に近い高さで出す。
//   出し分けは CSS（css/app.css の .td-*）。この中では同じものを描く。
//
// ■ 変えたら、一覧に返す
//
//   引き出しの中で担当や期限を変えたら、onChange で一覧に知らせる。
//   一覧は、その1行だけ描き直す（全部読み直すと、見ていた場所が飛ぶ）。
//
// 使い方:
//   KPTaskDrawer.open(taskId, { onChange })
//   KPTaskDrawer.close()

(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let cur = null;          // いま開いているもの { id, data, tab, onChange }
  let box = null;          // 引き出しの入れ物

  const TABS = [
    { key: "about",   label: "概要" },
    { key: "comment", label: "コメント" },
    { key: "history", label: "履歴" },
  ];

  function ensureBox() {
    if (box) return box;
    box = document.createElement("div");
    box.id = "td-root";
    box.className = "td-root hidden";
    box.innerHTML = `<div class="td-back" onclick="KPTaskDrawer.close()"></div>
                     <aside class="td-panel" id="td-panel"></aside>`;
    document.body.appendChild(box);
    // Esc で閉じる。閉じる場所を探させない
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && cur) close();
    });
    return box;
  }

  async function open(id, opts = {}) {
    ensureBox();
    cur = { id, tab: opts.tab || "about", onChange: opts.onChange || (() => {}), data: null };
    box.classList.remove("hidden");
    document.body.classList.add("td-open");
    panel().innerHTML = `<div class="td-load">読み込み中…</div>`;
    await reload();
  }

  async function reload() {
    if (!cur) return;
    try {
      cur.data = await API.taskDetail(cur.id);
    } catch (e) {
      panel().innerHTML = `
        <div class="td-head">
          <button class="td-x" onclick="KPTaskDrawer.close()" title="閉じる">
            <span class="material-symbols-outlined">close</span></button>
        </div>
        <div class="td-body"><div class="banner err" style="margin:0;">
          <span class="material-symbols-outlined">error</span>
          <div>${esc(e.hint || e.detail || e.message || "開けませんでした")}</div></div></div>`;
      return;
    }
    render();
  }

  function close() {
    cur = null;
    if (box) box.classList.add("hidden");
    document.body.classList.remove("td-open");
  }

  const panel = () => document.getElementById("td-panel");
  const el = (id) => document.getElementById(id);

  function setTab(key) {
    if (!cur) return;
    cur.tab = key;
    render();
  }

  // ---- 描く -------------------------------------------------------------------
  function render() {
    const d = cur.data;
    const t = d.task;
    const editable = d.canEdit;

    panel().innerHTML = `
      <div class="td-head">
        <div class="td-ti">${esc(t.title)}</div>
        <button class="td-x" onclick="KPTaskDrawer.close()" title="閉じる">
          <span class="material-symbols-outlined">close</span></button>
      </div>

      <!-- 上に、いちばんよく変えるものを並べる。
           ここで直せれば、下まで開かなくてよい -->
      <div class="td-top">
        <div class="td-f">
          <label for="td-status">状態</label>
          <select id="td-status" ${editable ? "" : "disabled"} onchange="KPTaskDrawer.saveStatus()">
            ${d.statuses.map((s) => `<option value="${esc(s.key)}" ${t.status === s.key ? "selected" : ""}>${esc(s.label)}</option>`).join("")}
          </select>
        </div>
        <div class="td-f">
          <label for="td-who">担当</label>
          <select id="td-who" ${editable ? "" : "disabled"} onchange="KPTaskDrawer.saveField('assigneeId', this.value)">
            <option value="">（未割り当て）</option>
            ${d.people.map((p) => `<option value="${esc(p.id)}" ${t.assigneeId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
          </select>
        </div>
        <div class="td-f">
          <label for="td-pri">優先度</label>
          <select id="td-pri" ${editable ? "" : "disabled"} onchange="KPTaskDrawer.saveField('priority', this.value)">
            ${d.priorities.map((p) => `<option value="${esc(p.key)}" ${t.priority === p.key ? "selected" : ""}>${esc(p.label)}</option>`).join("")}
          </select>
        </div>
        <div class="td-f">
          <label for="td-due">期限</label>
          <input id="td-due" type="date" value="${esc(t.dueOn || "")}" ${editable ? "" : "disabled"}
                 onchange="KPTaskDrawer.saveField('dueOn', this.value)">
        </div>
      </div>

      ${t.status === "done" ? "" : `
        <div class="td-act">
          <button class="btn btn-primary btn-sm" onclick="KPTaskDrawer.done(this)">
            <span class="material-symbols-outlined icon-inline">check</span>完了する</button>
          <button class="btn btn-secondary btn-sm" onclick="KPTaskDrawer.setTab('carry')">
            <span class="material-symbols-outlined icon-inline">redo</span>持ち越し・担当を渡す</button>
        </div>`}

      ${aiBox(t)}

      <div class="td-tabs">
        ${TABS.map((x) => `<button class="${cur.tab === x.key ? "on" : ""}"
            onclick="KPTaskDrawer.setTab('${x.key}')">${esc(x.label)}${
              x.key === "comment" && d.comments.length ? `（${d.comments.length}）` : ""}</button>`).join("")}
      </div>
      <div class="td-body" id="td-body"></div>
      <div id="td-msg" class="err-text" style="padding:0 18px 14px;"></div>`;

    const body = el("td-body");
    body.innerHTML = cur.tab === "comment" ? commentTab()
      : cur.tab === "history" ? historyTab()
        : cur.tab === "carry" ? carryTab()
          : aboutTab();
    if (cur.tab === "comment") {
      body.scrollTop = body.scrollHeight;
      el("td-c-input")?.focus();
    }
  }

  /** AIの案。採る・担当だけ採る・このまま進める の3つ */
  function aiBox(t) {
    if (!t.ai || t.ai.adopted) {
      if (!t.aiAssigneeId) return "";
    }
    const ai = t.ai || {};
    const lines = [];
    if (ai.reason) lines.push(esc(ai.reason));
    if (ai.fix) lines.push(`直し方：${esc(ai.fix)}`);
    if (ai.doneCondition) lines.push(`完了条件の案：${esc(ai.doneCondition)}`);
    if (t.aiAssignee) {
      lines.push(`担当の案：${esc(t.aiAssignee)} さん${t.aiAssigneeWhy ? `（${esc(t.aiAssigneeWhy)}）` : ""}`);
    }
    if (!lines.length) return "";
    return `
      <div class="td-ai">
        <b><span class="material-symbols-outlined">smart_toy</span>AIからの提案</b>
        <div class="tx">${lines.join("<br>")}</div>
        <div class="bt">
          <button class="btn btn-primary btn-sm" onclick="KPTaskDrawer.ai('adopt', this)">提案を採用</button>
          ${t.aiAssigneeId
            ? `<button class="btn btn-secondary btn-sm" onclick="KPTaskDrawer.ai('assign', this)">担当だけ変える</button>`
            : ""}
          <button class="btn btn-secondary btn-sm" onclick="KPTaskDrawer.ai('keep', this)">このまま進める</button>
        </div>
      </div>`;
  }

  function aboutTab() {
    const t = cur.data.task;
    const editable = cur.data.canEdit;
    const row = (label, id, value, ph = "") => `
      <div class="td-row">
        <label for="${id}">${esc(label)}</label>
        <input id="${id}" type="text" value="${esc(value || "")}" placeholder="${esc(ph)}"
               ${editable ? "" : "disabled"} onchange="KPTaskDrawer.saveField('${id.replace("td-", "")}', this.value)">
      </div>`;
    return `
      ${row("目的", "td-purpose", t.purpose, "なぜやるのか")}
      ${row("完了条件", "td-doneCondition", t.doneCondition, "どうなったら終わりか")}
      ${row("関連KPI", "td-kpi", t.kpi, "新規開拓")}
      ${row("関連サービス", "td-service", t.service, "ENGER")}
      ${row("分類", "td-category", t.category, "月次経理")}
      ${row("関連URL", "td-url", t.url, "https://…")}
      <div class="td-row">
        <label for="td-body-text">メモ</label>
        <textarea id="td-body-text" rows="3" ${editable ? "" : "disabled"}
          onchange="KPTaskDrawer.saveField('body', this.value)">${esc(t.body || "")}</textarea>
      </div>
      <dl class="td-meta">
        <dt>作成</dt><dd>${esc(fmt(t.createdAt))}${t.createdBy ? `　${esc(t.createdBy)}` : ""}</dd>
        <dt>作り手</dt><dd>${t.madeBy === "ai" ? "AIが作成" : "人が作成"}</dd>
        ${t.focusDate ? `<dt>重要タスク</dt><dd>${esc(t.focusDate)}${t.carryCount ? `（持ち越し ${t.carryCount}回）` : ""}</dd>` : ""}
        ${t.completedAt ? `<dt>完了</dt><dd>${esc(fmt(t.completedAt))}</dd>` : ""}
        ${t.result ? `<dt>結果</dt><dd>${esc(t.result)}</dd>` : ""}
        ${t.notDoneReason ? `<dt>できなかった理由</dt><dd>${esc(t.notDoneReason)}</dd>` : ""}
      </dl>`;
  }

  function commentTab() {
    const list = cur.data.comments;
    return `
      <div class="td-cs">
        ${list.length
          ? list.map((c) => `
            <div class="td-c ${c.mine ? "mine" : ""}">
              <div class="w">${esc(c.name)}<span>${esc(fmt(c.at))}</span></div>
              <div class="b">${esc(c.body)}</div>
            </div>`).join("")
          : `<div class="td-empty">まだコメントはありません。</div>`}
      </div>
      <div class="td-cin">
        <textarea id="td-c-input" rows="2" placeholder="担当者・管理者に伝えること"></textarea>
        <button class="btn btn-primary btn-sm" onclick="KPTaskDrawer.comment(this)">送る</button>
      </div>`;
  }

  function historyTab() {
    const list = cur.data.events;
    if (!list.length) return `<div class="td-empty">履歴はまだありません。</div>`;
    return `<div class="td-hs">
      ${list.map((e) => `
        <div class="td-h">
          <span class="k">${esc(e.kindLabel)}</span>
          <div class="b"><div class="t">${esc(e.text)}</div>
            <div class="w">${esc(e.who)}　${esc(fmt(e.at))}</div></div>
        </div>`).join("")}
    </div>`;
  }

  function carryTab() {
    const d = cur.data;
    return `
      <p class="td-lead">終わらなかったとき、どうするかを決めます。自動では動きません。</p>
      <div class="td-row">
        <label for="td-carry-why">理由（任意）</label>
        <input id="td-carry-why" type="text" placeholder="先方の返事待ちだった">
      </div>
      <div class="td-row">
        <label for="td-carry-who">渡す相手</label>
        <select id="td-carry-who">
          <option value="">（渡さない）</option>
          ${d.people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}
        </select>
      </div>
      <div class="td-cbt">
        ${d.carryChoices.map((c) => `
          <button class="btn btn-secondary btn-sm" title="${esc(c.hint)}"
                  onclick="KPTaskDrawer.carry('${esc(c.key)}', this)">${esc(c.label)}</button>`).join("")}
      </div>`;
  }

  // ---- 変える -----------------------------------------------------------------
  const msg = (text, bad) => {
    const m = el("td-msg");
    if (!m) return;
    m.style.color = bad ? "" : "var(--primary-dark)";
    m.textContent = text || "";
    if (text && !bad) setTimeout(() => { if (m.textContent === text) m.textContent = ""; }, 2500);
  };

  async function post(body, btn) {
    const run = () => API.taskAct({ id: cur.id, ...body });
    return btn && window.KPLayout?.busy ? KPLayout.busy(btn, "…", run) : run();
  }

  /** 1項目だけ直す。押した場所から動かない */
  async function saveField(key, value) {
    if (!cur) return;
    try {
      await post({ action: "update", [key]: value });
      await reload();
      cur.onChange(cur.id);
      msg("保存しました");
    } catch (e) { msg(e.hint || e.detail || e.message || "変えられませんでした", true); }
  }

  async function saveStatus() {
    const v = el("td-status")?.value;
    if (!v) return;
    try {
      await post({ action: "status", status: v });
      await reload();
      cur.onChange(cur.id);
      msg("保存しました");
    } catch (e) { msg(e.hint || e.message || "変えられませんでした", true); }
  }

  async function done(btn) {
    try {
      await post({ action: "status", status: "done" }, btn);
      await reload();
      cur.onChange(cur.id);
      msg("完了にしました");
    } catch (e) { msg(e.hint || e.message || "できませんでした", true); }
  }

  async function comment(btn) {
    const v = el("td-c-input")?.value.trim();
    if (!v) return;
    try {
      await post({ action: "comment", body: v }, btn);
      await reload();
      msg("送りました");
    } catch (e) { msg(e.hint || e.message || "送れませんでした", true); }
  }

  async function carry(decision, btn) {
    const reason = el("td-carry-why")?.value || "";
    const assigneeId = el("td-carry-who")?.value || null;
    if (decision === "hand" && !assigneeId) { msg("渡す相手を選んでください", true); return; }
    try {
      const r = await post({ action: "carry", decision, reason, assigneeId }, btn);
      cur.tab = "about";
      await reload();
      cur.onChange(cur.id);
      msg(`${r.label} にしました`);
    } catch (e) { msg(e.hint || e.detail || e.message || "できませんでした", true); }
  }

  async function ai(how, btn) {
    try {
      const r = await post({ action: "ai", how }, btn);
      await reload();
      cur.onChange(cur.id);
      msg(how === "keep" ? "このまま進めます"
        : `AIの案を採りました${r.what?.length ? `（${r.what.join("・")}）` : ""}`);
    } catch (e) { msg(e.hint || e.message || "できませんでした", true); }
  }

  const fmt = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  window.KPTaskDrawer = {
    open, close, reload, setTab, saveField, saveStatus, done, comment, carry, ai,
    get openId() { return cur?.id || null; },
  };
})();
