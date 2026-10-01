// 営業の企業詳細（右ドロワー）と、そこから開く操作（中央モーダル）。/sales/companies.html と /sales/leads.html で共通。
//
// ■ 見る情報＝右ドロワー、操作＝中央モーダル
//   ドロワー（#modal-root）は企業の情報と NEXT ACTION。商談・返信の記録・フォローなどの操作は
//   中央モーダル（#action-root）で開き、閉じたら同じドロワーに戻る（一覧は画面遷移しない）。
//
// ■ 画面ごとの違いは detailHost だけ
//   一覧の取り直し（onChange）・URL（urlFor）・フォームアタック（openAttack。企業一覧だけ）。
//   商談・連絡先などの API は画面によらず同じもの（/api/sales/meetings・/api/sales/companies/detail）を使う。
//
// 使う画面は #modal-root・#action-root を置き、sales-layout.js のあとで読み込む。
// onclick="…" から呼ぶので、関数はグローバルに置く（ページの関数名と重ねないこと）。

const detailHost = {
  onChange: () => {},
  urlFor: () => location.pathname + location.search,
  beforeAction: () => {},
  openAttack: null,
};

const el = (id) => document.getElementById(id);
// 企業詳細の取得は、あとから開いたものだけを画面に出す。
// 取得中にドロワーを閉じた・別の企業を開いたときは、古い応答を捨てる
// （捨てないと、消えた #detail-box に書こうとして落ちる／別の企業の詳細に上書きする）
let detailSeq = 0;
let detailOpenId = null;
const detailIsCurrent = (seq, id) => seq === detailSeq && detailOpenId === id && Boolean(el("detail-box"));
const esc = SalesLayout.esc;
const { fmt, fmtDay, ago, statusPill } = SalesLayout;

// 業種・提案サービス・都道府県の共通マスター（lib/sales-master.js）。画面側には同じ一覧を書かない。
// 企業一覧は一覧APIの masters、リード一覧は企業詳細の masters で埋める（企業追加・編集・絞り込み・CSV取込が同じものを使う）
let masters = { industries: [], services: [], prefectures: [] };

let members = [];
let myEmployeeId = null;
let myName = "";

function closeModal() {
  // 取得中の企業詳細があれば、その結果はもう画面に書かない（閉じたあとに戻ってきた応答を捨てる）
  detailSeq++;
  detailOpenId = null;
  el("modal-root").innerHTML = "";
  el("action-root").innerHTML = "";
  // 一覧の状態（ページ・条件・並べ替え・スクロール）は残したまま、詳細の指定だけ外す
  history.replaceState({}, "", detailHost.urlFor(null));
}
// 企業詳細から行う操作・一括操作は、中央モーダル（1つだけ）で開く。
// 背景を押しても閉じるのはモーダルだけ。背後の企業詳細ドロワーは残す（/hr と同じ操作感）
function openActionModal(html, width) {
  detailHost.beforeAction();
  el("action-root").innerHTML = `<div class="sl-modal-bg" onclick="closeAction()"></div>
    <div class="sl-modal" role="dialog" aria-modal="true"${width ? ` style="width:${width}px;"` : ""}>${html}</div>`;
}
function closeAction() { el("action-root").innerHTML = ""; }
function errText(e, fallback) { return e.hint || e.detail || e.message || fallback; }

// 非表示の理由（lib/sales.js HIDE_REASONS と同じ）
const HIDE_REASONS = [
  ["link_broken", "リンク切れ"], ["no_info", "会社情報なし"], ["closed", "閉業"],
  ["not_target", "営業対象外"], ["duplicate", "重複"], ["other", "その他"],
];
const hideForm = (name) => `
  <label>理由</label>
  <div>${HIDE_REASONS.map(([k, l]) => `
    <label class="sl-chip"><input type="radio" name="${name}" value="${esc(k)}">${esc(l)}</label>`).join("")}</div>
  <label style="margin-top:10px;">メモ（任意）</label>
  <textarea id="${name}-note" rows="2"></textarea>`;

function hidePicked(name, msgId) {
  const picked = document.querySelector(`input[name="${name}"]:checked`);
  const note = el(`${name}-note`).value.trim();
  const msg = el(msgId);
  if (!picked) { msg.textContent = "理由を選んでください"; return null; }
  return { reason: picked.value, note: note || null };
}

// ---- 企業の基本情報フォーム（企業一覧の追加・詳細の「基本情報を編集」） -----------------
function companyForm(c = {}) {
  const memberOpts = members.map((m) =>
    `<option value="${esc(m.id)}" ${(c.ownerId || myEmployeeId) === m.id ? "selected" : ""}>${esc(m.display_name)}</option>`).join("");
  return `
    <label>企業名 <span style="color:#b3261e;">*</span></label><input id="c-name" type="text" value="${esc(c.name || "")}">
    <label style="margin-top:10px;">企業サイトURL</label><input id="c-site" type="text" placeholder="https://example.co.jp" value="${esc(c.siteUrl || "")}">
    <label style="margin-top:10px;">問い合わせフォームURL</label><input id="c-form" type="text" value="${esc(c.formUrl || "")}">
    <label style="margin-top:10px;">業種</label>
    <select id="c-industry">${masterOptions(masters.industries, c.industry)}</select>
    <label style="margin-top:10px;">地域（都道府県）</label>
    <select id="c-region">${masterOptions(masters.prefectures, c.region)}</select>
    <label style="margin-top:10px;">提案サービス（何を提案するか）</label>
    <select id="c-service">${masterOptions(masters.services, c.service)}</select>
    <label style="margin-top:10px;">担当</label>
    <select id="c-owner"><option value="">（未定）</option>${memberOpts}</select>
    <label style="margin-top:10px;">所在地</label><input id="c-address" type="text" value="${esc(c.address || "")}">
    <label style="margin-top:10px;">電話番号</label><input id="c-phone" type="text" value="${esc(c.phone || "")}">
    <label style="margin-top:10px;">メールアドレス</label>
    <input id="c-emails" type="text" inputmode="email" placeholder="info@example.jp, sales@example.jp" value="${esc((c.emails || []).join(", "))}">
    <p class="sl-muted" style="margin:4px 0 0;">複数はカンマ区切り。保存時に小文字にして、重複を除きます</p>
    <label style="margin-top:10px;">メモ</label><textarea id="c-note" rows="3">${esc(c.note || "")}</textarea>`;
}
/**
 * 共通マスターの select。いまの値がマスターに無い（昔の自由入力）ときは、その値も「（マスター外）」として残す
 * （保存しても消えない。サーバーも変えていなければ通す）
 */
function masterOptions(list, cur) {
  const extra = cur && !list.includes(cur) ? [[cur, `${cur}（マスター外）`]] : [];
  return `<option value="">（未設定）</option>` + [...extra, ...list.map((v) => [v, v])]
    .map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("");
}
function companyFields() {
  return {
    name: el("c-name").value.trim(), siteUrl: el("c-site").value.trim() || null,
    formUrl: el("c-form").value.trim() || null, industry: el("c-industry").value || null,
    region: el("c-region").value || null, service: el("c-service").value || null,
    ownerId: el("c-owner").value || null, address: el("c-address").value.trim() || null,
    phone: el("c-phone").value.trim() || null, emails: el("c-emails").value,
    note: el("c-note").value.trim() || null,
  };
}

// ---- 企業詳細（右ドロワー） ---------------------------------------------------
let detail = null;

/** @returns {Promise<boolean>} 詳細を出せたら true（古い応答として捨てたら false） */
async function openDetail(id) {
  closeModal();
  const seq = ++detailSeq;
  detailOpenId = id;
  el("modal-root").innerHTML = `<div class="sl-drawer-bg" onclick="closeModal()"></div>
    <div class="sl-detail" id="detail-box"><div class="empty" style="padding:40px;">読み込み中…</div></div>`;
  history.replaceState({}, "", detailHost.urlFor(id));
  try {
    const d = await API.getSalesCompany(id);
    if (!detailIsCurrent(seq, id)) return false;
    detail = d;
    if (d.masters) masters = d.masters;
    renderDetail();
    return true;
  } catch (e) {
    if (!detailIsCurrent(seq, id)) return false;
    el("detail-box").innerHTML = `<div class="banner err" style="margin:20px;">
      <span class="material-symbols-outlined">error</span><div>${esc(errText(e, ""))}</div></div>`;
    return false;
  }
}

function recentLine(r) {
  return `${esc(ago(r.sentAt))}に${r.employeeName ? `${esc(r.employeeName)}さんが` : ""}${esc(r.channelLabel || "お問い合わせフォーム")}から送信済みです`
    + `（${esc(fmt(r.sentAt))}${r.service ? `・${esc(r.service)}` : ""}）`;
}

function renderDetail() {
  const box = el("detail-box");
  if (!box || !detail || detail.company.id !== detailOpenId) return;
  const c = detail.company;
  const link = (u) => u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>` : "—";
  const meeting = activeMeetingOf(detail.meetings);
  // フォームアタックは企業一覧だけ（リード一覧からは開かない）
  const attackBtn = (cls, label) => detailHost.openAttack
    ? `<button class="btn ${cls} btn-sm" onclick="detailHost.openAttack('${esc(c.id)}')">${label}</button>` : "";
  // リード（反応があった企業）の NEXT ACTION：Primary は「商談を予定する」1つだけ（要件 Phase 2）。
  // 返信・やり取り／フォローの記録は Secondary（同じ強さにしない）
  const lead = isLeadCompany(c);
  const cta = c.hidden
    ? `<button class="btn btn-primary btn-sm" onclick="unhideOne(this)">再表示する</button>`
    : c.ngReason ? ""
    : lead
      ? `<button class="btn btn-primary sl-cta-main" id="dt-meeting" onclick="openMeeting()">
           <span class="material-symbols-outlined icon-inline">event</span>${meeting?.status === "scheduled" ? "商談予定を見る" : "商談を予定する"}</button>
         <div class="sl-cta-sub">
           <button class="btn btn-secondary btn-sm" onclick="openContact()">返信・やり取りを記録</button>
           <button class="btn btn-secondary btn-sm" onclick="openEvent('follow')">フォローを記録</button>
         </div>`
    : c.nextKey === "follow_click"
      ? `<button class="btn btn-primary btn-sm" onclick="openEvent('follow')">フォローを記録</button>
         <button class="btn btn-secondary btn-sm" onclick="markFollowed(this)">対応済みにする</button>`
      : c.nextKey === "attack" && detailHost.openAttack
        ? attackBtn("btn-primary", "フォームアタック")
        : `<button class="btn btn-primary btn-sm" onclick="openEvent('follow')">対応を記録・NEXTを決める</button>`;

  // NEXT ACTION を最優先（見出しのすぐ下）。そのあとに注意・連絡状況・基本情報
  box.innerHTML = `
    <div style="padding:20px 20px 0;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
      <div style="min-width:0;">
        <div style="font-size:18px;font-weight:700;color:#1b2440;">${esc(c.name)}</div>
        <div style="font-size:12.5px;color:#6b7080;margin-top:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          ${c.ngReason ? statusPill("excluded", `NG：${c.ngLabel}`) : statusPill(c.status, c.statusLabel)}
          ${esc([c.industry, c.region, c.service].filter(Boolean).join(" ／ "))}</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="closeModal()">閉じる</button>
    </div>

    <div class="sl-next" id="dt-next" style="margin:14px 20px 12px;">
      <div class="now">現在：${esc(c.statusLabel)}${c.clickCount ? `　クリック ${c.clickCount}回（最終 ${esc(fmt(c.lastClickAt))}）` : ""}</div>
      <div class="lb"><span class="material-symbols-outlined">bolt</span>NEXT ACTION</div>
      <h3>${esc(c.next)}</h3>
      <div class="meta">担当：${esc(c.ownerName || "未定")}${c.nextDue ? `　期限：${esc(fmtDay(c.nextDue))}` : ""}${c.overdue ? "（期限超過）" : ""}</div>
      ${meeting ? `<div class="meta" style="margin-top:-4px;">商談：${esc(meetingStage(meeting).label)}${meeting.scheduledAt ? `　${esc(fmt(meeting.scheduledAt))}` : ""}
        ${meeting.meetingUrl ? `　<a href="${esc(meeting.meetingUrl)}" target="_blank" rel="noopener noreferrer">商談に参加</a>` : ""}</div>` : ""}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">${cta}</div>
    </div>

    <div style="padding:0 20px;">
      ${c.hidden ? `<div class="sl-warn sl-caution"><span class="material-symbols-outlined">visibility_off</span>
        <div>非表示にしています（${esc(c.hiddenLabel || "理由未設定")}）。通常の一覧・アタック対象には出ません。${c.hiddenNote ? `<br>${esc(c.hiddenNote)}` : ""}</div></div>` : ""}
      ${c.ngReason ? `<div class="sl-warn"><span class="material-symbols-outlined">block</span>
        <div>営業禁止（${esc(c.ngLabel)}）です。アタックできません。${c.ngNote ? `<br>${esc(c.ngNote)}` : ""}</div></div>` : ""}
      ${detail.recent && !c.ngReason ? `<div class="sl-warn sl-caution"><span class="material-symbols-outlined">warning</span>
        <div>${recentLine(detail.recent)}</div></div>` : ""}
    </div>

    ${contactStatusHtml(detail.contactStatus, c)}

    <div style="padding:0 20px 24px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        ${!c.ngReason && !c.hidden && c.nextKey !== "attack"
          ? attackBtn("btn-secondary", `<span class="material-symbols-outlined icon-inline">send</span>フォームアタック`) : ""}
        ${lead && !c.hidden && !c.ngReason ? "" : `<button class="btn btn-secondary btn-sm" onclick="openContact()">返信・やり取りを記録</button>`}
        ${c.nextKey === "attack" ? `<button class="btn btn-secondary btn-sm" onclick="openEvent('memo')">履歴を記録</button>` : ""}
        <button class="btn btn-secondary btn-sm" onclick="openStatus()">ステータス・NEXT</button>
        <button class="btn btn-secondary btn-sm" onclick="openEdit()">基本情報を編集</button>
        <button class="btn btn-secondary btn-sm" onclick="openNg()">${c.ngReason ? "営業禁止を解除" : "営業禁止にする"}</button>
        ${c.hidden ? "" : `<button class="btn btn-secondary btn-sm" onclick="openHideOne()">非表示にする</button>`}
      </div>

      <div class="card" style="margin-bottom:16px;">
        <dl class="sl-grid2">
          <div><dt>URL</dt><dd>${link(c.siteUrl)}</dd></div>
          <div><dt>フォームURL</dt><dd>${link(c.formUrl)}</dd></div>
          <div><dt>所在地</dt><dd>${esc(c.address || c.region || "—")}</dd></div>
          <div><dt>電話番号</dt><dd>${esc(c.phone || "—")}</dd></div>
          <div><dt>業種</dt><dd>${esc(c.industry || "—")}</dd></div>
          <div><dt>メールアドレス</dt><dd>${(c.emails || []).length ? c.emails.map((e) => esc(e)).join("<br>") : "—"}</dd></div>
          <div><dt>提案サービス</dt><dd>${esc(c.service || "—")}</dd></div>
          <div><dt>キャンペーン</dt><dd>${esc(c.campaignName || "—")}</dd></div>
          ${contactRows(c)}
          ${c.clickCount ? `<div><dt>初回クリック</dt><dd>${esc(fmt(c.firstClickAt))}</dd></div>
          <div><dt>最終クリック</dt><dd>${esc(fmt(c.lastClickAt))}（${c.clickCount}回）</dd></div>` : ""}
        </dl>
        ${c.note ? `<div style="font-size:12.5px;color:#1b2440;white-space:pre-wrap;border-top:1px solid #e2e2dc;padding-top:10px;">${esc(c.note)}</div>` : ""}
      </div>

      ${dealsHtml()}

      ${(detail.meetings || []).length ? `
        <h4 style="font-size:13px;color:#1b2440;margin:0 0 10px;">商談</h4>
        <div class="card" style="margin-bottom:16px;">${detail.meetings.map((m) => `
          <div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #efefeb;font-size:12.5px;flex-wrap:wrap;">
            <b style="color:#1b2440;">${esc(m.kindLabel)}（${m.durationMin}分）</b>
            ${m.status === "canceled" ? statusPill("lost", m.statusLabel) : statusPill(meetingStage(m).pill, meetingStage(m).label)}
            <span>${esc(m.scheduledAt ? fmt(m.scheduledAt) : "日時未定")}</span>
            <span class="sl-muted">担当 ${esc(m.ownerName || "未定")}</span>
            ${m.meetingUrl ? `<a href="${esc(m.meetingUrl)}" target="_blank" rel="noopener noreferrer">商談URL</a>` : ""}
          </div>`).join("")}</div>` : ""}

      <h4 style="font-size:13px;color:#1b2440;margin:0 0 10px;">営業履歴</h4>
      ${timelineHtml(detail.timeline)}

      ${(detail.approaches || []).length ? `
        <h4 style="font-size:13px;color:#1b2440;margin:18px 0 10px;">送った営業文</h4>
        ${detail.approaches.map((a) => `
          <details class="card" style="margin-bottom:8px;">
            <summary style="cursor:pointer;font-size:12.5px;color:#1b2440;">
              ${esc(fmt(a.sentAt || a.preparedAt))}　${esc(a.channelLabel || "")}${a.sendFrom ? `（${esc(a.sendFrom)}）` : ""}　${esc(a.employeeName || "")}　${esc(a.service || "")}
              ${a.clickCount ? `<span class="sl-hot">　クリック${a.clickCount}回</span>` : ""}${a.forced ? `<span class="sl-muted">　（警告を押し切り）</span>` : ""}</summary>
            <div style="font-size:12.5px;white-space:pre-wrap;margin-top:8px;">${esc(a.body || "")}</div>
          </details>`).join("")}` : ""}
    </div>`;
}

// 現在の連絡状況（最初の送信・返信元・いまの連絡手段・最終連絡・担当）
function contactStatusHtml(s, c) {
  if (!s) return "";
  const row = (dt, dd) => `<div><dt>${esc(dt)}</dt><dd>${dd}</dd></div>`;
  const or = (v) => (v ? esc(v) : `<span class="sl-muted">—</span>`);
  return `<div class="card" id="contact-status" style="margin:0 20px 12px;padding:12px 14px;">
    <div style="font-size:12px;font-weight:700;color:#1b2440;margin-bottom:6px;">現在の連絡状況</div>
    <dl class="sl-grid2" style="margin:0;">
      ${row("最初の送信", or(s.firstChannelLabel))}
      ${row("返信", or(s.replyChannelLabel))}
      ${row("現在の連絡手段", s.currentChannelLabel ? `${esc(s.currentChannelLabel)}${s.currentValue ? `<span class="sl-sub2">${esc(s.currentValue)}</span>` : ""}` : or(null))}
      ${row("最終連絡", or(s.lastContactAt ? fmt(s.lastContactAt) : null))}
      ${row("担当", or(c.ownerName || "未定"))}
    </dl></div>`;
}

// 連絡先（登録されているものだけ）
const CONTACT_LABEL = { email: "メール", line: "LINE", instagram: "Instagram", x: "X", facebook: "Facebook",
  linkedin: "LinkedIn", phone: "電話", other: "その他連絡先" };
function contactRows(c) {
  return Object.entries(c.contacts || {}).filter(([k, v]) => v && CONTACT_LABEL[k])
    .map(([k, v]) => `<div><dt>${esc(CONTACT_LABEL[k])}</dt><dd>${esc(v)}</dd></div>`).join("");
}

function timelineHtml(list) {
  if (!(list || []).length) return `<p class="sl-muted">まだ記録がありません。</p>`;
  return `<div class="sl-tl">${list.map((t) => `
    <div class="row${t.kind === "click" ? " click" : ""}${t.planned ? " planned" : ""}">
      <div class="d">${esc(t.planned ? fmtDay(String(t.at).slice(0, 10)) : fmt(t.at))}</div>
      <div class="l">${esc(t.label)}</div>
      ${t.detail ? `<div class="x">${esc(t.detail)}</div>` : ""}
    </div>`).join("")}</div>`;
}

// ---- 営業の商談（Phase 2） ------------------------------------------------------------
//
// 商談の種類は、まず「初回商談 30分」だけ。企業一覧・リード一覧のどちらからでも、この1つのモーダルを使う。
// 「商談を予定する」→「日程調整を開始」（TimeRex の日程調整URLを発行）→ 相手に送る
// → 相手が予約（TimeRex Webhook が guest_email と企業のメールで照合して自動で商談予定に）→ 商談予定。
// TimeRex が未設定のときは、商談を作って日程を手入力する。
const LEAD_STATUSES = ["replied", "meeting", "proposal"];
function isLeadCompany(c) {
  if (c.ngReason || ["lost", "excluded", "won"].includes(c.status)) return false;
  return c.clickCount > 0 || LEAD_STATUSES.includes(c.status);
}
function activeMeetingOf(list) {
  return (list || []).find((m) => m.status === "scheduling" || m.status === "scheduled") || null;
}
// 営業から見た商談の段階（画面の言葉。「状態：未設定」のような曖昧な出し方はしない）
//   未送信＝まだ日程調整を始めていない／予約待ち＝日程調整URLを発行済みで相手の予約待ち／
//   商談予定＝日時が決まった／実施済み＝商談が終わった
const MEETING_STAGES = {
  none: { label: "未送信", pill: "untouched" },
  scheduling: { label: "予約待ち", pill: "clicked" },
  scheduled: { label: "商談予定", pill: "meeting" },
  done: { label: "実施済み", pill: "won" },
};
function meetingStage(m) {
  const key = m && MEETING_STAGES[m.status] ? m.status : "none";
  return { key, ...MEETING_STAGES[key] };
}
// モーダルが扱う商談：進行中のもの。無ければ直近の実施済み（段階の表示だけに使う）
function meetingForModal(list) {
  return activeMeetingOf(list) || (list || []).find((m) => m.status === "done") || null;
}

// 予約の照合に使うメールアドレス（API の matchEmails。Webhook と同じ判定）。
// 複数あるときは、案内文に入れるアドレスを選べる（照合はどのアドレスでも行われる）
let meetingEmail = "";
function meetingEmails() { return detail.matchEmails || []; }
function pickedMeetingEmail() {
  const list = meetingEmails();
  return list.includes(meetingEmail) ? meetingEmail : list[0] || "";
}
function pickMeetingEmail(v) { meetingEmail = v; const t = el("mt-mail"); if (t) t.value = meetingMail(t.dataset.url); }

function meetingMail(url) {
  const c = detail.company;
  const email = pickedMeetingEmail();
  return `件名：お打ち合わせ日程のご相談

${c.name}
ご担当者様

株式会社エイトの${myName}です。
このたびはご関心をお寄せいただき、ありがとうございます。

一度30分ほど、オンラインでお話しできればと思っております。
下記URLより、ご都合のよい日時をお選びください。

${url}
${email ? `\nご予約の際は、メールアドレスに ${email} をご入力ください。\n` : ""}
どうぞよろしくお願いいたします。`;
}

// 予約照合に使うメールアドレスの欄。無ければその場で登録できる（基本情報の連絡先として保存）
function meetingEmailHtml(required) {
  const list = meetingEmails();
  if (!list.length) {
    return `<div class="banner warn" style="margin:0;" id="mt-no-email"><span class="material-symbols-outlined">mail</span>
        <div>メールアドレスが未登録です。${required ? "登録すると日程調整を開始できます。" : ""}
          TimeRex の予約は、予約時のメールアドレスと企業のメールの一致で商談に反映されます。</div></div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <input id="mt-email-input" type="email" placeholder="tanaka@example.co.jp" style="margin:0;flex:1;">
        <button class="btn btn-secondary btn-sm" id="mt-email-save" onclick="saveMeetingEmail(this)">メールを登録</button>
      </div>`;
  }
  const picked = pickedMeetingEmail();
  return list.length === 1
    ? `<div id="mt-email" style="font-weight:600;color:#1b2440;word-break:break-all;">${esc(list[0])}</div>`
    : `<div id="mt-email">${list.map((v) => `
        <label class="sl-chip"><input type="radio" name="mt-email" value="${esc(v)}" ${v === picked ? "checked" : ""}
          onchange="pickMeetingEmail(this.value)">${esc(v)}</label>`).join("")}</div>
      <p class="sl-muted" style="margin:4px 0 0;">どのアドレスで予約されても照合されます。案内文には選んだアドレスを入れます。</p>`;
}

function openMeeting() {
  const c = detail.company;
  const m = activeMeetingOf(detail.meetings);
  const stage = meetingStage(meetingForModal(detail.meetings));
  const hasEmail = meetingEmails().length > 0;
  // TimeRex で日程調整するときは、照合に使うメールが無いと始められない（API も 400 email_required で断る）
  const needEmail = Boolean(detail.timerexConfigured);
  const ownerId = m?.ownerId || c.ownerId || myEmployeeId || "";
  const ownerOpts = (detail.members || []).map((x) =>
    `<option value="${esc(x.id)}" ${x.id === ownerId ? "selected" : ""}>${esc(x.display_name)}</option>`).join("");
  const manual = (mid) => `
    <details style="margin-top:14px;" ${m?.status === "scheduled" || !detail.timerexConfigured ? "open" : ""}>
      <summary style="cursor:pointer;font-size:13px;color:#4a5068;">${m?.status === "scheduled" ? "日程を変更する" : "日程が決まった（手入力）"}</summary>
      <label style="margin-top:10px;">商談の日時</label><input id="mt-when" type="datetime-local">
      <label style="margin-top:10px;">商談URL（Google Meet など）</label>
      <input id="mt-url" type="text" placeholder="https://meet.google.com/..." value="${esc(m?.meetingUrl || "")}">
      <button class="btn btn-primary btn-sm" style="margin-top:10px;" onclick="scheduleMeeting(this, '${esc(mid)}')">日程を確定</button>
    </details>`;

  let body;
  if (detail.meetingsReady === false) {
    body = `<div class="banner warn"><span class="material-symbols-outlined">build</span>
      <div>商談の表がまだ作られていません。管理者に db/090_sales_meetings.sql の実行を依頼してください。</div></div>`;
  } else if (!m) {
    // 未送信（または前回の商談が実施済み）：日程調整を始める。既に進行中の商談があれば API は新しく作らない
    body = `
      ${!detail.timerexConfigured ? `<div class="banner warn"><span class="material-symbols-outlined">build</span>
        <div>TimeRexの営業用URLが未設定です（環境変数 TIMEREX_SALES_MEETING_URL）。商談を作ったあと、日程を手入力してください。</div></div>` : ""}
      <button class="btn btn-primary" id="mt-start" onclick="issueMeeting(this)" ${needEmail && !hasEmail ? "disabled" : ""}>
        <span class="material-symbols-outlined icon-inline">event</span>${detail.timerexConfigured ? "日程調整を開始" : "商談を作成"}</button>
      ${needEmail && !hasEmail ? `<p class="sl-muted" style="margin:6px 0 0;">メールアドレスを登録すると押せるようになります。</p>` : ""}`;
  } else if (m.status === "scheduled") {
    body = `
      <div class="banner info" style="margin:0 0 10px;" id="mt-scheduled"><span class="material-symbols-outlined">event_available</span>
        <div>商談予定：${esc(fmt(m.scheduledAt))}（${esc(m.kindLabel)} ${m.durationMin}分・担当 ${esc(m.ownerName || "未定")}）
          ${m.fromTimerex ? `<span class="sl-pill" style="background:#e3f1ea;color:#1d6b43;margin-left:6px;">TimeRexで予約確定</span>` : ""}</div></div>
      ${m.meetingUrl ? `<div class="sl-muted" style="margin:0 0 8px;word-break:break-all;">Google Meet：${esc(m.meetingUrl)}</div>
        <a class="btn btn-primary" href="${esc(m.meetingUrl)}" target="_blank" rel="noopener noreferrer">
        <span class="material-symbols-outlined icon-inline">videocam</span>商談に参加</a>` : ""}
      ${m.fromTimerex
        // TimeRex で確定した日時・Meet URL は TimeRex が正（ここから変えない。変更は TimeRex で）
        ? `<p class="sl-muted" style="margin:12px 0 0;">日時・Meet URL は TimeRex の予約から自動で入りました。変更は TimeRex で行ってください。</p>`
        : manual(m.id)}
      <button class="btn btn-secondary btn-sm" style="margin-top:14px;" onclick="cancelMeeting(this, '${esc(m.id)}')">商談を取りやめ</button>`;
  } else {
    // 予約待ち：日程調整URLは発行済み（もう一度押しても新しい商談は作らない）
    body = `
      ${m.schedulingUrl ? `
        <label>TimeRex 日程調整URL</label>
        <input id="mt-sched" type="text" readonly value="${esc(m.schedulingUrl)}" onclick="this.select()">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
          <button class="btn btn-primary btn-sm" id="mt-copy" onclick="copyText('mt-sched', this)">
            <span class="material-symbols-outlined icon-inline">content_copy</span>URLをコピー</button>
          <a class="btn btn-secondary btn-sm" id="mt-open" href="${esc(m.schedulingUrl)}" target="_blank" rel="noopener noreferrer">
            <span class="material-symbols-outlined icon-inline">open_in_new</span>予約ページを開く</a>
        </div>
        <label style="margin-top:12px;">メール・フォーム返信の文面</label>
        <textarea id="mt-mail" rows="9" readonly data-url="${esc(m.schedulingUrl)}">${esc(meetingMail(m.schedulingUrl))}</textarea>
        <button class="btn btn-secondary btn-sm" style="margin-top:6px;" onclick="copyText('mt-mail', this)">文面をコピー</button>
        <div style="margin-top:14px;">${m.schedulingSentAt
          ? `<span class="sl-muted">送付済み（${esc(fmt(m.schedulingSentAt))}）。相手の予約を待っています。</span>`
          : `<button class="btn btn-secondary" onclick="markMeetingSent(this, '${esc(m.id)}')">送付済みにする</button>`}</div>`
        : `<div class="banner warn"><span class="material-symbols-outlined">build</span>
            <div>TimeRexの営業用URLが未設定です（TIMEREX_SALES_MEETING_URL）。日程が決まったら手入力してください。</div></div>`}
      ${manual(m.id)}
      <button class="btn btn-secondary btn-sm" style="margin-top:14px;" onclick="cancelMeeting(this, '${esc(m.id)}')">商談を取りやめ</button>`;
  }

  openActionModal(`
      <h2 style="margin-bottom:12px;">${m?.status === "scheduled" ? "商談予定" : "商談を予定する"}</h2>
      <dl class="sl-grid2" id="mt-info" style="margin-bottom:6px;">
        <div><dt>会社名</dt><dd>${esc(c.name)}</dd></div>
        <div><dt>商談の種類</dt><dd>初回商談（30分）</dd></div>
        <div><dt>担当</dt><dd>${m ? esc(m.ownerName || "未定")
          : `<select id="mt-owner" style="margin:0;"><option value="">（未定）</option>${ownerOpts}</select>`}</dd></div>
        <div><dt>営業状態</dt><dd id="mt-stage">${statusPill(stage.pill, stage.label)}</dd></div>
      </dl>
      <label>予約照合に使うメールアドレス</label>
      ${meetingEmailHtml(needEmail && !m)}
      <div style="margin-top:16px;">${body}</div>
      <div id="mt-msg" class="err-text" style="margin:10px 0;"></div>
      <div class="sl-modal-foot">
        <button class="btn btn-secondary" onclick="closeAction()">閉じる</button>
      </div>`);
}

async function refreshMeeting() {
  const id = detail.company.id;
  const seq = detailSeq;
  const d = await API.getSalesCompany(id);
  detailHost.onChange();
  // 取得中に詳細を閉じた・別の企業に切り替えたなら、画面には書かない
  if (!detailIsCurrent(seq, id)) return;
  detail = d;
  renderDetail();
  openMeeting();
}

async function issueMeeting(btn) {
  const msg = el("mt-msg"); msg.textContent = "";
  try {
    await KPLayout.busy(btn, "開始中…", () => API.issueSalesMeeting({
      companyId: detail.company.id, ownerId: el("mt-owner")?.value || undefined,
    }));
    await refreshMeeting();
  } catch (e) { msg.textContent = errText(e, "日程調整を開始できませんでした"); }
}

// 予約照合用のメールを、企業のメールアドレス（emails[]。基本情報の「メールアドレス」と同じ）に足す。
// 形式チェック・小文字・重複除去はサーバー（lib/sales.js parseEmails）。営業履歴は増やさない
async function saveMeetingEmail(btn) {
  const msg = el("mt-msg"); msg.textContent = "";
  const v = el("mt-email-input").value.trim();
  if (!v) { msg.textContent = "メールアドレスを入れてください"; return; }
  try {
    const emails = [...(detail.company.emails || []), v];
    await KPLayout.busy(btn, "登録中…", () => API.updateSalesCompany({ id: detail.company.id, emails }));
    meetingEmail = v.toLowerCase();
    await refreshMeeting();
  } catch (e) { msg.textContent = errText(e, "登録できませんでした"); }
}

async function markMeetingSent(btn, id) {
  const msg = el("mt-msg"); msg.textContent = "";
  try {
    await KPLayout.busy(btn, "記録中…", () => API.salesMeetingAct({ id, action: "sent" }));
    await refreshMeeting();
  } catch (e) { msg.textContent = errText(e, "記録できませんでした"); }
}

async function scheduleMeeting(btn, id) {
  const msg = el("mt-msg"); msg.textContent = "";
  const when = el("mt-when").value;
  if (!when) { msg.textContent = "商談の日時を入れてください"; return; }
  try {
    await KPLayout.busy(btn, "確定中…", () => API.salesMeetingAct({
      id, action: "schedule", scheduledAt: new Date(when).toISOString(), meetingUrl: el("mt-url").value.trim() || null,
    }));
    await refreshMeeting();
  } catch (e) { msg.textContent = errText(e, "確定できませんでした"); }
}

async function cancelMeeting(btn, id) {
  if (!confirm("この商談を取りやめにします。よろしいですか？")) return;
  const msg = el("mt-msg"); msg.textContent = "";
  try {
    await KPLayout.busy(btn, "保存中…", () => API.salesMeetingAct({ id, action: "cancel" }));
    await refreshMeeting();
  } catch (e) { msg.textContent = errText(e, "できませんでした"); }
}

// 保存・更新のあと：企業詳細を取り直し、開いたままのドロワーへ反映する（開き直さない）。
// 一覧は裏で取り直す
async function reloadDetail() {
  const id = detail.company.id;
  const seq = detailSeq;
  detailHost.onChange();
  try {
    const d = await API.getSalesCompany(id);
    if (!detailIsCurrent(seq, id)) return;
    detail = d;
    renderDetail();
  } catch (e) {
    if (detailIsCurrent(seq, id)) alert(errText(e, "最新の状態を取得できませんでした"));
  }
}

// ---- 案件（db/115） ----------------------------------------------------------------
//
// 1社に複数の案件を持てる。金額・段階（商談 → 提案 → 最終調整 → 成約／失注）を記録し、
// 分析の 受注額・見込額・パイプライン はここから数える（金額は営業の案件金額。会計上の売上ではない）。
// 会社のステータスはサーバが案件に合わせて進める（戻さない）。失注は会社に写さず、
// その会社の案件がすべて失注になったときだけ「会社も失注にしますか」と聞く。
// 成約確率の既定値は lib/sales-deals.js の DEFAULT_PROBABILITY・db/115 と同じ
const DEAL_STAGES = [["meeting", "商談"], ["proposal", "提案"], ["negotiation", "最終調整"], ["won", "成約"], ["lost", "失注"]];
const DEAL_OPEN = ["meeting", "proposal", "negotiation"];
const DEAL_PROB = { meeting: 20, proposal: 50, negotiation: 80 };
const DEAL_PILL = { meeting: "attacked", proposal: "proposal", negotiation: "clicked", won: "won", lost: "lost" };
const dealYen = (n) => (n == null ? "金額未定" : `${Number(n).toLocaleString("ja-JP")}円`);

function dealsHtml() {
  const head = (btn) => `<div style="display:flex;align-items:center;gap:8px;margin:0 0 10px;">
    <h4 style="font-size:13px;color:#1b2440;margin:0;flex:1;">案件</h4>${btn}</div>`;
  if (detail.dealsReady === false) {
    return head("") + `<div class="card" style="margin-bottom:16px;"><div class="sl-empty">
      案件の表がまだ作られていません。管理者に db/115_sales_deals.sql の実行を依頼してください。</div></div>`;
  }
  const list = detail.deals || [];
  const add = `<button class="btn btn-secondary btn-sm" id="dl-add" onclick="openDeal()">
    <span class="material-symbols-outlined icon-inline">add</span>案件を追加</button>`;
  if (!list.length) {
    return head(add) + `<div class="card" style="margin-bottom:16px;"><div class="sl-empty">
      まだ案件がありません。商談になったら金額と段階を登録すると、分析の受注額・見込額・パイプラインに入ります。</div></div>`;
  }
  return head(add) + `<div class="card" style="margin-bottom:16px;">${list.map((d) => `
    <div class="deal-row" onclick="openDeal('${esc(d.id)}')" role="button" tabindex="0"
      style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #efefeb;font-size:12.5px;flex-wrap:wrap;cursor:pointer;">
      <b style="color:#1b2440;">${esc(d.title)}</b>
      ${statusPill(DEAL_PILL[d.stage] || "attacked", d.stageLabel)}
      <span style="font-variant-numeric:tabular-nums;">${esc(dealYen(d.amount))}</span>
      <span class="sl-muted">${d.open
        ? (d.amount != null ? `見込額 ${esc(dealYen(d.expected))}（${d.probabilityUsed}%${d.probability != null ? "・個別" : ""}）` : "")
        : d.stage === "won" ? `成約 ${esc(fmtDay(d.wonOn))}` : `失注 ${esc(fmtDay(d.lostOn))}${d.lostReason ? `（${esc(d.lostReason)}）` : ""}`}</span>
      <span class="sl-muted" style="margin-left:auto;">担当 ${esc(d.ownerName || "未定")}</span>
    </div>`).join("")}</div>`;
}

function openDeal(id) {
  const d = id ? (detail.deals || []).find((x) => x.id === id) : null;
  const stages = d ? DEAL_STAGES : DEAL_STAGES.filter(([k]) => DEAL_OPEN.includes(k));
  const stage = d?.stage || "meeting";
  const ownerOpts = (detail.members || []).map((m) =>
    `<option value="${esc(m.id)}" ${m.id === (d?.ownerId || detail.company.ownerId) ? "selected" : ""}>${esc(m.display_name)}</option>`).join("");
  openActionModal(`
    <h2>${d ? "案件を編集" : "案件を追加"}</h2>
    <p class="sl-sub" style="margin:-8px 0 12px;">${esc(detail.company.name)}</p>
    <label>案件名</label>
    <input id="dl-title" type="text" maxlength="200" placeholder="例：AI/DX 導入支援" value="${esc(d?.title || "")}">
    <label style="margin-top:10px;">段階</label>
    <select id="dl-stage" onchange="dealStageChanged()">${stages.map(([k, l]) =>
      `<option value="${k}" ${k === stage ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
    <label style="margin-top:10px;">案件金額（円・税抜。会計上の売上ではありません）</label>
    <input id="dl-amount" type="text" inputmode="numeric" placeholder="例：1200000（未定なら空欄）" value="${d?.amount ?? ""}">
    <div id="dl-prob-box">
      <label style="margin-top:10px;">成約確率（%）</label>
      <input id="dl-prob" type="number" min="0" max="100" step="1" value="${d?.probability ?? ""}">
      <div class="sl-muted" id="dl-prob-hint" style="margin-top:4px;"></div>
    </div>
    <label style="margin-top:10px;">成約見込み日</label>
    <input id="dl-close" type="date" value="${esc(d?.expectedCloseOn || "")}">
    <div id="dl-lost-box">
      <label style="margin-top:10px;">失注の理由</label>
      <input id="dl-lost" type="text" maxlength="500" placeholder="例：予算が合わない" value="${esc(d?.lostReason || "")}">
    </div>
    <label style="margin-top:10px;">担当</label>
    <select id="dl-owner"><option value="">（未定）</option>${ownerOpts}</select>
    ${d ? "" : `<p class="sl-muted" style="margin:10px 0 0;">この会社に最後に送ったアタックを、案件のもとのアタックとして記録します（あとから変わりません）。</p>`}
    <div id="dl-msg" class="err-text" style="margin:10px 0;"></div>
    <div class="sl-modal-foot">
      <button class="btn btn-primary" onclick="saveDeal(this, ${d ? `'${esc(d.id)}'` : "null"})">${d ? "保存" : "追加"}</button>
      <button class="btn btn-secondary" onclick="closeAction()">閉じる</button>
    </div>`);
  dealStageChanged();
}

function dealStageChanged() {
  const st = el("dl-stage")?.value;
  if (!st) return;
  el("dl-prob-box").style.display = DEAL_OPEN.includes(st) ? "" : "none";
  el("dl-lost-box").style.display = st === "lost" ? "" : "none";
  el("dl-prob-hint").textContent = DEAL_OPEN.includes(st) ? `空欄なら既定の ${DEAL_PROB[st]}%（${DEAL_STAGES.find(([k]) => k === st)[1]}）を使います` : "";
}

async function saveDeal(btn, id) {
  const msg = el("dl-msg"); msg.textContent = "";
  const stage = el("dl-stage").value;
  const body = {
    title: el("dl-title").value.trim(), stage,
    amount: el("dl-amount").value.trim() === "" ? null : el("dl-amount").value.trim(),
    probability: DEAL_OPEN.includes(stage) && el("dl-prob").value !== "" ? Number(el("dl-prob").value) : null,
    expectedCloseOn: el("dl-close").value || null,
    ownerId: el("dl-owner").value || null,
  };
  if (stage === "lost") body.lostReason = el("dl-lost").value.trim() || null;
  if (!body.title) { msg.textContent = "案件名を入れてください"; return; }
  if (stage === "won" && (body.amount === null || Number(String(body.amount).replace(/[,，円¥\s]/g, "")) <= 0)) {
    msg.textContent = "成約にするには0円より大きい案件金額を入れてください"; return;
  }
  try {
    const r = await KPLayout.busy(btn, "保存中…", () => (id
      ? API.updateSalesDeal({ id, ...body })
      : API.createSalesDeal({ companyId: detail.company.id, ...body })));
    closeAction();
    await reloadDetail();
    if (r.suggestCompanyLost && confirm("この会社の案件はすべて失注です。会社のステータスも「失注」にしますか？")) {
      await API.updateSalesCompany({ id: detail.company.id, status: "lost" });
      await reloadDetail();
    }
  } catch (e) { msg.textContent = errText(e, "保存できませんでした"); }
}

async function markFollowed(btn) {
  try {
    await KPLayout.busy(btn, "保存中…", () => API.markSalesFollowed(detail.company.id));
    await reloadDetail();
  } catch (e) { alert(errText(e, "できませんでした")); }
}

// ---- 履歴を記録（フォロー・電話・返信あり・商談…）＋NEXT ---------------------------
function openEvent(kind) {
  const c = detail.company;
  const kinds = detail.eventKinds || [];
  openActionModal(`
      <h2>履歴を記録</h2>
      <label>何をしたか</label>
      <div>${kinds.map((k) => `
        <label class="sl-chip"><input type="radio" name="ev-kind" value="${esc(k.key)}" ${k.key === kind ? "checked" : ""}>${esc(k.label)}</label>`).join("")}</div>
      <label style="margin-top:10px;">内容（任意）</label>
      <textarea id="ev-detail" rows="3" placeholder="担当の山田様と電話。来週資料送付"></textarea>
      <label style="margin-top:10px;">日時</label>
      <input id="ev-at" type="datetime-local">
      <h4 style="font-size:13px;color:#1b2440;margin:18px 0 6px;">NEXT（次にやること）</h4>
      <input id="ev-next" type="text" list="dl-next" placeholder="空欄なら反応に合わせて自動で決まります">
      <datalist id="dl-next">${["フォロー", "再アタック", "担当者確認", "電話", "メール", "商談準備", "資料送付"].map((v) => `<option value="${esc(v)}">`).join("")}</datalist>
      <input id="ev-next-on" type="date" style="margin-top:6px;">
      <p class="sl-muted" style="margin:6px 0 0;">いまのNEXT：${esc(c.next)}${c.nextDue ? `（${esc(fmtDay(c.nextDue))}）` : ""}<br>
        空欄のとき：返信あり → 返信対応（当日）／商談 → 商談準備（当日）／フォロー・電話・メール → 反応確認（3営業日後）。
        「返信あり」「商談」はステータスも進みます。</p>
      <div id="ev-msg" class="err-text" style="margin:10px 0;"></div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn btn-primary" onclick="submitEvent(this)">記録する</button>
        <button class="btn btn-secondary" onclick="closeAction()">閉じる</button>
      </div>`);
}

async function submitEvent(btn) {
  const msg = el("ev-msg"); msg.textContent = "";
  const picked = document.querySelector('input[name="ev-kind"]:checked');
  if (!picked) { msg.textContent = "何をしたかを選んでください"; return; }
  const at = el("ev-at").value;
  try {
    await KPLayout.busy(btn, "記録中…", () => API.addSalesEvent({
      id: detail.company.id, kind: picked.value, detail: el("ev-detail").value.trim() || undefined,
      occurredAt: at ? new Date(at).toISOString() : undefined,
      nextAction: el("ev-next").value.trim() || null, nextActionOn: el("ev-next-on").value || null,
    }));
    closeAction();
    await reloadDetail();
  } catch (e) { msg.textContent = errText(e, "記録できませんでした"); }
}

// ---- 返信・やり取りを記録（返信元・いまの連絡手段・連絡先・メモ・NEXT） ------------------
//
// 返信元（どこから返事が来たか）と、いまの連絡手段（どこでやり取りしているか）は別に持つ。
// 連絡手段を変えただけでは営業ステータスは動かない。「先方から返信」のときだけ「返信あり」まで進む。
const CONTACT_PLACEHOLDER = { email: "tanaka@example.co.jp", line: "LINE名", instagram: "@account", x: "@account",
  facebook: "ページ名・URL", linkedin: "氏名・URL", phone: "03-1234-5678", other: "その他の連絡先" };
function openContact() {
  const c = detail.company;
  const early = ["untouched", "attacked", "clicked", "reattack_wait"].includes(c.status);
  const replyChannels = detail.replyChannels || [];
  const contactChannels = detail.contactChannels || [];
  openActionModal(`
      <h2>返信・やり取りを記録</h2>
      <label>種類</label>
      <div>
        <label class="sl-chip"><input type="radio" name="ct-kind" value="reply" ${early ? "checked" : ""} onchange="toggleContactKind()">先方から返信があった</label>
        <label class="sl-chip"><input type="radio" name="ct-kind" value="contact" ${early ? "" : "checked"} onchange="toggleContactKind()">こちらから連絡・やり取り</label>
      </div>
      <div id="ct-reply-box" ${early ? "" : "hidden"}>
        <label style="margin-top:10px;">返信元（どこから返事があったか）</label>
        <div>${replyChannels.map((r) => `
          <label class="sl-chip"><input type="radio" name="ct-reply" value="${esc(r.key)}" onchange="suggestContactChannel(this.value)">${esc(r.label)}</label>`).join("")}</div>
      </div>
      <label style="margin-top:10px;">現在の連絡手段</label>
      <select id="ct-channel" onchange="focusContactValue()"><option value="">（${c.contactChannelLabel ? `変更しない：${esc(c.contactChannelLabel)}` : "未設定のまま"}）</option>
        ${contactChannels.map((x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join("")}</select>
      <p class="sl-muted" style="margin:4px 0 0;">連絡手段を変えても、営業ステータスは変わりません。</p>
      <details style="margin-top:10px;" ${Object.keys(c.contacts || {}).length ? "" : "open"}>
        <summary style="cursor:pointer;font-size:12.5px;color:#1b2440;">連絡先（任意）</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">${contactChannels.map((x) => `
          <div><label>${esc(x.key === "other" ? "その他連絡先" : x.label)}</label>
            <input id="ct-c-${esc(x.key)}" type="text" value="${esc((c.contacts || {})[x.key] || "")}" placeholder="${esc(CONTACT_PLACEHOLDER[x.key] || "")}"></div>`).join("")}</div>
      </details>
      <label style="margin-top:10px;">メモ（任意）</label>
      <textarea id="ct-note" rows="3" placeholder="担当の田中様よりInstagramで返信。詳細資料はメールで送付。"></textarea>
      <label style="margin-top:10px;">日時</label>
      <input id="ct-at" type="datetime-local">
      <h4 style="font-size:13px;color:#1b2440;margin:18px 0 6px;">NEXT（次にやること）</h4>
      <input id="ct-next" type="text" list="dl-ct-next" placeholder="空欄のとき：返信なら「返信対応」（当日）。やり取りならいまのNEXTのまま">
      <datalist id="dl-ct-next">${["資料送付", "日程調整", "返信対応", "電話", "フォロー", "商談準備"].map((v) => `<option value="${esc(v)}">`).join("")}</datalist>
      <input id="ct-next-on" type="date" style="margin-top:6px;">
      <p class="sl-muted" style="margin:6px 0 0;">いまのNEXT：${esc(c.next)}${c.nextDue ? `（${esc(fmtDay(c.nextDue))}）` : ""}</p>
      <div id="ct-msg" class="err-text" style="margin:10px 0;"></div>
      <div class="sl-modal-foot">
        <button class="btn btn-primary" onclick="submitContact(this)">記録する</button>
        <button class="btn btn-secondary" onclick="closeAction()">閉じる</button>
      </div>`);
}
function toggleContactKind() {
  const reply = document.querySelector('input[name="ct-kind"]:checked')?.value === "reply";
  el("ct-reply-box").hidden = !reply;
}
// 返信が来たチャネルで、そのままやり取りすることが多い。連絡手段が未選択なら同じものを入れておく
function suggestContactChannel(v) {
  const sel = el("ct-channel");
  if (sel && !sel.value && [...sel.options].some((o) => o.value === v)) sel.value = v;
}
function focusContactValue() {
  const v = el("ct-channel").value;
  const box = v && el(`ct-c-${v}`);
  if (box && !box.value) { box.closest("details").open = true; box.focus(); }
}
async function submitContact(btn) {
  const msg = el("ct-msg"); msg.textContent = "";
  const c = detail.company;
  const reply = document.querySelector('input[name="ct-kind"]:checked')?.value === "reply";
  const replyChannel = document.querySelector('input[name="ct-reply"]:checked')?.value || null;
  if (reply && !replyChannel) { msg.textContent = "どこから返信があったかを選んでください"; return; }
  // 連絡先は、変わった項目だけを送る（空欄にした項目は消す）
  const contacts = {};
  for (const x of detail.contactChannels || []) {
    const v = el(`ct-c-${x.key}`).value.trim();
    if (v !== ((c.contacts || {})[x.key] || "")) contacts[x.key] = v || null;
  }
  const at = el("ct-at").value;
  try {
    await KPLayout.busy(btn, "記録中…", () => API.addSalesContact({
      id: c.id, replied: reply, replyChannel: reply ? replyChannel : undefined,
      contactChannel: el("ct-channel").value || undefined,
      contacts: Object.keys(contacts).length ? contacts : undefined,
      note: el("ct-note").value.trim() || undefined,
      occurredAt: at ? new Date(at).toISOString() : undefined,
      nextAction: el("ct-next").value.trim() || null, nextActionOn: el("ct-next-on").value || null,
    }));
    closeAction();
    await reloadDetail();
  } catch (e) { msg.textContent = errText(e, "記録できませんでした"); }
}

// ---- 非表示（1社） -------------------------------------------------------------
function openHideOne() {
  openActionModal(`
    <h2>この企業を非表示にします</h2>
    <p class="sl-sub" style="margin:0 0 12px;">削除ではありません。データは残り、通常の一覧・アタック対象から外れます。いつでも再表示できます。</p>
    ${hideForm("dt-hide")}
    <div id="dt-hide-msg" class="err-text" style="margin:10px 0 0;"></div>
    <div class="sl-modal-foot">
      <button class="btn btn-primary" onclick="submitHideOne(this)">非表示にする</button>
      <button class="btn btn-secondary" onclick="closeAction()">閉じる</button>
    </div>`);
}
async function submitHideOne(btn) {
  const v = hidePicked("dt-hide", "dt-hide-msg");
  if (!v) return;
  try {
    await KPLayout.busy(btn, "保存中…", () => API.bulkSalesCompanies({ ids: [detail.company.id], action: "hide", ...v }));
    closeAction();
    await reloadDetail();
  } catch (e) { el("dt-hide-msg").textContent = errText(e, "できませんでした"); }
}
async function unhideOne(btn) {
  try {
    await KPLayout.busy(btn, "保存中…", () => API.bulkSalesCompanies({ ids: [detail.company.id], action: "unhide" }));
    await reloadDetail();
  } catch (e) { alert(errText(e, "できませんでした")); }
}

// ---- ステータス・NEXT ---------------------------------------------------------
function openStatus() {
  const c = detail.company;
  openActionModal(`
      <h2>ステータス・NEXT</h2>
      <label>ステータス</label>
      <select id="st-status">${(detail.statuses || []).map((s) =>
        `<option value="${esc(s.key)}" ${s.key === c.status ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
      <label style="margin-top:10px;">NEXT（次にやること）</label>
      <input id="st-next" type="text" list="dl-next2" value="${esc(c.nextKey === "manual" ? c.next : "")}">
      <datalist id="dl-next2">${["フォロー", "再アタック", "担当者確認", "電話", "メール", "商談準備"].map((v) => `<option value="${esc(v)}">`).join("")}</datalist>
      <label style="margin-top:10px;">NEXTの日付</label>
      <input id="st-next-on" type="date" value="${esc(c.nextActionOn || "")}">
      <label style="margin-top:10px;">担当</label>
      <select id="st-owner"><option value="">（未定）</option>${(detail.members || []).map((m) =>
        `<option value="${esc(m.id)}" ${m.id === c.ownerId ? "selected" : ""}>${esc(m.display_name)}</option>`).join("")}</select>
      <label style="margin-top:10px;">キャンペーン</label>
      <select id="st-campaign"><option value="">（なし）</option>${(detail.campaigns || []).map((m) =>
        `<option value="${esc(m.id)}" ${m.id === c.campaignId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
      <div id="st-msg" class="err-text" style="margin:10px 0;"></div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn btn-primary" onclick="submitStatus(this)">保存する</button>
        <button class="btn btn-secondary" onclick="closeAction()">閉じる</button>
      </div>`);
}

async function submitStatus(btn) {
  const msg = el("st-msg"); msg.textContent = "";
  try {
    await KPLayout.busy(btn, "保存中…", () => API.updateSalesCompany({
      id: detail.company.id, status: el("st-status").value,
      nextAction: el("st-next").value.trim() || null, nextActionOn: el("st-next-on").value || null,
      ownerId: el("st-owner").value || null, campaignId: el("st-campaign").value || null,
    }));
    closeAction();
    await reloadDetail();
  } catch (e) { msg.textContent = errText(e, "保存できませんでした"); }
}

// ---- 基本情報を編集 ------------------------------------------------------------
function openEdit() {
  openActionModal(`
      <h2>基本情報を編集</h2>
      ${companyForm(detail.company)}
      <div id="c-msg" class="err-text" style="margin:10px 0;"></div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn btn-primary" onclick="submitEdit(this)">保存する</button>
        <button class="btn btn-secondary" onclick="closeAction()">閉じる</button>
      </div>`);
}

async function submitEdit(btn) {
  const msg = el("c-msg"); msg.textContent = "";
  const body = companyFields();
  if (!body.name) { msg.textContent = "企業名を入力してください"; return; }
  try {
    await KPLayout.busy(btn, "保存中…", () => API.updateSalesCompany({ id: detail.company.id, ...body }));
    closeAction();
    await reloadDetail();
  } catch (e) { msg.textContent = errText(e, "保存できませんでした"); }
}

// ---- 営業禁止（NG） -------------------------------------------------------------
function openNg() {
  const c = detail.company;
  if (c.ngReason) {
    if (!confirm("営業禁止を解除します。よろしいですか？")) return;
    API.updateSalesCompany({ id: c.id, ngReason: null, ngNote: null })
      .then(reloadDetail).catch((e) => alert(errText(e, "できませんでした")));
    return;
  }
  openActionModal(`
      <h2>営業禁止にする</h2>
      <p class="sl-sub" style="margin:0 0 12px;">営業禁止の企業には、誰もフォームアタックできなくなります。</p>
      <label>理由</label>
      <div>${(detail.ngReasons || []).map((r) => `
        <label class="sl-chip"><input type="radio" name="ng-reason" value="${esc(r.key)}">${esc(r.label)}</label>`).join("")}</div>
      <label style="margin-top:10px;">補足（任意）</label>
      <textarea id="ng-note" rows="3" placeholder="2026/09/27 先方より配信停止のご依頼"></textarea>
      <div id="ng-msg" class="err-text" style="margin:10px 0;"></div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn btn-primary" onclick="submitNg(this)">営業禁止にする</button>
        <button class="btn btn-secondary" onclick="closeAction()">閉じる</button>
      </div>`);
}

async function submitNg(btn) {
  const msg = el("ng-msg"); msg.textContent = "";
  const picked = document.querySelector('input[name="ng-reason"]:checked');
  if (!picked) { msg.textContent = "理由を選んでください"; return; }
  try {
    await KPLayout.busy(btn, "保存中…", () => API.updateSalesCompany({
      id: detail.company.id, ngReason: picked.value, ngNote: el("ng-note").value.trim() || null,
    }));
    closeAction();
    await reloadDetail();
  } catch (e) { msg.textContent = errText(e, "保存できませんでした"); }
}

async function copyText(id, btn) {
  const node = el(id);
  const val = node.value;
  try { await navigator.clipboard.writeText(val); } catch { /* 下で選択状態にする */ }
  node.select();
  if (btn) {
    const before = btn.innerHTML;
    btn.innerHTML = `<span class="material-symbols-outlined icon-inline">check</span>コピーしました`;
    setTimeout(() => { btn.innerHTML = before; }, 1600);
  }
}
