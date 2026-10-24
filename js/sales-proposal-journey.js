// 期間内に送信した提案の、その後の記録（読み取りのみ）。合格＝成約・稼働とは扱わない。
//
// ■ タブを開いた時点でグラフを出す（「グラフを表示」などの追加操作はない）
// ■ 状態を混ぜない：読込中／取得失敗（0件ではない）／未設定（DB・連携が無い）／取得済み0件
// ■ 一度読めたら、タブを離れて戻っても取り直さない（「更新」で取り直す）。失敗していたら戻ったときに取り直す
(function () {
  "use strict";
  let root, days = 30, sequence = 0, value = null, page = 0, stageFilter = null, failed = false, pending = false;
  const size = 20;
  const STAGES = [["sent","提案送信","送信日で対象を選んだ提案"],["adjusted","面談調整","調整の記録あり"],["scheduled","日程確定","確定の記録あり"],["held","面談実施","実施の記録あり"],["accepted","ENGER合格","受信できた合格の証拠のみ"],["won","Sales成約","合格とは別の記録"],["working","ENGER稼働","合格とは別の記録"]];
  const stageLabel = (key) => (STAGES.find((s) => s[0] === key) || [])[1] || "";
  // その段の記録がある提案か（提案送信は全件）。段は独立した記録なので、前の段を通ったかは見ない
  const hasStage = (r, key) => key === "sent" || Boolean(r[key + "At"] || r[key + "Evidence"]);
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
      <p class="pj-note">期間内に送信した提案が、その後どこまで進んだかを記録から追います。1提案は各段に1件まで。期間内に起きた面談・合格の件数ではありません。見られる範囲のENGER連携の提案（アーカイブ済みを除く）だけが対象で、提案一覧の検索・担当の絞り込みとは別です。</p>
      <div id="pj-content" aria-live="polite"></div>`;
    root.querySelector("#pj-days").addEventListener("change", (e) => { days = Number(e.target.value); load(); });
    root.querySelector("#pj-refresh").addEventListener("click", load);
    root.addEventListener("click", (e) => {
      const target = e.target && e.target.closest ? e.target : null;
      if (!target) return;
      const button = target.closest("button[data-pj-page]");
      if (button && root.contains(button) && value) { page += Number(button.dataset.pjPage); render(); return; }
      if (target.closest("[data-pj-retry]")) { load(); return; }
      if (target.closest("[data-pj-clear]")) { stageFilter = null; page = 0; render(); return; }
      const bar = target.closest("[data-chart-key]");
      if (bar && value) filterTo(bar.dataset.chartKey);
    });
  }
  async function load() {
    const current = ++sequence;
    value = null; page = 0; stageFilter = null; failed = false; pending = true;
    const content = root.querySelector("#pj-content");
    content.setAttribute("aria-busy", "true");
    content.setAttribute("data-state", "loading");
    content.innerHTML = '<p class="pj-note pj-state" data-state="loading">集計を読み込んでいます…（グラフはこのあと表示します）</p>';
    try {
      const result = await API.api(`/api/sales/proposals/journey?days=${days}`);
      if (current !== sequence) return;
      value = result; render();
    } catch (error) {
      if (current !== sequence) return;
      failed = true;
      // 未設定（503 not_ready）と、通信・集計の失敗を分ける。どちらも「0件」とは言わない
      const notReady = error?.code === "not_ready" || error?.status === 503;
      content.setAttribute("data-state", notReady ? "not-ready" : "error");
      content.innerHTML = notReady
        ? `<div class="pj-warning pj-state" role="status" data-state="not-ready"><strong>提案分析のデータがまだ用意されていません（未設定）。</strong>0件ではありません。${esc(error?.hint || error?.message || "")} <button type="button" data-pj-retry>再試行</button></div>`
        : `<div class="pj-warning pj-state" role="alert" data-state="error"><strong>集計を取得できませんでした。</strong>0件ではありません。${esc(error?.hint || error?.message || "")} <button type="button" data-pj-retry>再試行</button></div>`;
    } finally {
      if (current === sequence) { content.removeAttribute("aria-busy"); pending = false; }
    }
  }
  function filterTo(key) {
    if (!STAGES.some((s) => s[0] === key)) return;
    stageFilter = stageFilter === key ? null : key;
    page = 0;
    render({ openRecords: true });
    const records = root.querySelector(".pj-records");
    if (records && typeof records.scrollIntoView === "function") records.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  function render({ openRecords = false } = {}) {
    const expanded = openRecords || root.querySelector(".pj-records")?.open || false;
    const d = value, c = d.counts || {}, coverage = d.coverage || {};
    const allRows = Array.isArray(d.rows) ? d.rows : [];
    const rows = stageFilter ? allRows.filter((r) => hasStage(r, stageFilter)) : allRows;
    const charts = window.SalesCharts;
    const owners = Array.isArray(d.byCurrentOwner) ? d.byCurrentOwner : [];
    const b = d.bottlenecks || {};
    const companies = Array.isArray(d.byCompany) ? d.byCompany : [];
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(rows.length / size) - 1)));
    const truncated = Boolean(coverage.activityTruncated || coverage.proposalTruncated);
    const sent = Number(c.sent) || 0;
    const range = `${esc(date(d.since))} ～ ${esc(date(d.until))}`;
    // 比較表（担当者別・企業別）の上に必ず出す：対象期間・件数・記録不足
    const scope = `<p class="pj-note pj-scope">対象期間：${range}（送信日・JST） ／ 集計対象：期間内に送信した提案 ${esc(number(sent))}件 ／ 記録不足：合格の証拠が未確認 ${esc(number(coverage.acceptedUnknown))}件・面談実施の記録なし ${esc(number(Math.max(0, sent - (Number(c.held) || 0))))}件${truncated ? " ／ 取得上限に達したため一部のみ" : ""}</p>`;
    const chart = !sent
      ? `<p class="pj-state pj-empty" role="status" data-state="empty"><strong>取得できました：この期間に送信した提案は0件です。</strong>ENGER連携の提案だけを数えるため、連携が未設定のときも0件になります。期間を広げて確認してください。</p>`
      : charts.bars(STAGES.map(([key, label, sub]) => ({ key, label, value: Number(c[key]) || 0, unit: "件",
          sub: `${esc(sub)}${key === "accepted" && coverage.acceptedUnknown ? `・未確認 ${esc(number(coverage.acceptedUnknown))}件` : ""}`,
          tone: stageFilter === key ? "on" : null })), {
          id: "pj-chart", clickable: true, max: sent, actionLabel: "この段の記録がある提案を下の表に絞り込む",
          title: `期間内に送信した提案 ${number(sent)}件の、その後の記録`,
          caption: "棒の長さは「期間内に送信した提案」のうち、その段の記録が残っている件数です。各段は独立した記録で、前の段を通った件数ではありません。段と段の割合（面談→合格率など）は出さず、ENGER合格・Sales成約・ENGER稼働は別々の事実として扱います。棒を押すと、その段の記録がある提案だけを下の表に出します。" });
    const evidenceDate = (at, evidence) => at ? date(at) : evidence ? "証拠あり・日付未確認" : "未確認";
    root.querySelector("#pj-content").setAttribute("data-state", sent ? "ready" : "empty");
    root.querySelector("#pj-content").innerHTML = `
      <p class="pj-note">対象送信日：${range}（JST） ／ 集計時点：${esc(d.until ? new Date(d.until).toLocaleString("ja-JP", { timeZone:"Asia/Tokyo" }) : "—")}（JST）</p>
      <div class="pj-chart-area" data-state="${sent ? "ready" : "empty"}">${chart}</div>
      <div class="pj-warning pj-note"><strong>合格は成約・稼働と別です。</strong> ENGER合格は、Salesが受け取れた証拠だけの参考件数（確認できた最小の件数）です。未連携・過去の履歴欠落は補完していません。未確認を不合格や0件とみなさず、合格率は算出しません。合格の証拠が未確認：${esc(number(coverage.acceptedUnknown))}件。
      ${coverage.activityTruncated || coverage.proposalTruncated ? "<br><strong>取得上限に達した参考集計です。全件の数値ではありません。</strong>" : ""}${d.notice ? `<br>${esc(d.notice)}` : ""}</div>
      <p class="pj-note">提案→面談実施：${esc(number(d.rates?.heldFromSent))}${Number.isFinite(d.rates?.heldFromSent) ? "%" : ""} ／ 面談→合格：—（合格履歴の網羅性未確認）。段の飛び越しや記録不足があるため、後段から前段の到達を推測しません。</p>
      <div class="pj-note"><strong>記録上の待ち状況</strong>：面談の実施記録がない進行中 ${esc(number(b.awaitingHeld))}件（送信からの経過日数中央値 ${esc(number(b.awaitingHeldMedianDays))}日） ／ 実施記録あり・合格証拠未確認 ${esc(number(b.awaitingAcceptedEvidence))}件。<br>提案送信→初回面談実施記録の中央値 ${esc(number(b.heldMedianDays))}日（暦日・計測${esc(number(b.heldMeasured))}件）。未確認は失敗や実際の停滞を意味しません。</div>
      <details class="pj-owner"><summary>担当者別（期間内に送信した提案）</summary>
        ${scope}
        <p class="pj-note">いまの担当者で分けています。実際に操作した人の成果評価ではなく、担当を変えると件数の帰属も変わります。合格を担当者別に評価することはできません。合格は受け取れた証拠の最小件数で、未確認は不合格ではありません。提案10件未満は参考値です。</p>
        <div class="pj-evidence" tabindex="0" aria-label="現在担当ごとの参考集計（横スクロール可）"><table class="sl-table"><thead><tr><th>現在担当</th><th>提案送信</th><th>面談実施記録</th><th>提案→面談実施</th><th>実施まで中央値</th><th>合格証拠</th><th>合格未確認</th></tr></thead><tbody>${owners.map((r) => `<tr><td>${esc(r.ownerName || "担当未割当")}${r.sent < 10 ? "（参考）" : ""}${identity("担当ID", r.ownerId)}</td><td>${esc(number(r.sent))}</td><td>${esc(number(r.held))}</td><td>${esc(number(r.heldRate))}${Number.isFinite(r.heldRate) ? "%" : ""}</td><td>${esc(number(r.heldMedianDays))}日（${esc(number(r.heldMeasured))}件）</td><td>${esc(number(r.accepted))}</td><td>${esc(number(r.acceptedUnknown))}</td></tr>`).join("") || '<tr><td colspan="7">対象の提案はありません。</td></tr>'}</tbody></table></div>
      </details>
      <details class="pj-companies"><summary>企業別・記録された見送り理由（真因未検証）</summary>
        ${scope}
        <p class="pj-note">「見送り」は現在のSales状態が見送りの提案だけです。連絡停止・無回答クローズを不合格に含めません。理由は既存の見送りカテゴリーで、不合格専用の理由はありません。登録内容の集計であり、本当の理由（真因）を検証した結果ではありません。相手が説明した理由・確認できた事実・担当者の仮説を、現データでは区分できません。補足は入力された文章をそのまま表示し、相手の発言の原文や事実だとは断定しません。会社や担当者の良し悪しを自動判定するものではありません。提案10件未満は参考値、合格未確認は不合格ではありません。</p>
        <p class="pj-note">企業IDまたはENGER企業IDで分類しています。IDなしは同じ社名でもまとめず、提案ごとの別グループです。</p>
        <p class="pj-note">情報取得状態と失注理由は別です。「まだ聞いてない」「答えなし」「具体性なし」は理由分布に含めません。「具体的説明あり」も真因は未検証です。従来の未区分を自動で未取得や具体的説明ありに分類しません。</p>
        <p class="pj-note"><strong>次の確認の目安（自動実行なし）</strong>：まだ聞いてない → 理由を聞く確認 ／ 答えなし → 再確認可否の検討 ／ 具体性なし → 具体例・条件の確認。連絡停止等を尊重し、担当者が判断してください。根拠提案の「メモ」で取得状態だけ追記できます。</p>
        <div class="pj-evidence" tabindex="0" aria-label="企業別の登録された見送り理由・真因未検証（横スクロール可）"><table class="sl-table"><thead><tr><th>企業</th><th>提案</th><th>面談実施</th><th>合格証拠</th><th>合格未確認</th><th>見送り</th><th>登録理由の分布（真因未検証）</th><th>情報取得状態（理由とは別）</th></tr></thead><tbody>${companies.map((r) => `<tr><td>${esc(r.companyName || "企業名未登録")}${r.sent < 10 ? "（参考）" : ""}${r.identityMissing ? "<br>企業IDなし・名寄せ未実施" : ""}${identity(r.identityMissing ? "提案別集計キー" : "企業集計キー", r.companyKey)}</td><td>${esc(number(r.sent))}</td><td>${esc(number(r.held))}</td><td>${esc(number(r.accepted))}</td><td>${esc(number(r.acceptedUnknown))}</td><td>${esc(number(r.lost))}</td><td>${(Array.isArray(r.reasons) ? r.reasons : []).map((reason) => `${esc(reason.label || reason.code || "理由不明")}：${esc(number(reason.count))}件`).join("<br>") || "—"}${r.unknownReason ? `<br>理由未入力：${esc(number(r.unknownReason))}件` : ""}</td><td>${Object.entries(collectionLabels).map(([key,label]) => `${esc(label)}：${esc(number(r.collectionCounts?.[key]))}件`).join("<br>")}</td></tr>`).join("") || '<tr><td colspan="8">対象の提案はありません。</td></tr>'}</tbody></table></div>
      </details>
      <details class="pj-records"${expanded ? " open" : ""}><summary>根拠の提案を見る（${stageFilter ? `${esc(stageLabel(stageFilter))}の記録がある ${esc(number(rows.length))}件 / 全${esc(number(allRows.length))}件` : `${esc(number(rows.length))}件`}）</summary>
        ${stageFilter ? `<p class="pj-filter" role="status">絞り込み中：<strong>${esc(stageLabel(stageFilter))}</strong>の記録がある提案（${esc(number(rows.length))}件） <button type="button" data-pj-clear>絞り込みを解除</button></p>` : ""}
        <p class="pj-note">「未確認」は到達していないという意味ではありません。面談の中止・再調整後も、以前の到達記録がある段は残ります。合格欄の日付はENGERで合格を記録した日時です。日付が不明な証拠は、同期日時で代用しません。企業・提案名から同じ提案の詳細を開けます。合格の確定は正本のENGERで行ってください。</p>
        <div class="pj-evidence" tabindex="0" aria-label="提案ごとの到達記録（横スクロール可）"><table class="sl-table"><thead><tr><th>企業・提案</th><th>提案送信</th><th>面談調整</th><th>日程確定</th><th>面談実施</th><th>ENGER合格記録</th><th>Sales成約</th><th>ENGER稼働</th><th>登録理由・補足（真因未検証）</th></tr></thead><tbody>
        ${rows.slice(page * size, (page + 1) * size).map((r) => `<tr><td><a href="proposals.html?id=${encodeURIComponent(r.id)}">${esc(r.companyName)}<br>${esc(r.title)}</a>${identity("提案ID", r.id)}${identity("企業集計キー", r.companyKey)}${esc(r.ownerName || "担当未登録・不明")}${identity("現在担当ID", r.ownerId)}</td><td>${esc(date(r.sentAt))}</td><td>${esc(evidenceDate(r.adjustedAt, r.adjustedEvidence))}</td><td>${esc(evidenceDate(r.scheduledAt, r.scheduledEvidence))}</td><td>${esc(evidenceDate(r.heldAt, r.heldEvidence))}</td><td>${esc(evidenceDate(r.acceptedAt, r.acceptedEvidence))}</td><td>${esc(evidenceDate(r.wonAt, r.wonEvidence))}</td><td>${esc(evidenceDate(r.workingAt, r.workingEvidence))}</td><td>${esc(r.lost && (incompleteCollection(r.reasonCollectionStatus) || r.reasonCategoryUnrecorded) ? "理由カテゴリー未記録（互換保存のその他は分類しません）" : r.closeReasonLabel || r.closeReason || "—")}<br>${esc(r.lost ? (r.reasonCollectionLabel || collectionLabel(r.reasonCollectionStatus)) : "—（情報取得状態の対象外）")}${r.closeNote ? `<br>${esc(r.closeNote)}` : ""}</td></tr>`).join("") || `<tr><td colspan="9">${stageFilter ? "この段の記録がある提案はありません。" : "この送信期間の提案はありません。"}</td></tr>`}
        </tbody></table></div><div class="pj-pages"><button type="button" data-pj-page="-1"${page === 0 ? " disabled" : ""}>前へ</button><span>${page + 1} / ${Math.max(1,Math.ceil(rows.length / size))}</span><button type="button" data-pj-page="1"${(page + 1) * size >= rows.length ? " disabled" : ""}>次へ</button></div>
      </details>`;
  }
  window.SalesProposalJourney = { show() {
    if (!root) { root = document.getElementById("proposal-journey"); if (!root) return; shell(); }
    // 読めている・読込中なら取り直さない（タブの行き来でグラフを作り直さない）。失敗していたら取り直す
    if (pending || (value && !failed)) return;
    load();
  } };
})();
