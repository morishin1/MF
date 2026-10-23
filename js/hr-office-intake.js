// 採用HR：社長合格 → 条件ヒアリング → ［Officeへ引き渡す］（早期引き渡し・新フロー。hr/applicants.html の詳細ドロワー）
//
// ■ 何を出すか（サーバ PATCH/GET /api/hr/applicants/detail の officeIntake が正。画面で条件を決めない）
//   ・概要タブの先頭に「条件ヒアリング・Office への引き渡し」（折りたたみ。開くと中身）
//   ・NEXT ACTION の主ボタン（1つ）：［条件ヒアリングを記録］→ ヒアリングのモーダル／［Officeへ引き渡す］→ 確認のモーダル
//     確認のモーダルは「引き渡す情報」「Office担当」「未確定項目」の3つだけ。確定で一度だけ記録する
//   ・機能フラグ（HR_OFFICE_INTAKE）OFF・旧フローの人には何も出さない（officeIntake.enabled / newFlow が false）
// ■ 給与（希望報酬）は、給与を見られる人だけが入力・閲覧（can.editPay）。社内承認済みの額は経営者だけ（can.approvePay）
// ■ 推測値を入れない：各項目は「値」か「未確定／Officeで確認」のどちらか（両方は送らない）
// 通知・メールは送らない（PR C）。応募者へは何も送らない。
(function () {
  "use strict";
  const H = {};
  let host = null;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (id) => document.getElementById(id);
  const oi = () => host?.detail()?.officeIntake || null;
  const fmt = (iso) => (iso ? (window.JST?.dateTime ? JST.dateTime(iso) : String(iso)) : "—");
  const fieldLabel = (k) => (oi()?.fields || []).find((f) => f.key === k)?.label || k;
  const PHASE_TEXT = {
    awaiting_hearing: "社長合格／条件ヒアリング待ち", hearing: "条件ヒアリング中", ready: "Officeへ引き渡し待ち",
    handed_off: "Officeへ移動済み", withdrawn: "辞退・不成立（Office）",
  };

  /** hr/applicants.html から一度だけ呼ぶ。detail・モーダル・再読み込み・社員の選択肢は画面のものを使う */
  H.init = (h) => { host = h; };
  const active = () => { const x = oi(); return Boolean(x?.enabled && x?.ready && x?.newFlow); };
  H.active = active;

  function valueText(f, h) {
    const v = h?.values?.[f.key];
    if ((h?.unresolved || []).includes(f.key)) return `<span class="hr-oi-un">${esc(oi().unresolvedLabel)}</span>`;
    if (f.kind === "pay") {
      const p = oi().pay;
      if (!p) return "—";
      if (!("desired_amount" in p)) return p.entered ? "入力済み（給与は権限のある人だけが見られます）" : "—";
      return p.desired_amount != null ? `候補者希望：${esc(p.desired_wage_type || "")} ${Number(p.desired_amount).toLocaleString("ja-JP")}円`
        + (p.approved_amount != null ? `／社内承認済み：${esc(p.approved_wage_type || "")} ${Number(p.approved_amount).toLocaleString("ja-JP")}円` : "") : "—";
    }
    if (v === null || v === undefined || v === "") return `<span class="hr-oi-miss">未入力</span>`;
    if (f.kind === "offerType") return esc((host.offerTypeLabel?.(v)) || v);
    return esc(v) + (f.unit ? esc(f.unit) : "");
  }

  /** 概要タブの先頭に置く（折りたたみ）。新フローの人だけ */
  H.card = () => {
    if (!active()) return "";
    const x = oi();
    const h = x.hearing;
    const rows = (x.fields || []).map((f) => `<div data-oi-field="${esc(f.key)}"><dt>${esc(f.label)}</dt><dd>${valueText(f, h)}</dd></div>`).join("");
    const head = x.intake
      ? `Officeへ移動済み（${esc(x.intake.officeStatusLabel || "未着手")}）・${esc(fmt(x.intake.handedAt))}`
      : PHASE_TEXT[x.phase] || "";
    return `
      <details class="hr-oi" id="hr-oi-card" data-phase="${esc(x.phase)}">
        <summary><span class="material-symbols-outlined">assignment_turned_in</span><b>条件ヒアリング・Office への引き渡し</b>
          <span class="hr-oi-st">${head}</span></summary>
        <div class="hr-oi-body">
          <p class="hr-oi-note">社長合格：${esc(fmt(x.decision?.decidedAt))}${x.decision?.decidedByName ? `（${esc(x.decision.decidedByName)}）` : ""}。
            社長合格は社内の採用判断です。本人の条件承諾・雇用契約の成立ではありません。</p>
          ${h ? `<dl class="hr-oi-dl">${rows}</dl>
            <p class="hr-oi-note">記録：${esc(h.recordedByName || "—")}／内容確認：${h.confirmedAt ? `${esc(h.confirmedByName || "")} ${esc(fmt(h.confirmedAt))}` : "まだ"}
              ${h.exception ? `<br>未確定のまま引き渡す承認：${esc(h.exception.approvedByName || "")} ${esc(fmt(h.exception.approvedAt))}（理由：${esc(h.exception.reason)}）` : ""}</p>`
            : `<p class="hr-oi-note">条件ヒアリングはまだ記録されていません。</p>`}
          ${x.intake ? `<p class="hr-oi-note" data-oi-intake>引き渡し：${esc(x.intake.handedByName || "—")} ${esc(fmt(x.intake.handedAt))}
            ／Office担当：${esc(x.intake.officeAssigneeName || "未定")}／Office の状態：${esc(x.intake.officeStatusLabel || "未着手")}</p>` : ""}
          ${x.can?.editHearing && h ? `<button class="btn btn-secondary btn-sm" onclick="HRIntake.openHearing()">ヒアリングを直す</button>` : ""}
        </div>
      </details>`;
  };

  // ---- 条件ヒアリング（モーダル） -------------------------------------------------------
  function inputHtml(f, h) {
    const v = h?.values?.[f.key] ?? "";
    const un = (h?.unresolved || []).includes(f.key);
    const id = `oi-f-${f.key}`;
    let ctl;
    if (f.kind === "offerType") {
      const types = host.offerTypes?.() || [];
      ctl = `<select id="${id}"><option value="">選んでください</option>${types.map((t) =>
        `<option value="${esc(t.key)}" ${t.key === v ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select>`;
    } else if (f.kind === "textarea") {
      ctl = `<textarea id="${id}" rows="2" maxlength="${esc(f.max || 2000)}" placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea>`;
    } else if (f.kind === "date") {
      ctl = `<input type="date" id="${id}" value="${esc(v)}">`;
    } else if (f.kind === "number") {
      ctl = `<input type="number" id="${id}" step="0.5" min="${esc(f.min)}" max="${esc(f.maxValue)}" value="${esc(v)}" inputmode="decimal">`;
    } else if (f.kind === "pay") {
      const p = oi().pay || {};
      const can = oi().can || {};
      if (!can.editPay) {
        ctl = `<p class="hr-oi-note" style="margin:0;">給与は、給与を見られる人が入力します${p.entered ? "（入力済み）" : ""}。決まっていなければ「未確定」にしてください。</p>`;
      } else {
        const wt = (sel) => `<option value="">区分</option>${(oi().wageTypes || []).map((w) => `<option ${w === sel ? "selected" : ""}>${esc(w)}</option>`).join("")}`;
        ctl = `<div class="hr-oi-pay"><select id="oi-pay-type">${wt(p.desired_wage_type)}</select>
            <input type="number" id="oi-pay-amount" min="0" step="1" inputmode="numeric" placeholder="候補者希望（円）" value="${esc(p.desired_amount ?? "")}"></div>
          <input type="text" id="oi-pay-note" maxlength="1000" placeholder="メモ（任意）" value="${esc(p.desired_note || "")}" style="margin-top:4px;">
          ${can.approvePay ? `<div class="hr-oi-pay" style="margin-top:6px;"><select id="oi-pay-atype">${wt(p.approved_wage_type)}</select>
            <input type="number" id="oi-pay-approved" min="0" step="1" inputmode="numeric" placeholder="社内承認済み（円・経営者）" value="${esc(p.approved_amount ?? "")}"></div>` : ""}`;
      }
    } else {
      ctl = `<input type="text" id="${id}" maxlength="${esc(f.max || 200)}" placeholder="${esc(f.placeholder || "")}" value="${esc(v)}">`;
    }
    return `<div class="hr-oi-row" data-oi-row="${esc(f.key)}">
      <label for="${id}">${esc(f.label)}${f.required ? ` <span class="req">必須</span>` : ""}</label>
      ${ctl}
      <label class="hr-oi-unck"><input type="checkbox" id="oi-un-${esc(f.key)}" ${un ? "checked" : ""} onchange="HRIntake.toggleUnresolved('${esc(f.key)}', this.checked)">
        ${esc(oi().unresolvedLabel)}</label>
    </div>`;
  }

  H.openHearing = () => {
    if (!active()) return;
    const x = oi();
    const h = x.hearing;
    const un = h?.unresolved || [];
    host.openModal(`
      <h2 class="hr-oi-h2">条件ヒアリング（候補者の希望）</h2>
      <p class="hr-sub" style="margin:0 0 10px;">分からない項目は空欄にせず「${esc(x.unresolvedLabel)}」にしてください（推測で埋めない）。
        希望は「候補者希望」として記録し、会社の決定とは分けます。</p>
      <div class="hr-oi-form">${(x.fields || []).map((f) => inputHtml(f, h)).join("")}</div>
      ${un.length && x.can?.approveException ? `
        <div class="hr-oi-exc" id="oi-exc">
          <b>未確定のまま引き渡す例外の承認（社長・管理者）</b>
          <p class="hr-oi-note" style="margin:4px 0;">未確定：${esc(un.map(fieldLabel).join("・"))}</p>
          ${h?.exception ? `<p class="hr-oi-note" style="margin:4px 0;">承認済み：${esc(h.exception.reason)}</p>` : `
          <textarea id="oi-exc-reason" rows="2" maxlength="1000" placeholder="理由（必須）"></textarea>
          <button class="btn btn-secondary btn-sm" onclick="HRIntake.approveException(this)">理由を記録して承認する</button>`}
        </div>` : un.length ? `<p class="hr-oi-note">未確定の項目を残して引き渡すには、社長・管理者の承認と理由が要ります。</p>` : ""}
      <div id="oi-msg" class="err-text" style="margin:10px 0 0;"></div>
      <div class="hr-of-actions">
        <button class="btn btn-primary" id="oi-save-confirm" onclick="HRIntake.saveHearing(this, true)">保存して内容を確認</button>
        <button class="btn btn-secondary" id="oi-save" onclick="HRIntake.saveHearing(this, false)">保存だけ</button>
        <button class="btn btn-secondary" onclick="HRIntake.close()">やめる</button>
      </div>`, { wide: true });
    for (const k of un) H.toggleUnresolved(k, true);
  };

  /** 「未確定」にした項目は入力を空にして止める（値と未確定を両方送らない） */
  H.toggleUnresolved = (key, on) => {
    const row = document.querySelector(`[data-oi-row="${key}"]`);
    if (!row) return;
    row.classList.toggle("un", on);
    row.querySelectorAll("input:not([type=checkbox]), select, textarea").forEach((c) => {
      if (on) c.value = "";
      c.disabled = on;
    });
  };

  function collect() {
    const x = oi();
    const hearing = {};
    const unresolved = [];
    for (const f of x.fields || []) {
      if ($(`oi-un-${f.key}`)?.checked) { unresolved.push(f.key); continue; }
      if (f.kind === "pay") continue;
      const v = $(`oi-f-${f.key}`)?.value ?? "";
      hearing[f.key] = String(v).trim() === "" ? null : (f.kind === "number" ? Number(v) : String(v).trim());
    }
    const body = { hearing, unresolved };
    if (x.can?.editPay && !unresolved.includes("desired_pay")) {
      const pay = {
        desired_wage_type: $("oi-pay-type")?.value || null,
        desired_amount: $("oi-pay-amount")?.value === "" ? null : Number($("oi-pay-amount")?.value),
        desired_note: $("oi-pay-note")?.value || null,
      };
      if (x.can?.approvePay && $("oi-pay-approved")?.value !== "" && $("oi-pay-approved")) {
        pay.approved_wage_type = $("oi-pay-atype")?.value || null;
        pay.approved_amount = Number($("oi-pay-approved").value);
      }
      body.pay = pay;
    }
    return body;
  }

  H.saveHearing = async (btn, confirm) => {
    const msg = $("oi-msg"); msg.textContent = "";
    const id = host.detail().applicant.id;
    try {
      await KPLayout.busy(btn, "保存中…", async () => {
        await API.api("/api/hr/applicants/detail", { method: "PATCH", body: { id, action: "saveHearing", ...collect() } });
        if (confirm) await API.api("/api/hr/applicants/detail", { method: "PATCH", body: { id, action: "confirmHearing" } });
      });
    } catch (e) {
      msg.textContent = e.hint || e.detail || e.message || "保存できませんでした";
      await host.refresh(false);
      return;
    }
    H.close();
    await host.refresh(true);
  };

  H.approveException = async (btn) => {
    const msg = $("oi-msg"); msg.textContent = "";
    const reason = $("oi-exc-reason")?.value.trim();
    if (!reason) { msg.textContent = "理由を入力してください"; return; }
    try {
      await KPLayout.busy(btn, "記録中…", () => API.api("/api/hr/applicants/detail", {
        method: "PATCH", body: { id: host.detail().applicant.id, action: "approveHearingException", reason } }));
    } catch (e) { msg.textContent = e.hint || e.detail || e.message || "記録できませんでした"; return; }
    H.close();
    await host.refresh(true);
  };

  // ---- ［Officeへ引き渡す］（確認のモーダル：引き渡す情報・Office担当・未確定項目） ----------------------
  H.openHandoff = () => {
    if (!active()) return;
    const x = oi();
    const a = host.detail().applicant;
    const h = x.hearing;
    const un = h?.unresolved || [];
    const people = host.employees?.() || [];
    const brief = (x.fields || []).filter((f) => f.required).map((f) =>
      `<div data-ho-field="${esc(f.key)}"><dt>${esc(f.label)}</dt><dd>${valueText(f, h)}</dd></div>`).join("");
    host.openModal(`
      <h2 class="hr-oi-h2">Office へ引き渡す</h2>
      <p class="hr-sub" style="margin:0 0 10px;">${esc(a.name)}さんの条件手続き（正式な条件の確定・社労士への依頼・本人の同意・契約）を Office へ渡します。
        <b>本人の条件承諾・正式契約・社員登録ではありません。</b>本人へは何も送りません。</p>
      <section class="hr-oi-sec" id="oi-ho-info"><h3>引き渡す情報</h3><dl class="hr-oi-dl">${brief}</dl></section>
      <section class="hr-oi-sec"><h3><label for="oi-ho-assignee">Office担当</label></h3>
        <select id="oi-ho-assignee"><option value="">未定（Office で決める）</option>${people.map((p) =>
          `<option value="${esc(p.id)}">${esc(p.display_name)}</option>`).join("")}</select></section>
      <section class="hr-oi-sec" id="oi-ho-unresolved"><h3>未確定項目</h3>
        ${un.length ? `<p style="margin:0;">${esc(un.map(fieldLabel).join("・"))}（${esc(x.unresolvedLabel)}）</p>
          ${h?.exception ? `<p class="hr-oi-note" style="margin:4px 0 0;">承認：${esc(h.exception.approvedByName || "")}・理由：${esc(h.exception.reason)}</p>` : ""}`
          : `<p style="margin:0;">なし</p>`}</section>
      <label class="hr-oi-ck"><input type="checkbox" id="oi-ho-check" onchange="document.getElementById('oi-ho-go').disabled=!this.checked">
        <span>内容を確認しました。引き渡した人と日時が記録され、一度だけ引き渡せます</span></label>
      <div id="oi-ho-msg" class="err-text" style="margin:10px 0 0;"></div>
      <div class="hr-of-actions">
        <button class="btn btn-primary" id="oi-ho-go" disabled onclick="HRIntake.submitHandoff(this)">Officeへ引き渡す</button>
        <button class="btn btn-secondary" onclick="HRIntake.close()">やめる</button>
      </div>`);
    reqId = (crypto?.randomUUID?.() || `r${Date.now()}${Math.random().toString(36).slice(2)}`);
  };
  let reqId = null;

  H.submitHandoff = async (btn) => {
    const msg = $("oi-ho-msg"); msg.textContent = "";
    if (!$("oi-ho-check")?.checked) { msg.textContent = "内容を確認してください"; return; }
    try {
      await KPLayout.busy(btn, "引き渡し中…", () => API.api("/api/hr/applicants/detail", { method: "PATCH", body: {
        id: host.detail().applicant.id, action: "officeHandoff", confirm: true,
        officeAssigneeId: $("oi-ho-assignee")?.value || null, clientRequestId: reqId,
      } }));
    } catch (e) { msg.textContent = e.hint || e.detail || e.message || "引き渡せませんでした"; return; }
    H.close();
    await host.refresh(true);
  };

  H.close = () => host?.closeModal();

  // この部品の見た目（画面全体の CSS の版を上げずに済むよう、ここに持つ）。PC と 390px の両方で短く
  const css = `
    .hr-oi { border:1px solid #e3e5ec; border-radius:10px; margin:0 0 12px; background:#fafbfd; }
    .hr-oi > summary { cursor:pointer; list-style:none; padding:10px 12px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;
      font-size:13px; color:#1b2440; }
    .hr-oi > summary::-webkit-details-marker { display:none; }
    .hr-oi > summary .material-symbols-outlined { font-size:18px; color:#2f6f3a; }
    .hr-oi-st { font-size:12px; color:#4a5068; margin-left:auto; }
    .hr-oi-body { padding:0 12px 12px; }
    .hr-oi-note { font-size:12px; color:#6b7080; margin:6px 0; line-height:1.6; }
    .hr-oi-dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:6px 0; font-size:12.5px; }
    .hr-oi-dl > div { display:contents; }
    .hr-oi-dl dt { color:#6b7080; white-space:nowrap; }
    .hr-oi-dl dd { margin:0; color:#1b2440; overflow-wrap:anywhere; }
    .hr-oi-un { color:#7d5a00; font-weight:600; }
    .hr-oi-miss { color:#b3261e; }
    .hr-oi-h2 { font-size:17px; font-weight:700; color:#1b2440; margin:0 0 6px; }
    .hr-oi-form { display:grid; grid-template-columns:1fr 1fr; gap:8px 14px; }
    .hr-oi-row { min-width:0; }
    .hr-oi-row[data-oi-row="duties"], .hr-oi-row[data-oi-row="desired_pay"], .hr-oi-row[data-oi-row="allowances_note"],
    .hr-oi-row[data-oi-row="other_note"] { grid-column:1 / -1; }
    .hr-oi-row > label:first-child { font-size:12px; color:#4a5068; display:block; margin:0 0 2px; }
    .hr-oi-row .req { font-size:10.5px; color:#b3261e; }
    .hr-oi-row.un input:not([type=checkbox]), .hr-oi-row.un select, .hr-oi-row.un textarea { background:#f1f2f5; }
    .hr-oi-unck, .hr-oi-ck { display:flex; gap:6px; align-items:flex-start; font-size:12px; color:#4a5068; margin:3px 0 0; }
    .hr-oi-unck input, .hr-oi-ck input { width:auto; flex:none; margin-top:2px; }
    .hr-oi-pay { display:flex; gap:6px; } .hr-oi-pay select { width:7.5em; flex:none; } .hr-oi-pay input { flex:1; min-width:0; }
    .hr-oi-exc { border:1px solid #f0d58a; background:#fffaf0; border-radius:8px; padding:8px 10px; margin:10px 0 0; font-size:12.5px; }
    .hr-oi-sec { margin:0 0 10px; } .hr-oi-sec h3 { font-size:13px; color:#1b2440; margin:0 0 4px; }
    .hr-oi-ck { font-size:13px; color:#1b2440; }
    @media (max-width:520px) { .hr-oi-form { grid-template-columns:1fr; } .hr-oi-st { margin-left:0; width:100%; } }`;
  if (!document.getElementById("hr-oi-style")) {
    const st = document.createElement("style");
    st.id = "hr-oi-style";
    st.textContent = css;
    document.head.appendChild(st);
  }
  window.HRIntake = H;
})();
