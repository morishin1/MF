// 経営（/keiei）の「給与管理」。社員の給与を、適用開始日つきで記録し、履歴と監査ログを見る。
//
// ■ 考え方（docs/keiei-pay-management.md）
//   ・給与は上書きしない。「いつから、いくら」の行を足していく（履歴は消えない。消す・書き換えるボタンは無い）
//   ・給与を変える＝新しい適用開始日で記録する／入力の誤りを直す＝同じ適用開始日の「訂正」として記録する
//   ・変更理由（またはメモ）は必須。変更前・変更後・変更者・日時が、履歴と監査ログに残る
//   ・契約・内定・入社情報は「参照」。ここから書き換わらない。食い違いは見せるだけ（直すのは経営者の判断）
//   ・判定（いまの給与・状態・種別・版）は、サーバが返したものをそのまま出す。ここで計算し直さない
//
// index.html（/keiei）から window.KeieiPay.list(main, isStale) / open(id, main, isStale) / audit(main, isStale) で呼ばれる。
(function () {
  const esc = window.KeieiLayout ? window.KeieiLayout.esc
    : (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MISSING = "データ未連携";

  const yen = (n) => (n == null ? "—" : `${Math.round(Number(n)).toLocaleString("ja-JP")}円`);
  const jpDay = (d) => (d ? String(d).slice(0, 10).replace(/-/g, "/") : "");
  const jp = (iso) => {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const j = new Date(t + 9 * 3600000);
    return `${j.getUTCFullYear()}/${j.getUTCMonth() + 1}/${j.getUTCDate()} ${String(j.getUTCHours()).padStart(2, "0")}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
  };
  const banner = (text, kind = "") => `<div class="kei-banner ${kind}">${esc(text)}</div>`;
  const pill = (text, kind = "miss") => `<span class="kei-pill ${kind}">${esc(text)}</span>`;
  const head = (title, sub) => `<h1 class="kei-title" data-role="title">${esc(title)}</h1><p class="kei-sub">${esc(sub || "")}</p>`;
  const card = (label, val, sub = "", role = "") => `<div class="kei-card"${role ? ` data-role="${role}"` : ""}><div class="lb"><span>${esc(label)}</span></div><div class="val">${val}</div><div class="sub">${esc(sub)}</div></div>`;

  /** 賃金の種別ごとの、基本給の言い方 */
  const baseText = (r) => (r ? `${r.wageType} ${yen(r.baseAmount)}` : "—");
  const allowText = (r) => (r && r.allowances.length ? r.allowances.map((a) => `${a.name} ${yen(a.amount)}`).join("、") : "なし");
  const monthText = (r) => {
    if (!r) return "—";
    const m = r.monthly;
    return m.total != null ? yen(m.total) : `月額に直せません（${r.wageType}）`;
  };
  const KIND = { initial: "初回", change: "変更", correction: "訂正" };
  const SOURCE = { owner: "経営者の入力", contract_import: "契約から取り込み", offer_import: "内定から取り込み" };
  const CHECK = { match: "契約と一致", type: "契約と種別が違う", amount: "契約と金額が違う", none: "契約に賃金なし", unsupported: "契約の種別を取り込めません", unregistered: "給与管理に未登録" };
  const FLAG = { unregistered: ["未登録", "warn"], future_only: ["適用前", "prov"], upcoming: ["変更予定", "prov"], mismatch: ["契約と不一致", "warn"] };
  const flagPills = (flags) => (flags || []).map((f) => `<span class="kei-pill ${FLAG[f] ? FLAG[f][1] : "miss"}" data-flag="${esc(f)}">${esc(FLAG[f] ? FLAG[f][0] : f)}</span>`).join(" ");
  const STATUS = { active: "在籍", leaving: "退職予定", invited: "入社準備", left: "退職" };

  let main = null;
  let stale = () => false;
  const alive = () => main && !stale();

  // ---- 共通: 読み込み ---------------------------------------------------------------
  async function load(url, mount, isStale, backHref) {
    main = mount; stale = isStale || (() => false);
    try {
      const d = await API.api(url);
      if (!alive()) return null;
      return d;
    } catch (e) {
      if (!alive()) return null;
      if (e.code === "mfa_required") return null;                 // api-client がマイページへ送る
      if (e.status === 403) { location.replace("/home.html"); return null; }
      main.innerHTML = `${backHref ? `<a class="kei-back2" href="${backHref}">← 給与管理へ</a>` : ""}${banner(e.hint || e.message || "読み込めませんでした", "err")}`;
      return null;
    }
  }
  const notLinked = (d) => head("給与管理", "") + banner(`${MISSING}。${d.hint || "給与の履歴の表がまだ作られていません（db/105_compensation.sql の適用を依頼してください）"}`, "warn");

  // =====================================================================================
  // 一覧
  // =====================================================================================
  let L = null;                        // { data, scope, flag, q }

  async function list(mount, isStale) {
    const d = await load("/api/keiei/pay?view=list", mount, isStale);
    if (!d) return;
    if (!d.linked) { main.innerHTML = notLinked(d); return; }
    L = { data: d, scope: "service", flag: "", q: "" };
    renderList();
    window.scrollTo(0, 0);
  }

  const inScope = (r, scope) => (scope === "all" ? true : scope === "service" ? ["active", "leaving"].includes(r.status)
    : scope === "invited" ? r.status === "invited" : r.status === "left");

  function renderList() {
    const d = L.data;
    const s = d.summary;
    const rows = d.rows.filter((r) => inScope(r, L.scope)
      && (!L.flag || r.flags.includes(L.flag))
      && (!L.q || String(r.name || "").includes(L.q) || String(r.department || "").includes(L.q)));

    const body = rows.map((r) => {
      const c = r.current;
      return `<tr data-employee="${esc(r.id)}" class="${c ? "" : "dim"}">
        <td><a href="#pay/${encodeURIComponent(r.id)}" data-role="open"><b>${esc(r.name)}</b></a><div class="kei-mute">${esc(STATUS[r.status] || r.status)}</div></td>
        <td>${esc([r.department, r.position].filter(Boolean).join("・"))}</td>
        <td>${c ? esc(c.wageType) : "—"}</td>
        <td class="n">${c ? yen(c.baseAmount) : "—"}</td>
        <td class="n">${c ? yen(c.monthly.allowanceTotal) : "—"}</td>
        <td class="n">${c ? (c.commuteAmount == null ? "—" : yen(c.commuteAmount)) : "—"}</td>
        <td class="n">${c ? (c.monthly.total != null ? yen(c.monthly.total) : "—") : "—"}</td>
        <td>${c ? esc(jpDay(c.effectiveFrom)) : ""}${r.next ? `<div class="kei-mute">${esc(jpDay(r.next.effectiveFrom))} から ${esc(baseText(r.next))}</div>` : ""}</td>
        <td>${flagPills(r.flags)}</td>
        <td class="n">${r.contract ? `<span class="kei-mute" title="契約上の賃金（参照）">${esc(r.contract.wageType || "")} ${yen(r.contract.wageAmount)}</span>` : "—"}</td>
      </tr>`;
    }).join("");

    const opt = (v, t, cur) => `<option value="${v}"${cur === v ? " selected" : ""}>${t}</option>`;
    main.innerHTML = `${head("給与管理", "社員の給与を、適用開始日つきで記録します。履歴は消えません。経営者だけが見られます。")}
      ${banner("給与の額を直す場所は、ここだけです。契約・内定・入社情報の金額は「参照」で、ここから書き換わりません（食い違いは、下の「契約上の賃金」の列と状態で分かります）。"
        + "人事・管理者の既存の画面での給与の扱いは、この工程では変わりません。", "")}
      <div class="kei-grid sm" data-role="summary">
        ${card("在籍", `${s.inService}<small>人</small>`, `登録済み ${s.registered}人`, "s-inservice")}
        ${card("未登録・適用前", `${s.unregistered}<small>人</small>`, "給与を記録すると減ります", "s-unregistered")}
        ${card("契約と不一致", `${s.mismatch}<small>人</small>`, s.contractsLinked ? "契約の賃金と違う人" : `契約を読めていません（${MISSING}）`, "s-mismatch")}
        ${card("変更予定", `${s.upcoming}<small>人</small>`, "これから給与が変わる人", "s-upcoming")}
        ${card("月額の合計（暫定）", `${yen(s.monthlyTotal)}`, `月給・年俸の${s.monthlyCounted}人分（基本給＋手当＋通勤手当）。時給・日給の${s.hourlyLike}人は含みません`, "s-total")}
      </div>
      <div class="kei-panel" style="margin-top:14px;">
        <div class="pay-filters">
          <label>表示 <select id="pay-scope">${opt("service", "在籍中", L.scope)}${opt("invited", "入社準備中", L.scope)}${opt("left", "退職者", L.scope)}${opt("all", "全員", L.scope)}</select></label>
          <label>状態 <select id="pay-flag"><option value="">すべて</option>${["unregistered", "future_only", "upcoming", "mismatch"].map((f) => opt(f, FLAG[f][0], L.flag)).join("")}</select></label>
          <label>氏名・所属 <input id="pay-q" type="search" value="${esc(L.q)}" placeholder="絞り込み"></label>
          <a class="kei-btn sec sm" href="#pay-audit" data-role="to-audit">監査ログを見る</a>
        </div>
        <div class="kei-tw"><table class="kei-t" data-role="pay-table"><thead><tr>
          <th>氏名</th><th>所属・役職</th><th>種別</th><th class="n">基本給</th><th class="n">手当（月）</th><th class="n">通勤手当（月）</th><th class="n">月額の見立て</th><th>適用開始日</th><th>状態</th><th class="n">契約上の賃金（参照）</th>
        </tr></thead><tbody>${body || `<tr><td colspan="10" class="kei-empty">該当する人はいません。</td></tr>`}</tbody></table></div>
        <div class="kei-note">${d.summary.bpExcluded ? `BP（外部パートナー）${d.summary.bpExcluded}人は、給与の管理の対象外です（現場単価は、給与とは別に扱います）。` : ""}
          時給・日給は、実際に働いた時間・日数が決まらないので、月額の合計は出しません。</div>
      </div>`;
    main.querySelector("#pay-scope").addEventListener("change", (e) => { L.scope = e.target.value; renderList(); });
    main.querySelector("#pay-flag").addEventListener("change", (e) => { L.flag = e.target.value; renderList(); });
    const q = main.querySelector("#pay-q");
    q.addEventListener("input", (e) => { L.q = e.target.value.trim(); const pos = e.target.selectionStart; renderList(); const n = main.querySelector("#pay-q"); n.focus(); n.setSelectionRange(pos, pos); });
  }

  // =====================================================================================
  // 個人
  // =====================================================================================
  let D = null;                        // 詳細（サーバの応答）
  let empId = null;
  let F = null;                        // 入力フォームの値
  let P = null;                        // プレビュー { plan, sig }
  let T = { msg: null, err: null };    // 完了メッセージ・エラー

  const blankForm = (mode = "change") => ({
    mode, effectiveFrom: "", wageType: "月給", baseAmount: "", allowances: [], commuteAmount: "", commuteNote: "", reason: "", source: "owner", importRef: null,
  });
  const formFrom = (rec, mode) => ({
    mode, effectiveFrom: mode === "correct" ? rec.effectiveFrom : "", wageType: rec.wageType, baseAmount: String(rec.baseAmount),
    allowances: rec.allowances.map((a) => ({ name: a.name, amount: String(a.amount) })),
    commuteAmount: rec.commuteAmount == null ? "" : String(rec.commuteAmount), commuteNote: rec.commuteNote || "", reason: "", source: "owner", importRef: null,
  });

  async function open(id, mount, isStale) {
    empId = id;
    const d = await load(`/api/keiei/pay?view=detail&employeeId=${encodeURIComponent(id)}`, mount, isStale, "#pay");
    if (!d) return;
    if (!d.linked) { main.innerHTML = notLinked(d); return; }
    D = d; P = null; T = { msg: null, err: null };
    F = D.current ? formFrom(D.current, "change") : blankForm("change");
    renderDetail();
    window.scrollTo(0, 0);
  }

  function currentPanel() {
    const c = D.current;
    if (!c) {
      const future = D.upcoming.length ? `　これから始まる記録はあります（${esc(jpDay(D.upcoming[0].effectiveFrom))} から）。` : "";
      return `<div class="kei-panel" data-section="current"><h3 class="kei-h3">いまの給与</h3>
        <div class="kei-empty" data-role="no-current">まだ、給与が記録されていません。${future}下の「給与を記録する」から、最初の記録を入れてください。</div></div>`;
    }
    const m = c.monthly;
    return `<div class="kei-panel" data-section="current"><h3 class="kei-h3">いまの給与 <span class="kei-mute">${esc(jpDay(c.effectiveFrom))} から適用</span> ${flagPills(D.flags)}</h3>
      <dl class="kei-dl" data-role="current">
        <dt>賃金の種別</dt><dd>${esc(c.wageType)}</dd>
        <dt>基本給</dt><dd data-role="base">${esc(yen(c.baseAmount))}${c.wageType === "年俸" ? `（月額換算 ${esc(yen(m.base))}）` : ""}</dd>
        <dt>手当（月）</dt><dd data-role="allowances">${esc(allowText(c))}${c.allowances.length ? `（合計 ${esc(yen(m.allowanceTotal))}）` : ""}</dd>
        <dt>通勤手当（月）</dt><dd data-role="commute">${c.commuteAmount == null ? "未設定" : esc(yen(c.commuteAmount))}${c.commuteNote ? `　${esc(c.commuteNote)}` : ""}</dd>
        <dt>月額の見立て</dt><dd data-role="total">${esc(monthText(c))}${m.total != null ? "（基本給＋手当＋通勤手当）" : ""}</dd>
        <dt>この記録</dt><dd>${esc(KIND[c.kind])}${c.revision > 1 ? `（版${c.revision}）` : ""}・${esc(c.createdBy || "")}・${esc(jp(c.createdAt))}<br><span class="kei-mute">理由：${esc(c.reason)}</span></dd>
      </dl>
      ${D.upcoming.length ? `<div class="kei-note" data-role="upcoming">これから：${D.upcoming.map((u) => `${esc(jpDay(u.effectiveFrom))} から ${esc(baseText(u))}${u.allowances.length ? `＋手当` : ""}`).join(" → ")}</div>` : ""}
    </div>`;
  }

  function referencePanel() {
    const r = D.references;
    const c = r.contract;
    let contractHtml;
    if (c.unavailable) contractHtml = `<b>${MISSING}</b>（契約を読めませんでした）`;
    else if (!c.view) contractHtml = `<span class="kei-mute">有効な契約に、賃金がありません</span>`;
    else {
      const v = c.view;
      contractHtml = `${esc(v.wageType || "種別なし")} ${esc(yen(v.wageAmount))}　${pill(CHECK[c.check] || c.check, c.check === "match" ? "ok" : c.check === "type" || c.check === "amount" ? "warn" : "miss")}
        ${v.wageNote ? `<div class="kei-note">契約の注記（手当・控除など）：${esc(v.wageNote)}</div>` : ""}`;
    }
    const canContract = c.view && ["月給", "年俸", "時給", "日給"].includes(c.view.wageType);
    const offer = r.offer;
    return `<div class="kei-panel" data-section="references"><h3 class="kei-h3">参照（ここから書き換わりません）</h3>
      <dl class="kei-dl">
        <dt>契約上の賃金</dt><dd data-role="ref-contract">${contractHtml}${canContract ? `<div><button class="kei-btn sec sm" data-act="import-contract">契約の賃金を入力欄に写す</button></div>` : ""}</dd>
        <dt>内定時の給与</dt><dd data-role="ref-offer">${offer ? `${esc(offer.wageType || "")} ${esc(yen(offer.wageAmount))}（${esc(offer.from)}）${["月給", "年俸", "時給", "日給"].includes(offer.wageType) ? `<div><button class="kei-btn sec sm" data-act="import-offer">内定の給与を入力欄に写す</button></div>` : ""}` : `<span class="kei-mute">なし</span>`}</dd>
        <dt>本人が届け出た定期代</dt><dd data-role="ref-commute">${r.commuteDeclared == null ? `<span class="kei-mute">届出なし</span>` : `${esc(yen(r.commuteDeclared))}（1か月。会社が決めた通勤手当ではありません）`}</dd>
      </dl>
      <div class="kei-note">「写す」は入力欄に値を入れるだけです。内容を確かめて、理由を書き、記録して初めて給与になります。契約や内定は変わりません。</div>
    </div>`;
  }

  // ---- 入力フォーム ---------------------------------------------------------------
  function allowRows() {
    return F.allowances.map((a, i) => `<div class="pay-arow" data-i="${i}">
        <input type="text" name="a-name" list="pay-presets" value="${esc(a.name)}" placeholder="手当の名前（例：役職手当）" maxlength="40">
        <input type="text" name="a-amount" inputmode="numeric" value="${esc(a.amount)}" placeholder="月額（円）">
        <button type="button" class="kei-btn sec sm" data-act="rm-allow" data-i="${i}" aria-label="この手当の行を消す（入力欄だけ。記録済みの履歴は消えません）">×</button></div>`).join("");
  }

  function formPanel() {
    const groups = D.groups;
    const correct = F.mode === "correct";
    const datesSel = groups.map((g) => `<option value="${esc(g.effectiveFrom)}"${F.effectiveFrom === g.effectiveFrom ? " selected" : ""}>${esc(jpDay(g.effectiveFrom))}（版${g.latestRevision}）</option>`).join("");
    const dateCtl = correct
      ? `<select name="effectiveFrom" data-role="correct-date"><option value="">選んでください</option>${datesSel}</select>`
      : `<input type="date" name="effectiveFrom" value="${esc(F.effectiveFrom)}" data-role="effective-from" min="2000-01-01">`;
    const wt = D.meta.wageTypes.map((w) => `<option value="${esc(w)}"${F.wageType === w ? " selected" : ""}>${esc(w)}</option>`).join("");
    return `<div class="kei-panel" data-section="form"><h3 class="kei-h3">給与を記録する</h3>
      <div class="kei-inline" style="margin-bottom:8px;">
        <label><input type="radio" name="mode" value="change" ${correct ? "" : "checked"}> 給与を変える（新しい適用開始日）</label>
        <label><input type="radio" name="mode" value="correct" ${correct ? "checked" : ""} ${groups.length ? "" : "disabled"}> 入力の誤りを訂正する（同じ適用開始日の次の版）</label>
      </div>
      <div class="kei-note">${correct
        ? "訂正しても、前の版は履歴に残ります。誤りの前後が、あとから確認できます。給与そのものを変えるときは、「給与を変える」で新しい適用開始日を入れてください。"
        : "「いつから、この給与か」を必ず入れます。過去の日付からの適用（遡及）や、これからの日付（予定）も入れられます。前の記録は、そのまま残ります。"}</div>
      <form id="pay-form" class="kei-form" autocomplete="off">
        <label class="kei-f"><span>適用開始日（いつから）${correct ? "　※訂正する記録の日付" : ""}</span>${dateCtl}</label>
        <label class="kei-f"><span>賃金の種別</span><select name="wageType">${wt}</select></label>
        <label class="kei-f"><span>基本給（円）　※月給は月額・年俸は年額・時給は1時間・日給は1日</span><input type="text" name="baseAmount" inputmode="numeric" value="${esc(F.baseAmount)}" placeholder="例：300000"></label>
        <label class="kei-f"><span>通勤手当（月額・円）　空欄＝なし</span><input type="text" name="commuteAmount" inputmode="numeric" value="${esc(F.commuteAmount)}" placeholder="例：10000"></label>
        <div class="kei-f wide"><span>手当（月額・円）</span>
          <div id="pay-allow">${allowRows()}</div>
          <div><button type="button" class="kei-btn sec sm" data-act="add-allow">＋ 手当を追加</button></div>
          <datalist id="pay-presets">${D.meta.allowancePresets.map((p) => `<option value="${esc(p)}">`).join("")}</datalist></div>
        <label class="kei-f wide"><span>通勤手当のメモ（任意）</span><input type="text" name="commuteNote" value="${esc(F.commuteNote)}" maxlength="200" placeholder="例：上限あり・定期代の実費"></label>
        <label class="kei-f wide"><span>変更理由・メモ（必須）　※あとから監査できるように、必ず残します</span><textarea name="reason" rows="2" maxlength="500" placeholder="${correct ? "例：基本給の入力ミスを訂正（320,000円→330,000円）" : "例：2026年10月の定期昇給"}">${esc(F.reason)}</textarea></label>
      </form>
      <div id="pay-err" class="kei-err" data-role="form-err">${T.err ? esc(T.err) : ""}</div>
      <button class="kei-btn" data-act="preview" data-role="preview-btn">内容を確認する</button>
      <span class="kei-mute">確認してから、記録します。</span>
      <div id="pay-preview">${previewHtml()}</div>
    </div>`;
  }

  // ---- 確認（プレビュー）-----------------------------------------------------------
  const fmtVal = (key, v) => (v == null ? "—" : key === "wageType" ? esc(v) : yen(v));
  function previewHtml() {
    if (!P) return "";
    const p = P.plan;
    const rows = p.changes.map((c) => `<tr data-key="${esc(c.key)}"><td>${esc(c.label)}</td><td class="n">${fmtVal(c.key, c.from)}</td><td class="n">${fmtVal(c.key, c.to)}</td>
        <td>${c.change === "added" ? "追加" : c.change === "removed" ? "削除" : "変更"}</td></tr>`).join("");
    const cc = p.contractCheck;
    return `<div class="kei-mailbox pay-pv" data-role="preview">
      <div><span>記録の種類</span><b data-role="kind">${esc(p.kindLabel)}</b>${p.revision > 1 ? `（版${p.revision}）` : ""}</div>
      <div><span>適用開始日</span><b>${esc(jpDay(p.effectiveFrom))}</b></div>
      <div class="kei-tw"><table class="kei-t"><thead><tr><th>項目</th><th class="n">変更前</th><th class="n">変更後</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="kei-note">月額の見立て：<b>${p.monthly.total != null ? esc(yen(p.monthly.total)) : "月額に直せません（時給・日給）"}</b>　${p.before ? `（変更前 ${esc(jpDay(p.before.effectiveFrom))} からの記録と比べています）` : "（最初の記録です）"}</div>
      ${cc && cc.contract ? `<div class="kei-note">契約上の賃金：${esc(cc.contract.wageType || "")} ${esc(yen(cc.contract.wageAmount))}　${pill(CHECK[cc.state] || cc.state, cc.state === "match" ? "ok" : cc.state === "type" || cc.state === "amount" ? "warn" : "miss")}</div>` : ""}
      ${p.warnings.map((w) => `<div class="kei-note" data-role="warning" style="color:#8a5a00;">⚠ ${esc(w)}</div>`).join("")}
      <div style="margin-top:10px;"><button class="kei-btn" data-act="record" data-role="record-btn">この内容で記録する</button>
        <button class="kei-btn sec" data-act="cancel-preview">やめる</button></div>
      <div class="kei-note">記録すると、変更者（あなた）・日時・理由と一緒に、履歴と監査ログに残ります。あとから消したり、書き換えたりはできません（誤りは「訂正」で直します）。</div></div>`;
  }

  // ---- 履歴・監査 ------------------------------------------------------------------
  function changeText(c) {
    if (c.change === "added") return `${esc(c.label)}：${fmtVal(c.key, c.to)}（追加）`;
    if (c.change === "removed") return `${esc(c.label)}：${fmtVal(c.key, c.from)}（削除）`;
    return `${esc(c.label)}：${fmtVal(c.key, c.from)} → ${fmtVal(c.key, c.to)}`;
  }
  function historyPanel() {
    if (!D.groups.length) return `<div class="kei-panel" data-section="history"><h3 class="kei-h3">給与の履歴</h3><div class="kei-empty">まだ記録がありません。</div></div>`;
    const body = D.groups.map((g) => g.revisions.map((r, i) => {
      const latest = i === 0;
      const isCurrent = D.current && D.current.id === r.id;
      return `<tr data-record="${esc(r.id)}" class="${latest ? "" : "dim"}">
        <td>${i === 0 ? `<b>${esc(jpDay(g.effectiveFrom))}</b>` : ""}${isCurrent ? `<div>${pill("いま", "ok")}</div>` : latest && g.effectiveFrom > D.today ? `<div>${pill("予定", "prov")}</div>` : ""}</td>
        <td>${esc(KIND[r.kind])}${!latest ? `<div class="kei-mute">版${r.revision}（訂正前）</div>` : r.revision > 1 ? `<div class="kei-mute">版${r.revision}</div>` : ""}</td>
        <td class="n">${esc(baseText(r))}</td>
        <td>${esc(allowText(r))}</td>
        <td class="n">${r.commuteAmount == null ? "—" : esc(yen(r.commuteAmount))}</td>
        <td>${r.changes.length ? r.changes.map((c) => `<div>${changeText(c)}</div>`).join("") : `<span class="kei-mute">—</span>`}</td>
        <td>${esc(r.createdBy || "")}<div class="kei-mute">${esc(jp(r.createdAt))}</div></td>
        <td>${esc(r.reason)}<div class="kei-mute">${esc(SOURCE[r.source] || r.source)}</div></td></tr>`;
    }).join("")).join("");
    return `<div class="kei-panel" data-section="history"><h3 class="kei-h3">給与の履歴（適用開始日ごと・新しい順）</h3>
      <div class="kei-tw"><table class="kei-t" data-role="history"><thead><tr><th>適用開始日</th><th>種類</th><th class="n">基本給</th><th>手当（月）</th><th class="n">通勤手当（月）</th><th>変更前 → 変更後</th><th>変更者・日時</th><th>理由・取り込み元</th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="kei-note">薄い行は、訂正される前の版です（消さずに残しています）。</div></div>`;
  }
  function auditRows(rows, withName) {
    return rows.map((a) => `<tr><td>${esc(jp(a.at))}</td><td>${esc(a.actor || "")}</td><td>${esc(a.label)}</td>${withName ? `<td>${esc(a.employeeName || "")}</td>` : ""}
      <td>${a.detail && a.detail.reason ? esc(a.detail.reason) : ""}${a.detail && a.detail.effective_from ? `<div class="kei-mute">${esc(jpDay(a.detail.effective_from))} 適用・${esc(KIND[a.detail.kind] || "")}${a.detail.revision > 1 ? `（版${a.detail.revision}）` : ""}</div>` : ""}</td></tr>`).join("");
  }
  function auditPanel() {
    return `<div class="kei-panel" data-section="audit"><h3 class="kei-h3">この人の監査ログ</h3>
      ${D.auditUnavailable ? banner(`${MISSING}（監査ログを読めませんでした）`, "warn")
        : D.audit.length ? `<div class="kei-tw"><table class="kei-t" data-role="audit"><thead><tr><th>日時</th><th>操作した人</th><th>操作</th><th>内容</th></tr></thead><tbody>${auditRows(D.audit, false)}</tbody></table></div>`
          : `<div class="kei-empty">まだありません。</div>`}
      <div class="kei-note">記録の追加は自動で、開いたことも残ります（追記だけ。消せません）。<a href="#pay-audit">全員分の監査ログ →</a></div></div>`;
  }

  function renderDetail() {
    const e = D.employee;
    const sub = [e.department, e.position].filter(Boolean).join("・") + `　${STATUS[e.status] || e.status}` + (e.joinedOn ? `　${jpDay(e.joinedOn)} 入社` : "");
    main.innerHTML = `<a class="kei-back2" href="#pay">← 給与管理の一覧へ</a>
      ${head(e.name, sub)}
      ${T.msg ? `<div class="kei-okmsg" data-role="msg">${esc(T.msg)}</div>` : ""}
      ${currentPanel()}${referencePanel()}${formPanel()}${historyPanel()}${auditPanel()}`;
    bindDetail();
  }

  // ---- フォームの値の出し入れ ---------------------------------------------------------
  function collect() {
    const f = main.querySelector("#pay-form");
    if (!f) return;
    const v = (n) => f.querySelector(`[name="${n}"]`);
    F.mode = (main.querySelector('input[name="mode"]:checked') || {}).value || F.mode;
    F.effectiveFrom = v("effectiveFrom") ? v("effectiveFrom").value : F.effectiveFrom;
    F.wageType = v("wageType").value;
    F.baseAmount = v("baseAmount").value;
    F.commuteAmount = v("commuteAmount").value;
    F.commuteNote = v("commuteNote").value;
    F.reason = v("reason").value;
    F.allowances = [...f.querySelectorAll(".pay-arow")].map((r) => ({ name: r.querySelector('[name="a-name"]').value, amount: r.querySelector('[name="a-amount"]').value }));
    // 「契約から」「内定から」写した値を、あとで書き換えたら、経営者の入力として記録する（元と違う値に、元の名前を付けない）
    if (F.source !== "owner" && F.importRef) {
      const amount = Number(String(F.baseAmount).replace(/[,，\s円]/g, ""));
      if (F.wageType !== F.importRef.wageType || amount !== Number(F.importRef.amount)) { F.source = "owner"; F.importRef = null; }
    }
  }
  const payload = () => ({
    effectiveFrom: F.effectiveFrom, wageType: F.wageType, baseAmount: F.baseAmount, commuteAmount: F.commuteAmount,
    commuteNote: F.commuteNote, allowances: F.allowances, reason: F.reason, source: F.source, correct: F.mode === "correct",
  });
  const call = (action, extra = {}) => API.api("/api/keiei/pay", { method: "POST", body: { action, employeeId: empId, ...payload(), ...extra } });
  const errText = (e) => (e && (e.hint || e.detail || e.message)) || "できませんでした";

  function rerenderForm() {
    const panel = main.querySelector('[data-section="form"]');
    if (!panel) return renderDetail();
    const tmp = document.createElement("div");
    tmp.innerHTML = formPanel();
    panel.replaceWith(tmp.firstElementChild);
    bindDetail();
  }

  const actions = {
    "add-allow": () => { collect(); F.allowances.push({ name: "", amount: "" }); rerenderForm(); const rows = main.querySelectorAll(".pay-arow"); rows[rows.length - 1].querySelector("input").focus(); },
    "rm-allow": (btn) => { collect(); F.allowances.splice(Number(btn.dataset.i), 1); P = null; rerenderForm(); },
    "import-contract": () => importFrom(D.references.contract.view && { wageType: D.references.contract.view.wageType, amount: D.references.contract.view.wageAmount }, "contract_import"),
    "import-offer": () => importFrom(D.references.offer && { wageType: D.references.offer.wageType, amount: D.references.offer.wageAmount }, "offer_import"),
    "cancel-preview": () => { P = null; T.err = null; main.querySelector("#pay-preview").innerHTML = ""; },
    preview: async (btn) => {
      collect(); T.err = null; P = null;
      btn.disabled = true;
      try {
        const r = await call("preview_record");
        P = { plan: r.preview, sig: JSON.stringify(payload()) };
      } catch (e) { T.err = errText(e); }
      if (!alive()) return;
      main.querySelector("#pay-err").textContent = T.err || "";
      main.querySelector("#pay-preview").innerHTML = previewHtml();
      bindPreview();
      btn.disabled = false;
      const pv = main.querySelector('[data-role="preview"]');
      if (pv) pv.scrollIntoView({ block: "nearest" });
    },
    record: async (btn) => {
      collect();
      // 確認したあとで入力が変わっていたら、確認し直してもらう（見たものと違うものを記録しない）
      if (!P || P.sig !== JSON.stringify(payload())) { T.err = "入力が変わりました。もう一度「内容を確認する」を押してください"; P = null; main.querySelector("#pay-err").textContent = T.err; main.querySelector("#pay-preview").innerHTML = ""; return; }
      btn.disabled = true; T.err = null;
      try {
        const r = await call("record", { basisId: P.plan.basisId });
        const res = r.result;
        // 記録は済んでいる。記録後の読み直しに失敗して詳細が付いていないときは、開き直して読む
        D = r.groups ? r : await API.api(`/api/keiei/pay?view=detail&employeeId=${encodeURIComponent(empId)}`);
        P = null;
        F = D.current ? formFrom(D.current, "change") : blankForm("change");
        T.msg = `${KIND[res.kind]}として記録しました（${jpDay(res.effectiveFrom)} から${res.revision > 1 ? `・版${res.revision}` : ""}）。履歴と監査ログに残りました`;
        renderDetail();
        window.scrollTo(0, 0);
      } catch (e) {
        T.err = errText(e);
        if (!alive()) return;
        main.querySelector("#pay-err").textContent = T.err;
        btn.disabled = false;
        // 画面が古い・同時に記録された → 開き直すよう案内する（記録はしていない）
        if (e.code === "stale_basis" || e.code === "conflict" || e.code === "exists_at_date") P = null;
      }
    },
  };

  /** 参照の金額を入力欄に写す（値を入れるだけ。記録は、確認してから） */
  function importFrom(ref, source) {
    if (!ref) return;
    collect();
    F.mode = "change"; F.wageType = ref.wageType; F.baseAmount = String(ref.amount ?? ""); F.source = source; F.importRef = { wageType: ref.wageType, amount: ref.amount }; P = null;
    if (!F.reason) F.reason = source === "contract_import" ? "契約の賃金を取り込み" : "内定時の給与を取り込み";
    rerenderForm();
    const note = main.querySelector('[data-section="form"] .kei-note');
    if (note) note.insertAdjacentHTML("afterend", `<div class="kei-note" data-role="imported" style="color:#1f6f3a;">${source === "contract_import" ? "契約" : "内定"}の賃金を入力欄に写しました。手当・通勤手当は入っていません。内容を確かめて、適用開始日を入れてください。</div>`);
  }

  function bindPreview() {
    for (const b of main.querySelectorAll("#pay-preview [data-act]")) b.addEventListener("click", () => actions[b.dataset.act](b));
  }
  function bindDetail() {
    for (const b of main.querySelectorAll("[data-act]")) {
      if (b.closest("#pay-preview")) continue;
      b.addEventListener("click", () => { const fn = actions[b.dataset.act]; if (fn) fn(b); });
    }
    bindPreview();
    // 種別（変更 / 訂正）を切り替える
    for (const r of main.querySelectorAll('input[name="mode"]')) {
      r.addEventListener("change", () => {
        collect();
        P = null; T.err = null;
        if (F.mode === "correct") {
          // 訂正するときは、今の最新の版の値を入れ直す
          const g = D.groups.find((x) => x.effectiveFrom === (D.current ? D.current.effectiveFrom : "")) || D.groups[0];
          if (g) { const r0 = g.revisions[0]; const keep = F.reason; F = formFrom(r0, "correct"); F.reason = keep; }
        } else {
          const keep = F.reason; F = D.current ? formFrom(D.current, "change") : blankForm("change"); F.reason = keep;
        }
        rerenderForm();
      });
    }
    // 訂正する日付を選んだら、その日付の最新の版の値を入れる
    const cd = main.querySelector('[data-role="correct-date"]');
    if (cd) cd.addEventListener("change", () => {
      collect();
      const g = D.groups.find((x) => x.effectiveFrom === cd.value);
      if (g) { const keep = F.reason; F = formFrom(g.revisions[0], "correct"); F.reason = keep; P = null; rerenderForm(); }
    });
    // 入力が変わったら、確認は無効（見たものと違うものを記録しない）
    const form = main.querySelector("#pay-form");
    if (form) form.addEventListener("input", () => {
      if (!P) return;
      collect();
      if (P.sig !== JSON.stringify(payload())) { P = null; main.querySelector("#pay-preview").innerHTML = ""; }
    });
  }

  // =====================================================================================
  // 全員の監査ログ
  // =====================================================================================
  let A = null;
  async function audit(mount, isStale) {
    const d = await load("/api/keiei/pay?view=audit", mount, isStale, "#pay");
    if (!d) return;
    if (!d.linked) { main.innerHTML = notLinked(d); return; }
    A = { rows: d.rows, next: d.nextBefore };
    renderAudit();
    window.scrollTo(0, 0);
  }
  function renderAudit() {
    main.innerHTML = `<a class="kei-back2" href="#pay">← 給与管理の一覧へ</a>
      ${head("給与管理の監査ログ", "誰が、いつ、誰の給与を、どうしたか。記録の追加は自動で、開いたことも残ります。追記だけで、消せません。新しい順。")}
      <div class="kei-panel">${A.rows.length ? `<div class="kei-tw"><table class="kei-t" data-role="audit-all"><thead><tr><th>日時</th><th>操作した人</th><th>操作</th><th>対象</th><th>内容</th></tr></thead><tbody>${auditRows(A.rows, true)}</tbody></table></div>`
        : `<div class="kei-empty">まだありません。</div>`}
        ${A.next ? `<div style="margin-top:10px;"><button class="kei-btn sec" data-act="more">続きを読む</button></div>` : ""}
        <div class="kei-note">金額は、監査ログには写していません（記録そのものにあります）。</div></div>`;
    const more = main.querySelector('[data-act="more"]');
    if (more) more.addEventListener("click", async () => {
      more.disabled = true;
      try {
        const d = await API.api(`/api/keiei/pay?view=audit&before=${encodeURIComponent(A.next)}`);
        if (!alive()) return;
        A.rows = A.rows.concat(d.rows); A.next = d.nextBefore;
        renderAudit();
      } catch (e) { more.disabled = false; more.textContent = errText(e); }
    });
  }

  window.KeieiPay = { list, open, audit };
})();
