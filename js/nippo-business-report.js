// 日報に埋め込むSales・ENGER横断集計。画面に個人日報本文は取得しない。
(function () {
  "use strict";
  const el = (id) => document.getElementById(id);
  const esc = (value) => window.KPLayout?.esc ? window.KPLayout.esc(String(value ?? "")) : String(value ?? "");
  let period = "day";
  let report = null;
  let loading = false;
  let requestId = 0;

  function number(value, suffix) {
    if (value == null) return "未取得";
    return Number(value).toLocaleString("ja-JP") + (suffix == null ? "件" : suffix);
  }
  function percent(value) {
    return value == null ? "未取得" : Number(value).toFixed(1) + "%";
  }
  function rateText(value, denominator, emptyLabel) {
    if (value != null) return percent(value);
    if (denominator === 0) return "—（" + emptyLabel + "）";
    return "未取得";
  }
  function dateLabel(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value)
      : date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function compare(current, previous, suffix) {
    if (current == null || previous == null) return "前期間比: 未取得";
    const delta = current - previous;
    if (!delta) return "前期間比 ±0" + (suffix || "件");
    return "前期間比 " + (delta > 0 ? "+" : "−") + Math.abs(delta).toLocaleString("ja-JP") + (suffix || "件");
  }
  function rateCompare(current, previous, currentBase, previousBase) {
    if (current == null && previous == null && currentBase === 0 && previousBase === 0) return "比較対象なし";
    if (current == null || previous == null) return "前期間比: 未取得";
    const delta = current - previous;
    return "前期間比 " + (delta > 0 ? "+" : "") + delta.toFixed(1) + "pt";
  }
  function proposalUrl(id) {
    return "/sales/proposals.html?id=" + encodeURIComponent(id);
  }
  function safeSourceUrl(value) {
    try {
      const url = new URL(value, location.origin);
      return url.protocol === "https:" ? url.href : null;
    } catch (_) { return null; }
  }
  function table(title, rows, columns, id, total) {
    if (rows == null) {
      return '<section class="br-card" id="' + id + '"><h3>' + esc(title) + '</h3><p class="br-note">未取得（元データを確認できません）</p></section>';
    }
    const body = rows.length ? rows.map((row) => {
      const cells = columns.map((column) => {
        const raw = column.value(row);
        if (column.url) {
          const source = safeSourceUrl(raw);
          return '<td>' + (source ? '<a href="' + esc(source) + '" target="_blank" rel="noopener">ENGER</a>' : "—") + '</td>';
        }
        if (column.link && row.id) {
          return '<td><a href="' + proposalUrl(row.id) + '">' + esc(raw || "Salesで確認") + '</a></td>';
        }
        return '<td>' + esc(raw == null || raw === "" ? "—" : raw) + '</td>';
      }).join("");
      return "<tr>" + cells + "</tr>";
    }).join("") : '<tr><td colspan="8" class="muted">対象期間の記録はありません。</td></tr>';
    const count = total == null ? rows.length : total;
    const clipped = count > rows.length
      ? '<p class="br-note">先頭' + rows.length + "件を表示（全" + count + "件）。詳細はSalesで確認してください。</p>" : "";
    return '<section class="br-card" id="' + id + '"><h3>' + esc(title) + ' <span class="br-badge">' + count + '件</span></h3>' + clipped
      + '<div class="br-table-wrap"><table class="br-table"><thead><tr>'
      + columns.map((column) => "<th>" + esc(column.label) + "</th>").join("")
      + "</tr></thead><tbody>" + body + "</tbody></table></div></section>";
  }
  function kpi(label, value, comparison, note, anchor) {
    return '<div class="br-kpi"><a href="' + anchor + '"><div class="br-label">' + esc(label)
      + '</div><div class="br-value">' + value + '</div><div class="br-compare">' + esc(comparison)
      + (note || "") + "</div></a></div>";
  }
  function render(data) {
    const sales = data.sales || {};
    const matching = data.matching || {};
    const current = sales.current || {};
    const previous = sales.previous || {};
    const matchNow = matching.current || {};
    const matchPrevious = matching.previous || {};
    const reasons = current.lossReasons || [];
    const owners = sales.byOwner || [];
    const actions = data.insights || [];
    const coverage = data.coverage || {};
    const messages = [];
    if (coverage.notice) messages.push(coverage.notice);
    if (coverage.employees === "unavailable") messages.push("社員名簿を取得できず、担当者名が提案記録上の表示名または未取得になる可能性があります。");
    if (sales.status === "partial") messages.push("Sales活動記録の一部が未取得のため、面談・担当別・企業判定を未取得として表示する場合があります。");
    if (sales.status === "unavailable") messages.push("Sales提案データを取得できません。提案数などは未取得です。");
    if (matching.status === "unavailable") messages.push("ENGER連携データを確認できないため、マッチング指標は未取得です。");
    if (matching.status === "partial") messages.push("ENGER同期・期限情報の一部が未取得です。表示できるマッチング指標は部分データの可能性があります。");
    if (sales.sourceStateStatus === "not_enabled") messages.push("ENGER側の削除・変更状態を取り込む設定が無効です。Salesに残る同期済み記録を集計しています。");
    else if (sales.sourceStateStatus === "unavailable" || sales.sourceStateStatus === "partial") messages.push("ENGER側の削除・変更状態をすべて確認できていません。");
    if (matching.sync?.status === "available" && matching.sync.latestReceivedAt) {
      messages.push("ENGER連携の最終記録: " + dateLabel(matching.sync.latestReceivedAt) + "／未解決エラー: " + number(matching.sync.unresolvedCount));
    }
    if (current.proposalCount > 0 && current.proposalCount < 10) messages.push("提案件数が10件未満のため、10%目標との比較は参考値です。");
    const coverageHtml = messages.length
      ? '<div class="br-coverage">' + messages.map((message) => "<div>・" + esc(message) + "</div>").join("") + "</div>" : "";
    const period = data.period || {};
    const currentPeriod = period.current || {};
    el("br-period-label").textContent = (currentPeriod.label || "対象期間") + "（" + (period.description || "") + "）";

    const kpis = '<div class="br-kpis">'
      + kpi("送信済み提案", number(current.proposalCount), compare(current.proposalCount, previous.proposalCount), "", "#br-proposals")
      + kpi("面談実施", number(current.meetingEventCount), compare(current.meetingEventCount, previous.meetingEventCount), "", "#br-meetings")
      + kpi("提案→面談率", rateText(current.conversionRate, current.proposalCount, "提案なし"), rateCompare(current.conversionRate, previous.conversionRate, current.proposalCount, previous.proposalCount), "<br>目標 10%", "#br-proposals")
      + kpi("失注・クローズ", number(current.closedCount), compare(current.closedCount, previous.closedCount), "", "#br-losses")
      + kpi("ENGERマッチング", number(matchNow.matchedCount), compare(matchNow.matchedCount, matchPrevious.matchedCount), "", "#br-matches")
      + kpi("マッチング→提案化", rateText(matchNow.conversionRate, matchNow.matchedCount, "マッチングなし"), rateCompare(matchNow.conversionRate, matchPrevious.conversionRate, matchNow.matchedCount, matchPrevious.matchedCount)
        + "／提案化 " + number(matchNow.proposalizedCount) + " / " + number(matchNow.matchedCount), "", "#br-matches")
      + kpi("提案準備の滞留", number(matching.stalledCount), "未送信の提案待ち " + number(matching.backlogCount), "", "#br-stalled")
      + kpi("ブラスト限定候補", number(sales.blasts?.count), "全履歴で15件以上・面談0件", "", "#br-blasts")
      + "</div>";
    const reasonBody = reasons.length
      ? '<div class="br-table-wrap"><table class="br-table"><thead><tr><th>失注理由</th><th>件数</th></tr></thead><tbody>'
        + reasons.map((row) => "<tr><td><a href=\"#br-losses\">" + esc(row.label) + "</a></td><td>" + row.count + "</td></tr>").join("")
        + "</tbody></table></div>"
      : current.lossReasons == null ? '<p class="br-note">未取得</p>' : '<p class="br-note">対象期間の失注記録はありません。</p>';
    const ownerBody = sales.ownerStatus === "unavailable"
      ? '<p class="br-note">担当者別の実績は未取得です。</p>'
      : owners.length
        ? '<div class="br-table-wrap"><table class="br-table"><thead><tr><th>担当</th><th>提案</th><th>面談</th><th>提案→面談</th><th>マッチング</th><th>期限超過</th><th>ボトルネック</th></tr></thead><tbody>'
          + owners.map((owner) => {
            const exampleId = owner.proposalExampleId || owner.matchingExampleId;
            const name = exampleId ? '<a href="' + proposalUrl(exampleId) + '">' + esc(owner.name) + "</a>" : esc(owner.name);
            return "<tr><td>" + name + "</td><td>" + owner.proposalCount + "</td><td>" + owner.meetingCount
            + "</td><td>" + rateText(owner.conversionRate, owner.proposalCount, "提案なし") + "</td><td>" + owner.matchCount + "</td><td>" + owner.overdueMatches
            + "</td><td>" + (owner.bottleneck ? '<span class="br-badge bad">要確認</span>' : "—") + "</td></tr>";
          }).join("")
          + "</tbody></table></div>"
        : '<p class="br-note">対象期間の担当実績はありません。</p>';
    const actionHtml = actions.length
      ? actions.map((action) => '<article class="br-action ' + (action.severity === "urgent" ? "urgent" : "") + '"><strong>'
        + esc(action.issue) + "</strong><p>原因: " + esc(action.cause) + "</p><p>改善: " + esc(action.action)
        + "</p><p>担当: <b>" + esc(action.owner || "未割当") + "</b>　期限: <b>" + esc(action.dueDate || "未設定") + "</b></p></article>").join("")
      : '<p class="br-note">取得済みの指標に、今日追加する改善アクションはありません。</p>';
    const rules = '<section class="br-card"><h3>集計ルール</h3>'
      + '<p class="br-note">提案数は送信日ベース。面談率は期間内に送った提案のうち、面談完了まで進んだ件数÷提案数。面談実施数は実施日ベースです。</p>'
      + '<p class="br-note">ブラスト限定は全履歴で15件以上を送信し、面談実施が0件の企業。候補表示のみで、配信・連絡停止は自動実行しません。</p>'
      + '<p class="br-note">マッチングはENGERからSalesに同期された記録です。滞留は「提案準備」タスクの期限超過で判定しています。滞留・ブラスト候補は現在の状態で、過去時点の状態履歴が無いため前期間比較はできません。</p></section>';
    const proposalRows = table("期間内の提案（クリックでSalesを開く）", current.proposalRows, [
      { label: "送信日", value: (row) => dateLabel(row.sentAt) },
      { label: "企業・案件", value: (row) => row.companyName + " / " + row.title, link: true },
      { label: "提案担当", value: (row) => row.ownerName },
      { label: "面談完了", value: (row) => row.meetingCompleted == null ? "未取得" : row.meetingCompleted ? "はい" : "いいえ" },
    ], "br-proposals", current.proposalRowsTotal);
    const meetingRows = table("期間内の面談実施", current.meetingRows, [
      { label: "実施日時", value: (row) => dateLabel(row.occurredAt) },
      { label: "企業・案件", value: (row) => row.companyName + " / " + row.title, link: true },
      { label: "担当", value: (row) => row.ownerName },
    ], "br-meetings", current.meetingRowsTotal);
    const lossRows = table("期間内の失注・クローズ", current.lossRows, [
      { label: "日付", value: (row) => dateLabel(row.closedAt) },
      { label: "企業・案件", value: (row) => row.companyName + " / " + row.title, link: true },
      { label: "担当", value: (row) => row.ownerName },
      { label: "理由", value: (row) => row.reasonLabel },
    ], "br-losses", current.lossRowsTotal);
    const matchRows = table("期間内のENGERマッチング", matchNow.rows, [
      { label: "マッチング日", value: (row) => dateLabel(row.matchedAt) },
      { label: "企業・案件", value: (row) => row.companyName + " / " + row.title, link: true },
      { label: "マッチング担当", value: (row) => row.matchingOwnerName },
      { label: "提案化", value: (row) => row.sentAt ? "済 " + dateLabel(row.sentAt) : "未" },
      { label: "ENGER", value: (row) => row.sourceUrl, url: true },
    ], "br-matches", matchNow.rowsTotal);
    const stalledRows = table("提案準備の期限超過", matching.stalledRows, [
      { label: "期限", value: (row) => dateLabel(row.taskDueAt) },
      { label: "企業・案件", value: (row) => row.companyName + " / " + row.title, link: true },
      { label: "担当", value: (row) => row.ownerName },
      { label: "マッチング日", value: (row) => dateLabel(row.matchedAt) },
    ], "br-stalled", matching.stalledRowsTotal);
    const blasts = table("全履歴ブラスト限定候補", sales.blasts?.rows, [
      { label: "企業", value: (row) => row.companyName, link: true },
      { label: "送信提案", value: (row) => row.proposalCount },
      { label: "面談", value: (row) => row.meetingCount },
      { label: "最終提案", value: (row) => dateLabel(row.lastSentAt) },
      { label: "連絡停止", value: (row) => row.stopContact ? "設定済み・要確認" : "未設定" },
    ], "br-blasts", sales.blasts?.rowsTotal);
    const backlog = table("ENGERマッチング後・提案待ち", matching.backlogRows, [
      { label: "マッチング日", value: (row) => dateLabel(row.matchedAt) },
      { label: "企業・案件", value: (row) => row.companyName + " / " + row.title, link: true },
      { label: "担当", value: (row) => row.ownerName },
      { label: "ENGER", value: (row) => row.sourceUrl, url: true },
    ], "br-backlog", matching.backlogRowsTotal);
    el("br-report").innerHTML = coverageHtml + kpis + '<div class="br-sections">'
      + '<section class="br-card"><h3>失注理由（' + number(current.closedCount) + '）</h3>' + reasonBody
      + '<p class="br-note">具体的な理由未入力・「企業側見送り」・「その他」: ' + number(current.missingReasonCount) + "</p></section>"
      + '<section class="br-card"><h3>担当者別のボトルネック</h3><p class="br-note">提案10件以上で面談率10%未満、またはENGER提案準備タスクの期限超過を表示。</p>'
      + ownerBody + "</section>"
      + '<section class="br-card"><h3>改善アクション</h3>' + actionHtml + "</section>" + rules + "</div>"
      + '<div class="br-sections" style="margin-top:12px">' + proposalRows + meetingRows + lossRows + matchRows + stalledRows + blasts + backlog + "</div>";
  }
  async function load(force) {
    if (window.businessReportPermitted !== true || loading) return;
    if (report && !force) { render(report); return; }
    loading = true;
    const id = ++requestId;
    el("br-report").innerHTML = '<div class="empty">Sales・ENGERの記録を集計しています…</div>';
    try {
      const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      const response = await window.API.api("/api/nippo/business-report?period=" + period + "&date=" + encodeURIComponent(date));
      if (id !== requestId) return;
      report = response;
      render(response);
    } catch (error) {
      if (id !== requestId) return;
      el("br-report").innerHTML = '<div class="banner err"><span class="material-symbols-outlined">error</span><div>'
        + esc(error?.hint || error?.detail || error?.message || "全体レポートを取得できません") + "</div></div>";
    } finally {
      if (id === requestId) loading = false;
    }
  }
  async function checkAccess() {
    try {
      const access = await window.API.api("/api/nippo/business-report?access=1");
      window.businessReportPermitted = access?.available === true;
    } catch (_) {
      window.businessReportPermitted = false;
    }
    el("tab-business").classList.toggle("hidden", !window.businessReportPermitted);
    if (!window.businessReportPermitted && !el("pane-business").classList.contains("hidden")) {
      window.showTab?.("mine");
    }
  }
  function setPeriod(value) {
    period = value === "week" ? "week" : "day";
    report = null;
    requestId++;
    loading = false;
    el("br-period-day").classList.toggle("on", period === "day");
    el("br-period-week").classList.toggle("on", period === "week");
    load(true);
  }
  window.BusinessReportUI = { load, setPeriod, checkAccess };
})();
