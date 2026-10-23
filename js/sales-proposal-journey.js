// Read-only proposal-send cohorts. No writes, no inferred pass/contract equivalence.
(function () {
  "use strict";
  let root, days = 30, sequence = 0, value = null, page = 0;
  const size = 20;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const collectionLabels = { not_asked:"まだ聞いてない", no_answer:"聞いたけど答えなし", vague:"説明はあるが具体性なし", specific:"具体的説明あり（真因未検証）", unclassified:"未区分（従来記録）" };
  const incompleteCollection = (s) => ["not_asked", "no_answer", "vague"].includes(s);
  const collectionLabel = (s) => collectionLabels[s] || collectionLabels.unclassified;
  const number = (n) => Number.isFinite(n) ? n.toLocaleString("ja-JP") : "—";
  // Full stable IDs: abbreviated IDs can collide and same display names are not identities.
  const identity = (label, id) => `<small class="pj-note" style="display:block;overflow-wrap:anywhere">${label}：${esc(id || "未登録")}</small>`;
  const date = (s) => {
    if (!s || !Number.isFinite(Date.parse(s))) return "—";
    return new Intl.DateTimeFormat("ja-JP", { timeZone:"Asia/Tokyo", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date(s));
  };
  function shell() {
    root.innerHTML = `<div class="pj-head"><h2 class="sl-sec-h">提案から面談・合格まで</h2><div><label>提案送信の期間 <select id="pj-days">${[1,7,30,90,365].map((d) => `<option value="${d}"${days === d ? " selected" : ""}>直近${d}日</option>`).join("")}</select></label> <button type="button" id="pj-refresh">更新</button></div></div>
      <p class="pj-note">期間内に送信した提案を、その後どこまで進んだか追跡します（送信日コホート）。各段は1提案1件。期間内に起きた面談・合格の件数ではありません。閲覧権限内のENGER連携・非アーカイブ提案のみが対象で、提案一覧の検索・担当フィルタとは独立しています。</p>
      <div id="pj-content" aria-live="polite"></div>`;
    root.querySelector("#pj-days").addEventListener("change", (e) => { days = Number(e.target.value); load(); });
    root.querySelector("#pj-refresh").addEventListener("click", load);
    root.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-pj-page]");
      if (button && root.contains(button) && value) { page += Number(button.dataset.pjPage); render(); }
    });
  }
  async function load() {
    const current = ++sequence;
    value = null; page = 0;
    const content = root.querySelector("#pj-content");
    content.setAttribute("aria-busy", "true");
    content.innerHTML = '<p class="pj-note">集計を読み込んでいます…</p>';
    try {
      const result = await API.api(`/api/sales/proposals/journey?days=${days}`);
      if (current !== sequence) return;
      value = result; render();
    } catch (error) {
      if (current !== sequence) return;
      content.innerHTML = `<p class="pj-warning" role="alert">集計を取得できませんでした。0件ではありません。上の「更新」で再試行してください。${esc(error?.hint || error?.message || "")}</p>`;
    } finally {
      if (current === sequence) content.removeAttribute("aria-busy");
    }
  }
  function render() {
    const expanded = root.querySelector(".pj-records")?.open || false;
    const d = value, c = d.counts || {}, coverage = d.coverage || {};
    const rows = Array.isArray(d.rows) ? d.rows : [];
    const owners = Array.isArray(d.byCurrentOwner) ? d.byCurrentOwner : [];
    const b = d.bottlenecks || {};
    const companies = Array.isArray(d.byCompany) ? d.byCompany : [];
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(rows.length / size) - 1)));
    const tiles = [["sent","提案送信","送信日で対象を選択"],["adjusted","面談調整","調整の記録あり"],["scheduled","日程確定","確定の記録あり"],["held","面談実施","実施の記録あり"],["accepted","ENGER合格","受信済みの証拠のみ"],["won","Sales成約","合格とは別の記録"],["working","ENGER稼働","合格とは別の記録"]];
    const evidenceDate = (at, evidence) => at ? date(at) : evidence ? "証拠あり・日付未確認" : "未確認";
    root.querySelector("#pj-content").innerHTML = `
      <p class="pj-note">対象送信日：${esc(date(d.since))} ～ ${esc(date(d.until))}（JST） ／ 集計時点：${esc(d.until ? new Date(d.until).toLocaleString("ja-JP", { timeZone:"Asia/Tokyo" }) : "—")}（JST）</p>
      <div class="pj-warning pj-note"><strong>合格は成約・稼働と別です。</strong> ENGER合格はSalesが受信できた証拠だけの参考件数です。未連携・過去の履歴欠落は補完していません。未確認を不合格や0件とみなさず、合格率は算出しません。合格の証拠が未確認：${esc(number(coverage.acceptedUnknown))}件。
      ${coverage.activityTruncated || coverage.proposalTruncated ? "<br><strong>取得上限に達した参考集計です。全件の数値ではありません。</strong>" : ""}${d.notice ? `<br>${esc(d.notice)}` : ""}</div>
      <div class="pj-cards">${tiles.map(([key,label,sub]) => `<div class="pj-card"><span>${label}</span><strong>${esc(number(c[key]))}<small style="display:inline;font-size:12px"> 件</small></strong><small>${sub}</small></div>`).join("")}</div>
      <p class="pj-note">提案→面談実施：${esc(number(d.rates?.heldFromSent))}${Number.isFinite(d.rates?.heldFromSent) ? "%" : ""} ／ 面談→合格：—（合格履歴の網羅性未確認）。段の飛び越しや記録不足があるため、後段から前段の到達を推測しません。</p>
      <div class="pj-note"><strong>記録上の待ち状況</strong>：面談の実施記録がない進行中 ${esc(number(b.awaitingHeld))}件（送信からの経過日数中央値 ${esc(number(b.awaitingHeldMedianDays))}日） ／ 実施記録あり・合格証拠未確認 ${esc(number(b.awaitingAcceptedEvidence))}件。<br>提案送信→初回面談実施記録の中央値 ${esc(number(b.heldMedianDays))}日（暦日・計測${esc(number(b.heldMeasured))}件）。未確認は失敗や実際の停滞を意味しません。</div>
      <details class="pj-owner"><summary>現在担当ごとの提案コホート</summary>
        <p class="pj-note">現在の担当者で分類しています。行動の実施者の成果評価ではなく、担当変更で件数の帰属も変わります。合格の実施者別評価はできません。合格は受信済み証拠の下限件数で、未確認は不合格ではありません。提案10件未満は参考値です。</p>
        <div class="pj-evidence" tabindex="0" aria-label="現在担当ごとの参考集計（横スクロール可）"><table class="sl-table"><thead><tr><th>現在担当</th><th>提案送信</th><th>面談実施記録</th><th>提案→面談実施</th><th>実施まで中央値</th><th>合格証拠</th><th>合格未確認</th></tr></thead><tbody>${owners.map((r) => `<tr><td>${esc(r.ownerName || "担当未割当")}${r.sent < 10 ? "（参考）" : ""}${identity("担当ID", r.ownerId)}</td><td>${esc(number(r.sent))}</td><td>${esc(number(r.held))}</td><td>${esc(number(r.heldRate))}${Number.isFinite(r.heldRate) ? "%" : ""}</td><td>${esc(number(r.heldMedianDays))}日（${esc(number(r.heldMeasured))}件）</td><td>${esc(number(r.accepted))}</td><td>${esc(number(r.acceptedUnknown))}</td></tr>`).join("") || '<tr><td colspan="7">対象の提案はありません。</td></tr>'}</tbody></table></div>
      </details>
      <details class="pj-companies"><summary>企業別・記録された見送り理由（真因未検証）</summary>
        <p class="pj-note">「見送り」は現在のSales状態が見送りの提案だけです。連絡停止・無回答クローズを不合格に含めません。理由は既存の見送りカテゴリーで、不合格専用の理由はありません。登録内容の集計であり、本当の理由（真因）を検証した結果ではありません。相手が説明した理由・確認できた事実・担当者の仮説を、現データでは区分できません。補足は入力された文章をそのまま表示し、相手の発言の原文や事実だとは断定しません。会社や担当者の良し悪しを自動判定するものではありません。提案10件未満は参考値、合格未確認は不合格ではありません。</p>
        <p class="pj-note">企業IDまたはENGER企業IDで分類しています。IDなしは同じ社名でもまとめず、提案ごとの別グループです。</p>
        <p class="pj-note">情報取得状態と失注理由は別です。「まだ聞いてない」「答えなし」「具体性なし」は理由分布に含めません。「具体的説明あり」も真因は未検証です。従来の未区分を自動で未取得や具体的説明ありに分類しません。</p>
        <p class="pj-note"><strong>次の確認の目安（自動実行なし）</strong>：まだ聞いてない → 理由を聞く確認 ／ 答えなし → 再確認可否の検討 ／ 具体性なし → 具体例・条件の確認。連絡停止等を尊重し、担当者が判断してください。根拠提案の「メモ」で取得状態だけ追記できます。</p>
        <div class="pj-evidence" tabindex="0" aria-label="企業別の登録された見送り理由・真因未検証（横スクロール可）"><table class="sl-table"><thead><tr><th>企業</th><th>提案</th><th>面談実施</th><th>合格証拠</th><th>合格未確認</th><th>見送り</th><th>登録理由の分布（真因未検証）</th><th>情報取得状態（理由とは別）</th></tr></thead><tbody>${companies.map((r) => `<tr><td>${esc(r.companyName || "企業名未登録")}${r.sent < 10 ? "（参考）" : ""}${r.identityMissing ? "<br>企業IDなし・名寄せ未実施" : ""}${identity(r.identityMissing ? "提案別集計キー" : "企業集計キー", r.companyKey)}</td><td>${esc(number(r.sent))}</td><td>${esc(number(r.held))}</td><td>${esc(number(r.accepted))}</td><td>${esc(number(r.acceptedUnknown))}</td><td>${esc(number(r.lost))}</td><td>${(Array.isArray(r.reasons) ? r.reasons : []).map((reason) => `${esc(reason.label || reason.code || "理由不明")}：${esc(number(reason.count))}件`).join("<br>") || "—"}${r.unknownReason ? `<br>理由未入力：${esc(number(r.unknownReason))}件` : ""}</td><td>${Object.entries(collectionLabels).map(([key,label]) => `${esc(label)}：${esc(number(r.collectionCounts?.[key]))}件`).join("<br>")}</td></tr>`).join("") || '<tr><td colspan="8">対象の提案はありません。</td></tr>'}</tbody></table></div>
      </details>
      <details class="pj-records"${expanded ? " open" : ""}><summary>根拠の提案を見る（${esc(number(rows.length))}件）</summary>
        <p class="pj-note">「未確認」は到達していないという意味ではありません。面談の中止・再調整後も、以前の到達記録がある段は残ります。合格欄の日付はENGERで合格を記録した日時です。日付が不明な証拠は、同期日時で代用しません。企業・提案名から同じ提案の詳細を開けます。合格の確定は正本のENGERで行ってください。</p>
        <div class="pj-evidence" tabindex="0" aria-label="提案ごとの到達記録（横スクロール可）"><table class="sl-table"><thead><tr><th>企業・提案</th><th>提案送信</th><th>面談調整</th><th>日程確定</th><th>面談実施</th><th>ENGER合格記録</th><th>Sales成約</th><th>ENGER稼働</th><th>登録理由・補足（真因未検証）</th></tr></thead><tbody>
        ${rows.slice(page * size, (page + 1) * size).map((r) => `<tr><td><a href="proposals.html?id=${encodeURIComponent(r.id)}">${esc(r.companyName)}<br>${esc(r.title)}</a>${identity("提案ID", r.id)}${identity("企業集計キー", r.companyKey)}${esc(r.ownerName || "担当未登録・不明")}${identity("現在担当ID", r.ownerId)}</td><td>${esc(date(r.sentAt))}</td><td>${esc(evidenceDate(r.adjustedAt, r.adjustedEvidence))}</td><td>${esc(evidenceDate(r.scheduledAt, r.scheduledEvidence))}</td><td>${esc(evidenceDate(r.heldAt, r.heldEvidence))}</td><td>${esc(evidenceDate(r.acceptedAt, r.acceptedEvidence))}</td><td>${esc(evidenceDate(r.wonAt, r.wonEvidence))}</td><td>${esc(evidenceDate(r.workingAt, r.workingEvidence))}</td><td>${esc(r.lost && (incompleteCollection(r.reasonCollectionStatus) || r.reasonCategoryUnrecorded) ? "理由カテゴリー未記録（互換保存のその他は分類しません）" : r.closeReasonLabel || r.closeReason || "—")}<br>${esc(r.lost ? (r.reasonCollectionLabel || collectionLabel(r.reasonCollectionStatus)) : "—（情報取得状態の対象外）")}${r.closeNote ? `<br>${esc(r.closeNote)}` : ""}</td></tr>`).join("") || '<tr><td colspan="9">この送信期間の提案はありません。</td></tr>'}
        </tbody></table></div><div class="pj-pages"><button type="button" data-pj-page="-1"${page === 0 ? " disabled" : ""}>前へ</button><span>${page + 1} / ${Math.max(1,Math.ceil(rows.length / size))}</span><button type="button" data-pj-page="1"${(page + 1) * size >= rows.length ? " disabled" : ""}>次へ</button></div>
      </details>`;
  }
  window.SalesProposalJourney = { show() {
    if (!root) { root = document.getElementById("proposal-journey"); if (!root) return; shell(); }
    load();
  } };
})();
