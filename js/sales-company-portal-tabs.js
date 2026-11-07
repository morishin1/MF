import {renderMeetingBrief} from "./sales-company-meeting-summary.js?v=20261107brief1";
// 企業詳細モーダルのタブ（企業情報／商談準備／企業ポータル／オファー・進捗）。
// 「企業情報」は既存のワークベンチ（js/sales-company-workbench.js）をそのまま使う。
// ここでは残り3つのタブを描く。API は /api/sales/company-talents・company-portal・company-progress。
// 決まりごとは docs/sales-company-portal.md。
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stamp = (v) => (v ? new Date(v).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const day = (v) => (v ? new Date(v).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—");
const errText = (e, fallback) => e?.hint || e?.message || fallback;
const TABS = ["info", "prep", "portal", "offers"];
const PANEL = { info: "lc-detail", prep: "lc-panel-prep", portal: "lc-panel-portal", offers: "lc-panel-offers" };
const LINK_ORDER = ["saved", "planned", "proposed", "declined"];

export function createPortalTabs() {
  let row = null, gen = 0, active = "info";
  const loaded = new Set();
  const prep = { tab: "all", page: 1, selected: new Set(), rows: [], options: null };
  const live = (n) => n === gen && $("lc-dialog").open;

  function select(tab) {
    if (!TABS.includes(tab)) return;
    const btn = document.querySelector(`[data-modal-tab="${tab}"]`);
    if (!btn || btn.disabled) return;
    active = tab;
    for (const t of TABS) {
      const b = document.querySelector(`[data-modal-tab="${t}"]`);
      b.setAttribute("aria-selected", String(t === tab));
      b.tabIndex = t === tab ? 0 : -1;
      $(PANEL[t]).hidden = t !== tab;
    }
    const toolbar=$("lc-ai-quick");
    if(toolbar)toolbar.hidden=tab!=="info";
    if (tab !== "info" && !loaded.has(tab)) { loaded.add(tab); void ({ prep: loadPrep, portal: loadPortal, offers: loadOffers }[tab])(); }
  }

  document.querySelectorAll("[data-modal-tab]").forEach((b) => {
    b.addEventListener("click", () => select(b.dataset.modalTab));
    b.addEventListener("keydown", (e) => {
      if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
      const enabled = TABS.filter((t) => !document.querySelector(`[data-modal-tab="${t}"]`).disabled);
      const i = enabled.indexOf(active);
      const next = enabled[(i + (e.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
      select(next); document.querySelector(`[data-modal-tab="${next}"]`).focus();
    });
  });

  function open(r) {
    row = r; gen++; loaded.clear();
    Object.assign(prep, { tab: "all", page: 1, selected: new Set(), rows: [] });
    const usable = Boolean(r?.companyId) && !r?.salesOnly;
    for (const t of ["prep", "portal", "offers"]) {
      const b = document.querySelector(`[data-modal-tab="${t}"]`);
      b.disabled = !usable;
      b.title = usable ? "" : "ENGER の企業IDと照合済みの企業だけで使えます";
      $(PANEL[t]).innerHTML = usable ? '<p class="lc-detail-note">読み込み中…</p>' : '<p class="lc-detail-note">ENGER の企業IDと照合してから使えます。</p>';
    }
    select("info");
  }

  // ---------------------------------------------------------------- 商談準備
  function prepFilters() {
    const v = (id) => $(id)?.value || "";
    return { q: v("lp-q"), skills: v("lp-skills"), remote: v("lp-remote"), prefecture: v("lp-pref"), weekDays: v("lp-days"), start: $("lp-start")?.checked ? "immediate" : "", sort: v("lp-sort") };
  }

  function prepShell(options) {
    const o = options || { remote: {}, prefectures: [], linkStatuses: {} };
    $("lc-panel-prep").innerHTML =
      '<div class="lp-wrap"><div id="lp-brief" aria-live="polite"><p class="lc-detail-note">企業サマリーとマッチング候補を分析中…</p></div><div class="lp-prep-actions"><button type="button" id="lp-open-company-ai" class="lc-primary">企業情報をブラッシュアップ</button><span>企業情報タブからMDをダウンロードし、AI分析結果を取り込めます。</span></div><details id="lp-search-details" class="lp-prep-more"><summary>詳細な人材検索・候補を保存（必要なときに開く）</summary><div class="lp-prep-search-content"><p class="lc-detail-note">ENGERの人材DBを条件で検索します。氏名・連絡先・所属会社・仕入単価・スキルシート原本は公開しません。</p>' +
      '<div class="lp-subtabs" role="group" aria-label="人材の種類">' + [["all", "全人材"], ["focus", "注力人材"], ["new", "新着人材"], ["linked", "この企業に紐づけ済み"]].map(([k, l]) => `<button type="button" data-prep-tab="${k}" aria-pressed="${prep.tab === k}">${l}${k === "linked" ? ' <b id="lp-linked-count"></b>' : ""}</button>`).join("") + "</div>" +
      '<form id="lp-form" class="lp-filters" role="search"><input id="lp-q" type="search" maxlength="100" placeholder="職種・スキル・人材番号" aria-label="キーワード">' +
      '<input id="lp-skills" maxlength="200" placeholder="スキル（カンマ区切り。すべて一致）" aria-label="スキル">' +
      `<select id="lp-remote" aria-label="働き方"><option value="">働き方：すべて</option>${Object.entries(o.remote).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join("")}</select>` +
      `<select id="lp-pref" aria-label="居住地"><option value="">居住地：すべて</option>${o.prefectures.map((p) => `<option>${esc(p)}</option>`).join("")}</select>` +
      '<select id="lp-days" aria-label="稼働日数"><option value="">稼働日数：すべて</option><option value="5">週5日</option><option value="4">週4日以上</option><option value="3">週3日以上</option></select>' +
      '<label class="lp-check"><input type="checkbox" id="lp-start"> 早めに稼働できる</label>' +
      '<select id="lp-sort" aria-label="並べ替え"><option value="">並び：自動（キーワードがあれば関連度）</option><option value="relevance">関連度</option><option value="new">新着順</option></select>' +
      '<button type="submit" class="lc-primary">検索</button></form>' +
      '<p id="lp-status" class="lc-detail-note" role="status" aria-live="polite"></p>' +
      '<div class="lc-table-wrap"><table class="lc-table lp-table"><thead><tr><th><input type="checkbox" id="lp-all" aria-label="表示中の人材をすべて選択"></th><th>人材</th><th>職種</th><th>スキル</th><th>稼働開始</th><th>働き方・居住地</th><th>この企業への紐づけ</th></tr></thead><tbody id="lp-rows"></tbody></table></div>' +
      '<div class="lc-pager"><button type="button" id="lp-prev" disabled>前へ</button><span id="lp-page"></span><button type="button" id="lp-next" disabled>次へ</button></div>' +
      `<section id="lp-bulk" class="lc-bulk" hidden aria-label="選んだ人材をこの企業に保存"><strong id="lp-selected"></strong><label>状態<select id="lp-bulk-status">${LINK_ORDER.map((k) => `<option value="${k}">${esc((o.linkStatuses || {})[k] || k)}</option>`).join("")}</select></label><button type="button" id="lp-save" class="lc-primary">この企業に保存</button><button type="button" id="lp-clear">選択解除</button></section></div></details></div>`;
    $("lp-open-company-ai").onclick=()=>select("info");
    document.querySelectorAll("[data-prep-tab]").forEach((b) => (b.onclick = () => { prep.tab = b.dataset.prepTab; prep.page = 1; document.querySelectorAll("[data-prep-tab]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); void searchPrep(); }));
    $("lp-form").onsubmit = (e) => { e.preventDefault(); prep.page = 1; void searchPrep(); };
    $("lp-prev").onclick = () => { prep.page--; void searchPrep(); };
    $("lp-next").onclick = () => { prep.page++; void searchPrep(); };
    $("lp-all").onchange = (e) => { for (const r of prep.rows) e.target.checked ? prep.selected.add(r.id) : prep.selected.delete(r.id); drawPrepRows(); };
    $("lp-clear").onclick = () => { prep.selected.clear(); drawPrepRows(); };
    $("lp-save").onclick = () => void saveLinks([...prep.selected], $("lp-bulk-status").value);
    $("lp-rows").onclick = (e) => { if (e.target.closest("input")) return; const tr = e.target.closest("[data-talent]"); if (tr) void openTalent(tr.dataset.talent); };
    $("lp-rows").onkeydown = (e) => { if (e.key === "Enter" && e.target.matches("[data-talent]")) void openTalent(e.target.dataset.talent); };
    $("lp-rows").onchange = (e) => { const cb = e.target.closest("[data-pick]"); if (!cb) return; cb.checked ? prep.selected.add(cb.dataset.pick) : prep.selected.delete(cb.dataset.pick); drawPrepRows(); };
  }

  const badges = (t) => (t.isFocus ? '<span class="lp-badge focus">注力</span>' : "") + (t.isNew ? '<span class="lp-badge new">新着</span>' : "");

  function drawPrepRows() {
    const body = $("lp-rows"); if (!body) return;
    body.innerHTML = prep.rows.length ? prep.rows.map((t) => `<tr data-talent="${esc(t.id)}" tabindex="0" class="${prep.selected.has(t.id) ? "chosen" : ""}"><td><input type="checkbox" data-pick="${esc(t.id)}" ${prep.selected.has(t.id) ? "checked" : ""} aria-label="${esc(t.displayName)}を選択"></td>` +
      `<td><strong>${esc(t.displayName)}</strong>${badges(t)}<small>${esc(t.talentNo || "")}</small></td><td>${esc(t.title || "—")}<small>${esc((t.roles || []).join(" / "))}</small></td>` +
      `<td><div class="lp-skills">${(t.skills || []).slice(0, 6).map((s) => `<span>${esc(s)}</span>`).join("")}${t.skills?.length > 6 ? `<span>他${t.skills.length - 6}</span>` : ""}</div></td>` +
      `<td>${esc(t.availability || "—")}<small>${esc(t.weekDays || "")}</small></td><td>${esc(t.remoteLabel || "—")}<small>${esc(t.prefecture || "")}</small></td>` +
      `<td>${t.link ? `<span class="lp-link ${esc(t.link.status)}">${esc(t.link.statusLabel)}</span><small>${esc(day(t.link.updatedAt))}</small>` : '<small>未保存</small>'}</td></tr>`).join("")
      : `<tr><td colspan="7">${prep.tab === "linked" ? "この企業に紐づけた人材はまだありません。「全人材」から選んで保存してください。" : "条件に合う人材はいません。条件を減らしてお試しください。"}</td></tr>`;
    $("lp-bulk").hidden = !prep.selected.size;
    $("lp-selected").textContent = prep.selected.size + "人を選択";
    $("lp-all").checked = prep.rows.length > 0 && prep.rows.every((r) => prep.selected.has(r.id));
  }

  async function searchPrep(preloaded = null) {
    const n = gen;
    if (!$("lp-rows")) return;
    $("lp-status").textContent = "ENGER の人材を検索しています…";
    const f = prepFilters();
    const p = new URLSearchParams({ companyId: row.companyId, tab: prep.tab, page: String(prep.page) });
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    try {
      const d = preloaded || await API.api("/api/sales/company-talents?" + p);
      if (!live(n)) return;
      prep.rows = d.rows || [];
      $("lp-linked-count").textContent = d.linkedCount ? String(d.linkedCount) : "";
      $("lp-status").textContent = `${d.total.toLocaleString("ja-JP")}人` + (d.truncated ? "（新しい順に2,000人までを対象に絞り込み）" : "") +
        (d.missing?.length ? `　※ この環境では ${d.missing.join("・")} の列が無いため、その条件は使えません` : "") + (d.linkReady ? "" : `　※ ${d.linkHint}`);
      $("lp-page").textContent = `${d.page} / ${d.pages}ページ`;
      $("lp-prev").disabled = d.page <= 1; $("lp-next").disabled = d.page >= d.pages;
      prep.page = d.page;
      $("lp-save").disabled = !d.linkReady;
      drawPrepRows();
    } catch (e) {
      if (!live(n)) return;
      prep.rows = []; drawPrepRows();
      $("lp-status").textContent = errText(e, "人材を取得できませんでした。再度お試しください。");
    }
  }

  async function loadPrep() {
    const n = gen;
    prepShell(null);
    const qs = new URLSearchParams({ companyId: row.companyId });
    try {
      // The summary is complementary to the existing public-safe candidate list.
      // Failure to read the brief must not hide a working talent search.
      const [talentResult, briefResult] = await Promise.allSettled([
        API.api("/api/sales/company-talents?" + new URLSearchParams({ companyId: row.companyId, tab: "all" })),
        API.api("/api/sales/company-meeting-brief?" + qs),
      ]);
      if (!live(n)) return;
      if (talentResult.status !== "fulfilled") throw talentResult.reason;
      const d = talentResult.value;
      prep.options = d.options; prepShell(d.options);
      if (briefResult.status === "fulfilled" && briefResult.value?.company) {
        const brief = briefResult.value;
        renderMeetingBrief($("lp-brief"), brief, {
          filterBySkill: (skill) => {
            if (!live(n) || !$("lp-skills")) return;
            $("lp-skills").value = skill;
            if($("lp-search-details"))$("lp-search-details").open=true;
            prep.tab = "all"; prep.page = 1;
            document.querySelectorAll("[data-prep-tab]").forEach(b =>
              b.setAttribute("aria-pressed", String(b.dataset.prepTab === "all")));
            void searchPrep();
          },
          openTalent: (id) => { if (live(n)) void openTalent(id); },
        });
        // Use only one source-backed skill initially, not a guessed all-skills AND filter.
        const skill = brief.suggestions?.skills?.[0];
        if (skill) {
          $("lp-skills").value = skill; prep.page = 1;
          await searchPrep();
        } else {
          await searchPrep(d);
        }
      } else {
        $("lp-brief").innerHTML =
          '<p class="lc-error">企業サマリーを取得できませんでした。人材検索は利用できますが、企業の受領履歴に基づく候補の自動絞り込みは未確認です。</p>';
        await searchPrep(d);
      }
    } catch (e) {
      if (live(n)) $("lc-panel-prep").innerHTML = `<p class="lc-error">${esc(errText(e, "商談準備を読み込めませんでした。"))}</p>`;
    }
  }

  async function saveLinks(ids, status) {
    if (!ids.length) return;
    const n = gen;
    $("lp-save").disabled = true; $("lp-status").textContent = "保存しています…";
    try {
      const d = await API.api("/api/sales/company-talents", { method: "POST", body: { companyId: row.companyId, talentIds: ids, status } });
      if (!live(n)) return;
      prep.selected.clear();
      const label = { saved: "保存候補", planned: "提案予定", proposed: "提案済み", declined: "見送り" }[status] || status;
      const done = `${d.linked}人を「${label}」で保存しました。` + (d.skipped?.length ? `（${d.skipped.length}人は企業へ提示できない状態のため保存していません）` : "");
      await searchPrep();
      if (live(n) && $("lp-status")) $("lp-status").textContent = done + "　" + $("lp-status").textContent;
      loaded.delete("offers");
    } catch (e) {
      if (live(n)) $("lp-status").textContent = errText(e, "保存できませんでした。再度お試しください。");
    } finally { if ($("lp-save")) $("lp-save").disabled = false; }
  }

  // 人材詳細（サマリーを最初に出す。スキルシートはタブで1クリック）
  async function openTalent(id) {
    const dlg = $("lc-talent-dialog"), n = gen;
    $("lc-talent-title").textContent = "人材の詳細";
    $("lc-talent-body").innerHTML = '<p class="lc-detail-note">読み込み中…</p>';
    if (!dlg.open) dlg.showModal();
    try {
      const d = await API.api("/api/sales/company-talents?" + new URLSearchParams({ companyId: row.companyId, id }));
      if (!live(n)) return;
      const t = d.talent;
      $("lc-talent-title").textContent = `${t.displayName}（${t.talentNo || "番号なし"}）`;
      const kv = (k, v) => `<div class="lc-kv"><dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd></div>`;
      $("lc-talent-body").innerHTML =
        `<div class="lp-subtabs" role="tablist" aria-label="人材詳細"><button type="button" role="tab" data-talent-view="summary" aria-selected="true">サマリー</button><button type="button" role="tab" data-talent-view="sheet" aria-selected="false">スキルシート（公開用）</button></div>` +
        `<section data-talent-panel="summary"><p>${badges(t)}</p><dl>${kv("職種", [t.title, ...(t.roles || [])].filter(Boolean).join(" / "))}${kv("経験年数", t.experience)}${kv("稼働開始", t.availability)}${kv("稼働日数", t.weekDays)}${kv("働き方", t.remoteLabel)}${kv("居住地", t.prefecture)}${kv("最寄り駅", t.nearestStation)}${kv("年代", t.ageBand)}</dl>` +
        `<div class="lp-skills">${(t.skills || []).map((s) => `<span>${esc(s)}</span>`).join("")}</div></section>` +
        `<section data-talent-panel="sheet" hidden><h4>${esc(d.sheet.title)}</h4><dl>${d.sheet.rows.map(([k, v]) => kv(k, v)).join("")}</dl><div class="lp-skills">${d.sheet.skills.map((s) => `<span>${esc(s)}</span>`).join("")}</div><p class="lc-detail-note">${esc(d.sheet.note)}</p></section>` +
        `<section class="lp-link-editor"><h4>この企業への紐づけ（社内向け・企業には表示しません）</h4>` +
        (d.linkReady ? `<label>状態<select id="lt-status">${LINK_ORDER.map((k) => `<option value="${k}" ${d.link?.status === k ? "selected" : ""}>${esc({ saved: "保存候補", planned: "提案予定", proposed: "提案済み", declined: "見送り" }[k])}</option>`).join("")}</select></label>` +
          (d.link ? `<label>社内メモ<textarea id="lt-note" rows="3" maxlength="1000">${esc(d.link.note)}</textarea></label><button type="button" id="lt-save" class="lc-primary">状態・メモを保存</button><small>最終更新 ${esc(stamp(d.link.updatedAt))}</small>` : `<button type="button" id="lt-link" class="lc-primary">この企業に保存</button>`)
          : '<p class="lc-detail-note">紐づけの DB が未適用のため保存できません。</p>') +
        `<p id="lt-status-msg" class="lc-detail-note" role="status"></p></section>` +
        `<p><a class="lc-link" href="${esc(d.dxUrl)}" target="_blank" rel="noopener noreferrer">ENGER DX で人材詳細を開く ↗</a><small class="lc-detail-note">（ENGER DX のログイン・権限で開きます。経歴・スキルシート原本の確認はこちら）</small></p>`;
      document.querySelectorAll("[data-talent-view]").forEach((b) => (b.onclick = () => {
        document.querySelectorAll("[data-talent-view]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
        document.querySelectorAll("[data-talent-panel]").forEach((p) => (p.hidden = p.dataset.talentPanel !== b.dataset.talentView));
      }));
      if ($("lt-link")) $("lt-link").onclick = async () => { await saveLinks([t.id], $("lt-status").value); if (live(n)) void openTalent(id); };
      if ($("lt-save")) $("lt-save").onclick = async () => {
        $("lt-save").disabled = true; $("lt-status-msg").textContent = "保存しています…";
        try {
          await API.api("/api/sales/company-talents", { method: "PATCH", body: { companyId: row.companyId, talentId: t.id, status: $("lt-status").value, note: $("lt-note").value } });
          if (!live(n)) return;
          $("lt-status-msg").textContent = "保存しました。"; loaded.delete("offers"); void searchPrep();
        } catch (e) { $("lt-status-msg").textContent = errText(e, "保存できませんでした。"); }
        finally { if ($("lt-save")) $("lt-save").disabled = false; }
      };
    } catch (e) {
      if (live(n)) $("lc-talent-body").innerHTML = `<p class="lc-error">${esc(errText(e, "人材の詳細を取得できませんでした。"))}</p>`;
    }
  }

  // ---------------------------------------------------------------- 企業ポータル
  let portal = null;
  async function loadPortal(message = "") {
    const n = gen;
    try {
      const d = await API.api("/api/sales/company-portal?" + new URLSearchParams({ companyId: row.companyId }));
      if (!live(n)) return;
      portal = d; drawPortal(message);
    } catch (e) {
      if (live(n)) $("lc-panel-portal").innerHTML = `<p class="lc-error">${esc(errText(e, "企業ポータルの情報を読み込めませんでした。"))}</p>`;
    }
  }

  function drawPortal(message) {
    const d = portal, u = d.usage;
    $("lc-panel-portal").innerHTML =
      `<div class="lp-wrap"><p class="lc-detail-note">企業担当者が ENGER business（<a class="lc-link" href="${esc(d.portal.loginUrl)}" target="_blank" rel="noopener noreferrer">${esc(d.portal.loginUrl)}</a>）にログインし、人材の検索・詳細の確認・保存を行えます。アカウントはこの企業ID（${esc(row.companyId)}）に紐づきます。</p>` +
      `<div class="lp-actions"><button type="button" id="pt-preview">企業向けの人材表示を確認（社内プレビュー）</button><small>社内確認用です。企業本人としてログインする操作ではありません。</small></div>` +
      `<div class="lp-kpis"><div><b>${d.members.filter((m) => m.status === "active").length}</b><small>有効なアカウント</small></div><div><b>${u.logins30}</b><small>ログイン（30日）</small></div><div><b>${u.searches30}</b><small>人材検索（30日）</small></div><div><b>${u.views30}</b><small>人材詳細の閲覧（30日）</small></div><div><b>${d.saved.length}</b><small>企業が保存した人材</small></div></div>` +
      `<p id="pt-msg" class="lp-msg" role="status" aria-live="polite">${esc(message)}</p><div id="pt-invite-url"></div>` +
      `<section class="lp-card"><h4>アカウント発行</h4><form id="pt-form" class="lp-filters"><input id="pt-name" maxlength="100" placeholder="企業担当者の氏名" aria-label="企業担当者の氏名" required><input id="pt-email" type="email" maxlength="254" placeholder="メールアドレス（ログインID）" aria-label="メールアドレス" required>` +
      `<select id="pt-role" aria-label="権限">${Object.entries(d.roles).map(([k, l]) => `<option value="${esc(k)}" ${k === "member" ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>` +
      `<label class="lp-check"><input type="checkbox" id="pt-mail" ${d.mail.configured ? "checked" : "disabled"}> 企業担当者へ専用URLをメールで送る</label><button type="submit" class="lc-primary">アカウントを発行</button></form>` +
      `<p class="lc-detail-note">企業担当者は専用URLからパスワードなしで利用を開始できます（有効期限24時間・1回限り）。通常のログインもメールリンクが基本で、パスワードは任意です。${d.mail.configured ? "" : "招待メールは未設定です（" + esc(d.mail.reason) + "）。発行後に表示されるリンクを担当者へお送りください。"}</p></section>` +
      `<section class="lp-card"><h4>担当者一覧</h4><div class="lc-table-wrap"><table class="lc-table"><thead><tr><th>氏名・ログインID</th><th>権限</th><th>状態</th><th>招待・登録</th><th>最終ログイン</th><th>操作</th></tr></thead><tbody>` +
      (d.members.length ? d.members.map((m) => `<tr><td><strong>${esc(m.displayName)}</strong><small>${esc(m.email)}</small></td>` +
        `<td><select data-role="${esc(m.id)}" aria-label="${esc(m.displayName)}の権限" ${m.status === "disabled" ? "disabled" : ""}>${Object.entries(d.roles).map(([k, l]) => `<option value="${esc(k)}" ${m.role === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></td>` +
        `<td><span class="lp-member ${esc(m.status)}">${esc(m.statusLabel)}</span>${m.disabledReason ? `<small>${esc(m.disabledReason)}</small>` : ""}</td>` +
        `<td><small>招待 ${esc(stamp(m.invitedAt))}</small>${m.inviteExpiresAt ? `<small>期限 ${esc(stamp(m.inviteExpiresAt))}</small>` : ""}<small>登録 ${esc(stamp(m.registeredAt))}</small></td><td>${esc(stamp(m.lastLoginAt))}</td>` +
        `<td class="lp-actions">${m.status !== "active" && m.status !== "disabled" ? `<button type="button" data-reinvite="${esc(m.id)}">再招待</button>` : ""}${m.status === "active" ? `${d.mail.configured ? `<button type="button" data-login-link="${esc(m.id)}">ログインURLを送る</button>` : ""}<a class="lc-link" href="${esc(d.portal.resetUrl)}" target="_blank" rel="noopener noreferrer">パスワード再設定</a>` : ""}${m.status === "disabled" ? (d.canEnable ? `<button type="button" data-enable="${esc(m.id)}">再開</button>` : "<small>再開は責任者が行います</small>") : `<button type="button" data-disable="${esc(m.id)}" data-name="${esc(m.displayName)}">停止</button>`}</td></tr>`).join("")
        : '<tr><td colspan="6">まだアカウントはありません。上のフォームから発行してください。</td></tr>') +
      `</tbody></table></div><div id="pt-disable" class="lp-confirm" hidden><p id="pt-disable-text"></p><label>停止の理由<input id="pt-disable-reason" maxlength="300" placeholder="例：退職・契約終了"></label><button type="button" id="pt-disable-go" class="lc-primary">停止する</button><button type="button" id="pt-disable-cancel">やめる</button></div></section>` +
      `<section class="lp-card"><h4>企業が保存した人材 <small>${d.saved.length}人（企業内で共有）</small></h4>${d.saved.length ? `<ul class="lp-list">${d.saved.map((s) => `<li><strong>${esc(s.displayName)}</strong> ${esc(s.talentNo || "")} ${esc(s.title || "")}<small>${esc(s.savedBy)}・${esc(stamp(s.savedAt))}</small></li>`).join("")}</ul>` : '<p class="lc-detail-note">まだありません。</p>'}</section>` +
      `<section class="lp-card"><h4>利用履歴・操作の記録 <small>新しい順</small></h4>${d.events.length ? `<ul class="lp-list">${d.events.map((e) => `<li><small>${esc(stamp(e.at))}・${esc(e.actorKind === "staff" ? "社内" : e.actorKind === "portal" ? "企業" : "システム")}${e.member ? "・" + esc(e.member) : ""}</small><strong>${esc(e.label)}</strong>${e.targetId ? ` <small>${esc(e.targetId)}</small>` : ""}${e.detail ? `<small>${esc(e.detail)}</small>` : ""}</li>`).join("")}</ul>` : '<p class="lc-detail-note">記録はまだありません。</p>'}${d.usageComplete ? "" : '<p class="lc-detail-note">直近300件までを集計しています。</p>'}</section></div>`;

    $("pt-form").onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.submitter || $("pt-form").querySelector("button"); btn.disabled = true; $("pt-msg").textContent = "発行しています…";
      try {
        const r = await API.api("/api/sales/company-portal", { method: "POST", body: { action: "invite", companyId: row.companyId, displayName: $("pt-name").value, email: $("pt-email").value, role: $("pt-role").value, sendMail: $("pt-mail").checked } });
        await loadPortal(`${r.member.displayName} さんのアカウントを発行しました。` + mailNote(r));
        showInvite(r);
      } catch (err) { $("pt-msg").textContent = errText(err, "発行できませんでした。"); btn.disabled = false; }
    };
    $("pt-preview").onclick = () => select("prep");
    document.querySelectorAll("[data-login-link]").forEach((b) => (b.onclick = async () => {
      if (!confirm("この企業担当者の登録メールに、1回限りのログインURLを送信しますか？")) return;
      await post({ action: "login_link", memberId: b.dataset.loginLink }, b, "登録メールにログインURLを送信しました。");
    }));
    document.querySelectorAll("[data-reinvite]").forEach((b) => (b.onclick = () => post({ action: "reinvite", memberId: b.dataset.reinvite, sendMail: d.mail.configured && confirm("企業担当者へ専用URLをメール送信しますか？（キャンセル＝リンクだけ発行）") }, b, "招待リンクを再発行しました。古いリンクは使えなくなりました。")));
    document.querySelectorAll("[data-enable]").forEach((b) => (b.onclick = () => post({ action: "enable", memberId: b.dataset.enable }, b, "アカウントを再開しました。")));
    document.querySelectorAll("[data-role]").forEach((s) => (s.onchange = () => post({ action: "role", memberId: s.dataset.role, role: s.value }, s, "権限を変更しました。")));
    let target = null;
    document.querySelectorAll("[data-disable]").forEach((b) => (b.onclick = () => { target = b.dataset.disable; $("pt-disable").hidden = false; $("pt-disable-text").textContent = `${b.dataset.name} さんを停止します。停止するとすぐにログイン・検索・保存ができなくなります。`; $("pt-disable-reason").focus(); }));
    $("pt-disable-cancel").onclick = () => { target = null; $("pt-disable").hidden = true; };
    $("pt-disable-go").onclick = () => target && post({ action: "disable", memberId: target, reason: $("pt-disable-reason").value }, $("pt-disable-go"), "アカウントを停止しました。");
  }

  const mailNote = (r) => (r.mail === "sent" ? "招待メールを送信しました（送信受付）。" : r.mail === "failed" ? `招待メールを送れませんでした（${r.mailError || "理由不明"}）。下のリンクをお送りください。` : "下の招待リンクを企業担当者へお送りください。");

  function showInvite(r) {
    if (!r.inviteUrl || !$("pt-invite-url")) return;
    $("pt-invite-url").innerHTML = `<div class="lp-invite"><strong>招待リンク（この画面を閉じると二度と表示されません）</strong><code id="pt-url">${esc(r.inviteUrl)}</code><button type="button" id="pt-copy">リンクをコピー</button><small>有効期限 ${esc(stamp(r.expiresAt))}・1回だけ使えます。</small></div>`;
    $("pt-copy").onclick = async () => { try { await navigator.clipboard.writeText(r.inviteUrl); $("pt-copy").textContent = "コピーしました"; } catch { $("pt-copy").textContent = "選択してコピーしてください"; } };
  }

  async function post(body, el, done) {
    el.disabled = true; if ($("pt-msg")) $("pt-msg").textContent = "保存しています…";
    try {
      const r = await API.api("/api/sales/company-portal", { method: "POST", body: { companyId: row.companyId, ...body } });
      const ban = r.authBan && !r.authBan.applied && r.authBan.reason === "shared_account" ? "（ほかのサービスと兼用のアカウントのため、企業ポータルの利用だけを止めました）" : "";
      await loadPortal(done + ban + (r.inviteUrl ? mailNote(r) : "") + (r.hint ? r.hint : ""));
      if (r.inviteUrl) showInvite(r);
    } catch (e) { if ($("pt-msg")) $("pt-msg").textContent = errText(e, "保存できませんでした。"); el.disabled = false; }
  }

  // ---------------------------------------------------------------- オファー・進捗
  async function loadOffers() {
    const n = gen;
    try {
      const d = await API.api("/api/sales/company-progress?" + new URLSearchParams({ companyId: row.companyId }));
      if (!live(n)) return;
      const c = d.prep.counts || {};
      $("lc-panel-offers").innerHTML =
        `<div class="lp-wrap"><p class="lp-msg">${esc(d.portalOffers.note)}</p>` +
        `<section class="lp-card"><h4>商談準備の人材</h4><div class="lp-kpis">${LINK_ORDER.map((k) => `<div><b>${c[k] || 0}</b><small>${esc(d.prep.labels[k])}</small></div>`).join("")}</div>${d.prep.ready ? "" : '<p class="lc-detail-note">商談準備の DB が未適用です。</p>'}</section>` +
        `<section class="lp-card"><h4>提案・面談・成約の進捗 <small>${d.scope === "all" ? "全担当" : "あなたが担当の提案だけ"}</small></h4>` +
        (d.proposalsHint ? `<p class="lc-detail-note">${esc(d.proposalsHint)}</p>` : "") +
        `<div class="lc-table-wrap"><table class="lc-table"><thead><tr><th>状態</th><th>案件・人材</th><th>営業担当</th><th>マッチング確定</th><th>企業へ提案</th><th>面談</th><th>終了・理由</th><th></th></tr></thead><tbody>` +
        (d.proposals.length ? d.proposals.map((p) => `<tr><td><span class="lp-member">${esc(p.statusLabel)}</span>${p.engerStage ? `<small>ENGER：${esc(p.engerStage)}</small>` : ""}</td><td>${esc(p.jobTitle || p.title)}<small>人材 ${esc(p.talentInitials || "—")}${p.matchingOwner ? "・マッチング " + esc(p.matchingOwner) : ""}</small></td><td>${esc(p.salesOwner || "未割当")}</td><td>${esc(stamp(p.matchedAt))}</td><td>${esc(stamp(p.sentAt))}</td><td>${esc(stamp(p.meetingAt))}</td><td>${esc(stamp(p.closedAt))}${p.closeReasonLabel ? `<small>${esc(p.closeReasonLabel)}</small>` : ""}</td><td><a class="lc-link" href="${esc(p.url)}">提案を開く</a></td></tr>`).join("")
          : '<tr><td colspan="8">この企業IDに紐づく提案はまだありません。</td></tr>') +
        `</tbody></table></div><p class="lc-detail-note">面談・交渉・成約・見送りの記録は「提案」画面で行います（履歴・担当・日時はそちらが正本です）。</p></section></div>`;
    } catch (e) {
      if (live(n)) $("lc-panel-offers").innerHTML = `<p class="lc-error">${esc(errText(e, "進捗を読み込めませんでした。"))}</p>`;
    }
  }

  $("lc-talent-close")?.addEventListener("click", () => $("lc-talent-dialog").close());
  return { open, select };
}
