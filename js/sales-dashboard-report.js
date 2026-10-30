(() => {
  const $ = (id) => document.getElementById(id);
  const labels = {
    today: "今日", yesterday: "昨日", this_week: "今週", last_week: "先週",
    this_month: "今月", last_month: "先月", last_7: "直近7日", last_30: "直近30日", custom: "期間指定",
  };
  const MAX_DAYS = 400;
  let state = null;
  let report = null;
  let requestVersion = 0;

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
  const n = (value) => Number(value || 0).toLocaleString("ja-JP");
  const rate = (value) => value == null ? "—" : `${Number(value).toFixed(1)}%`;
  const ymd = (value) => String(value || "").replaceAll("-", "/");
  const todayJst = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const addDays = (day, count) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + count);
    return d.toISOString().slice(0, 10);
  };
  const validDay = (day) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return false;
    const parsed = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
  };
  const dayCount = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

  function readUrl() {
    const url = new URL(location.href);
    return {
      key: url.searchParams.get("period") || "this_week",
      from: url.searchParams.get("from") || "",
      to: url.searchParams.get("to") || "",
      hasPeriod: url.searchParams.has("period"),
    };
  }

  function writeUrl(next, replace = false) {
    const url = new URL(location.href);
    url.searchParams.set("period", next.key);
    if (next.key === "custom") {
      url.searchParams.set("from", next.from);
      url.searchParams.set("to", next.to);
    } else {
      url.searchParams.delete("from");
      url.searchParams.delete("to");
    }
    history[replace ? "replaceState" : "pushState"]({}, "", url);
  }

  function setSelected(key) {
    document.querySelectorAll("#db-periods [data-period]").forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.period === key ? "true" : "false");
    });
    $("db-period-range").hidden = key !== "custom";
  }

  function validateRange(from, to) {
    if (!validDay(from) || !validDay(to)) return "開始日と終了日をカレンダーから選んでください。";
    if (from > to) return "開始日は終了日より前の日にしてください。";
    if (dayCount(from, to) > MAX_DAYS) return `期間指定は${MAX_DAYS}日以内にしてください。`;
    return "";
  }

  function showError(message) {
    $("db-report-error").textContent = message;
    $("db-report-error").hidden = !message;
  }

  function signed(value) {
    return value > 0 ? `+${n(value)}` : value < 0 ? `−${n(Math.abs(value))}` : "±0";
  }

  function compareCount(value, previous, unit = "件") {
    if (value == null || previous == null) return "前期間：—";
    return `前期間 ${n(previous)}${unit}（${signed(value - previous)}${unit}）`;
  }

  function compareRate(value, previous) {
    if (value == null) return "対象期間の提案送信なし";
    if (previous == null) return "前期間：比較できる提案送信なし";
    const delta = Math.round((value - previous) * 10) / 10;
    const formatted = delta > 0 ? `+${delta.toFixed(1)}` : delta < 0 ? `−${Math.abs(delta).toFixed(1)}` : "±0.0";
    return `前期間 ${rate(previous)}（${formatted}ポイント）`;
  }

  function kpi(label, value, unit, compare, context = "") {
    return `<article class="db-kpi"><div class="k">${esc(label)}</div><div class="v">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}</div><div class="compare">${esc(compare)}</div>${context ? `<div class="compare">${esc(context)}</div>` : ""}</article>`;
  }

  function listMarkup(rows) {
    return rows?.length ? `<ul>${rows.map((row) => `<li>${esc(row)}</li>`).join("")}</ul>` : `<p class="empty">該当なし</p>`;
  }

  function tableMarkup(headers, rows, emptyText) {
    if (!rows.length) return `<p class="empty">${esc(emptyText)}</p>`;
    return `<div class="db-report-table-wrap"><table class="db-report-table"><thead><tr>${headers.map((h) => `<th class="${h.num ? "num" : ""}">${esc(h.label)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  }

  function bars(rows) {
    const max = Math.max(1, ...rows.map(row => Number(row.count) || 0));
    return rows.map(row => `<div class="db-bar-row"><span>${esc(row.label)}</span><span class="db-bar-track" aria-hidden="true"><i class="db-bar-fill" style="width:${Math.max(0, Number(row.count) || 0) / max * 100}%"></i></span><strong>${n(row.count)}件</strong></div>`).join("");
  }

  function render(data) {
    report = data;
    const m = data.metrics;
    const p = data.previousMetrics;
    $("db-period-caption").textContent = `対象期間：${ymd(data.period.from)}〜${ymd(data.period.to)}（JST）　比較：${ymd(data.previousPeriod.from)}〜${ymd(data.previousPeriod.to)}（直前の同日数）`;
    $("db-report-note").textContent = data.dataStatus?.note || "";
    $("db-report-note").hidden = !data.dataStatus?.note;

    const cards = [
      kpi("マッチング確定", n(m.matchingCount), "件", compareCount(m.matchingCount, p.matchingCount), `未送信 ${n(m.unsubmittedMatchedCount)}件`),
      kpi("提案送信", n(m.proposalSentCount), "件", compareCount(m.proposalSentCount, p.proposalSentCount), "企業へ送信した日時で集計"),
      kpi("面談実施", n(m.meetingEventCount), "件", compareCount(m.meetingEventCount, p.meetingEventCount), "対象期間内の実施記録"),
      kpi("提案→面談率", rate(m.conversionRate), "", compareRate(m.conversionRate, p.conversionRate), `面談済み ${n(m.meetingCohortCount)} / 提案 ${n(m.proposalSentCount)}件`),
      kpi("失注・クローズ", n(m.closedCount), "件", compareCount(m.closedCount, p.closedCount), "対象期間内に終了した記録"),
      `<article class="db-kpi target"><div class="k">提案→面談率の目標</div><div class="v">10<small>%</small></div><div class="compare">提案10件に面談1件以上</div></article>`,
    ].join("");

    const ownerCurrent = new Map(m.byOwner.map((row) => [row.ownerId, row]));
    const ownerPrevious = new Map(p.byOwner.map((row) => [row.ownerId, row]));
    const ownerRows = [...new Set([...ownerCurrent.keys(), ...ownerPrevious.keys()])].map((id) => {
      const row = ownerCurrent.get(id) || ownerPrevious.get(id);
      const current = ownerCurrent.get(id) || { matchingCount: 0, proposalSentCount: 0, meetingEventCount: 0, meetingCohortCount: 0, conversionRate: null };
      const before = ownerPrevious.get(id) || { matchingCount: 0, proposalSentCount: 0, meetingEventCount: 0, meetingCohortCount: 0, conversionRate: null };
      return `<tr><td>${esc(row.ownerName)}</td><td class="num">${n(current.matchingCount)} / ${n(before.matchingCount)}</td><td class="num">${n(current.proposalSentCount)} / ${n(before.proposalSentCount)}</td><td class="num">${n(current.meetingEventCount)} / ${n(before.meetingEventCount)}</td><td class="num">${n(current.meetingCohortCount)} / ${n(before.meetingCohortCount)}</td><td class="num">${rate(current.conversionRate)} / ${rate(before.conversionRate)}</td></tr>`;
    });
    const previousReasons = new Map(p.lossReasons.map((row) => [row.key, row]));
    const currentReasons = new Map(m.lossReasons.map((row) => [row.key, row]));
    const lossKeys = new Set([...currentReasons.keys(), ...previousReasons.keys()]);
    const lossRows = [...lossKeys].map((key) => {
      const current = currentReasons.get(key) || { label: previousReasons.get(key).label, count: 0 };
      const before = previousReasons.get(key)?.count || 0;
      return `<tr><td>${esc(current.label)}</td><td class="num">${n(current.count)}</td><td class="num">${n(before)}</td><td class="num">${signed(current.count - before)}</td></tr>`;
    });
    const blastCurrent = new Map(m.blastCompanies.map((row) => [row.key, row]));
    const previousBlasts = new Map(p.blastCompanies.map((row) => [row.key, row]));
    const blastRows = [...new Set([...blastCurrent.keys(), ...previousBlasts.keys()])].map((key) => {
      const current = blastCurrent.get(key);
      const before = previousBlasts.get(key);
      const company = current || before;
      return `<tr><td>${esc(company.companyName)}<span class="db-blast-tag">${current ? "当期間候補" : "前期間候補"}</span></td><td class="num">${current ? n(current.sentCount) : "—"}</td><td class="num">${current ? n(current.meetingCount) : "—"}</td><td class="num">${current ? rate(current.rate) : "—"}</td><td>${before ? "候補" : "—"}</td></tr>`;
    });
    const companyRows = (m.byCompany || []).slice(0, 100).map(row => `<tr><td>${esc(row.companyName)}</td><td class="num">${n(row.sentCount)}</td><td class="num">${n(row.meetingCount)}</td><td class="num">${rate(row.rate)}</td><td>${esc((row.lossReasons || []).map(reason => reason.label+" "+reason.count+"件").join("／") || "終了理由の記録なし")}</td><td>${row.sentCount < 10 ? "少数・参考" : row.sentCount >= 15 && !row.meetingCount ? "継続方針を確認" : "記録を確認"}</td></tr>`);
    const roleMarkup = Object.entries({proposal:"提案",cs:"CS",closing:"クロージング"}).map(([key,label]) => {
      const rows = (m.roleRows?.[key] || []).map(row => `<tr><td>${esc(row.ownerName)}</td><td class="num">${n(row.sentCount)}</td><td class="num">${n(row.meetingCount)}</td><td class="num">${rate(row.rate)}</td><td class="num">${n(row.wonCount)}</td><td>${row.sentCount < 10 ? "少数・参考" : "分母を確認"}${key === "proposal" ? `・実行者記録 ${n(row.recordedActorCount)}件` : ""}</td></tr>`);
      return `<details class="db-report-card full"><summary>${label}担当別（同じ役割内の参考比較）</summary><p class="empty">選択期間に送信した提案が分母。提案は送信活動の実行者を優先、未記録は登録担当。CS・クロージングは現在の登録担当で、当時の実行者や個人評価を示すものではありません。</p>${tableMarkup([{label:"担当"},{label:"対象提案",num:true},{label:"面談到達",num:true},{label:"面談率",num:true},{label:"現在成約",num:true},{label:"記録"}],rows,"記録なし")}</details>`;
    }).join("");
    const sentRows = (m.sentRecords || []).slice(0, 50).map(row => `<tr><td>${esc(row.companyName)}</td><td>${esc(row.ownerName)}<br><small>${esc(row.actorBasis)}</small></td><td>${esc(new Date(row.sentAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false}))}</td><td class="num">${row.elapsedHours == null ? "未確認" : n(row.elapsedHours)+"時間"}</td><td>未計測</td></tr>`);
    const blastChange = m.blastCompanies.length - p.blastCompanies.length;
    const blastComparison = `今回 ${n(m.blastCompanies.length)}社／前期間 ${n(p.blastCompanies.length)}社（${signed(blastChange)}社）`;

    $("db-business-content").innerHTML = `
      <div class="db-kpis">${cards}</div>
      <div class="db-report-grid">
        <section class="db-report-card"><h3>提案から面談へ<small>選択期間に送信した提案の到達件数。実作業時間は未計測です。</small></h3>${bars([{label:"提案送信",count:m.proposalSentCount},{label:"面談実施済み",count:m.meetingCohortCount}])}</section>
        <section class="db-report-card"><h3>失注理由の内訳<small>記録された理由。真因の確定ではありません。</small></h3>${m.lossReasons.length ? bars(m.lossReasons) : '<p class="empty">記録なし</p>'}</section>
        ${roleMarkup}
        <details class="db-report-card full"><summary>提案送信者・日時の明細</summary><p class="empty">最新50件まで表示。JST。確定から送信までの経過時間は待機・休日も含み、実作業時間ではありません。</p>${tableMarkup([{label:"提案先"},{label:"担当・根拠"},{label:"送信日時"},{label:"経過時間",num:true},{label:"実作業時間"}],sentRows,"対象期間の提案送信はありません。")}</details>
        <details class="db-report-card full"><summary>提案先企業別（分母・面談率）</summary><p class="empty">提案件数順に100社まで表示。全件はCSVで確認できます。終了理由は当期間の送信コホートの現在記録です。会社IDが異なる記録は別集計です。</p>${tableMarkup([{label:"企業"},{label:"提案",num:true},{label:"面談到達",num:true},{label:"面談率",num:true},{label:"コホートの終了理由"},{label:"確認"}],companyRows,"対象期間の提案送信はありません。")}</details>
        <section class="db-report-card"><h3>課題</h3>${listMarkup(data.insights.issues)}</section>
        <section class="db-report-card"><h3>改善点</h3>${listMarkup(data.insights.improvements)}</section>
        <section class="db-report-card"><h3>次の行動</h3>${listMarkup(data.insights.actions)}</section>
        <section class="db-report-card"><h3>失注・クローズ理由<small>当期間 / 前期間 / 差</small></h3>${tableMarkup([{ label: "理由" }, { label: "当期間", num: true }, { label: "前期間", num: true }, { label: "差", num: true }], lossRows, "対象期間内の失注・クローズはありません。")}</section>
        <details class="db-report-card full"><summary>担当者別の記録を開く</summary><h3>担当者別<small>当期間 / 前期間。面談実施は実施日、面談率は期間内に送信した提案コホートです。担当はSalesの現在の担当に集約。当時の実行者・役割別ランキングではありません。少数の率だけで比較しないでください。</small></h3>${tableMarkup([{ label: "担当者" }, { label: "マッチング（当 / 前）", num: true }, { label: "提案送信（当 / 前）", num: true }, { label: "面談実施（当 / 前）", num: true }, { label: "コホート面談（当 / 前）", num: true }, { label: "面談率（当 / 前）", num: true }], ownerRows, "対象期間内の担当者別記録はありません。")}</details>
        <section class="db-report-card full"><h3>ブラスト限定候補<small>${esc(blastComparison)}。当期間内に15件以上提案し、当期間内送信コホートの面談実施が0件の企業。自動停止や配信登録は行いません。</small></h3>${tableMarkup([{ label: "企業" }, { label: "当期間の提案", num: true }, { label: "当期間の面談", num: true }, { label: "当期間の面談率", num: true }, { label: "前期間も候補" }], blastRows, "対象期間内に条件を満たす企業はありません。")}</section>
      </div>`;
    $("db-business-csv").disabled = false;
  }

  function setRangeCaption(text) {
    $("db-period-caption").textContent = text;
  }

  async function load() {
    if (!state) return;
    const version = ++requestVersion;
    setSelected(state.key);
    showError("");
    report = null;
    $("db-business-csv").disabled = true;
    $("db-business-content").innerHTML = `<div class="sl-empty">集計中…</div>`;
    const invalidPeriod = ![...Object.keys(labels)].includes(state.key);
    if (invalidPeriod) {
      $("db-business-content").innerHTML = "";
      setRangeCaption("期間指定を確認してください。");
      showError("期間の指定が正しくありません。");
      return;
    }
    if (state.key === "custom") {
      const invalidRange = validateRange(state.from, state.to);
      if (invalidRange) {
        $("db-business-content").innerHTML = "";
        $("db-business-csv").disabled = true;
        setRangeCaption("期間指定の入力を確認してください。");
        showError(invalidRange);
        return;
      }
    }
    const query = new URLSearchParams({ period: state.key });
    if (state.key === "custom") {
      query.set("from", state.from);
      query.set("to", state.to);
    }
    try {
      const data = await API.api(`/api/sales/dashboard-analysis?${query.toString()}`);
      if (version !== requestVersion) return;
      render(data);
    } catch (error) {
      if (version !== requestVersion) return;
      $("db-business-content").innerHTML = "";
      setRangeCaption(state.key === "custom"
        ? `対象期間：${ymd(state.from)}〜${ymd(state.to)}（JST）`
        : `集計期間：${labels[state.key]}`);
      showError(error?.hint || error?.detail || error?.message || "記録を取得できませんでした。");
    }
  }

  function choosePeriod(key) {
    if (key === "custom") {
      const today = todayJst();
      const fromInput = $("db-period-from");
      const toInput = $("db-period-to");
      if (!fromInput.value || !toInput.value) {
        fromInput.value = addDays(today, -29);
        toInput.value = today;
      }
      state = { key, from: fromInput.value, to: toInput.value };
      writeUrl(state);
      load();
      return;
    }
    state = { key, from: "", to: "" };
    writeUrl(state);
    load();
  }

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function exportCsv() {
    if (!report) return;
    const { metrics: m, previousMetrics: p, period, previousPeriod } = report;
    const rows = [["区分", "項目", "対象期間", "直前の同日数期間", "単位", "補足"]];
    const metricRows = [
      ["マッチング確定", m.matchingCount, p.matchingCount, "件", "確定日時で集計"],
      ["マッチング後の未送信", m.unsubmittedMatchedCount, p.unsubmittedMatchedCount, "件", "対象期間に確定した提案の現在状態"],
      ["提案送信", m.proposalSentCount, p.proposalSentCount, "件", "送信日時で集計"],
      ["面談実施", m.meetingEventCount, p.meetingEventCount, "件", "実施日時で集計"],
      ["提案→面談率", rate(m.conversionRate), rate(p.conversionRate), "%", `送信コホート 面談 ${m.meetingCohortCount} / 提案 ${m.proposalSentCount}`],
      ["失注・クローズ", m.closedCount, p.closedCount, "件", "終了日時で集計"],
    ];
    metricRows.forEach((row) => rows.push(["全体", row[0], row[1], row[2], row[3], row[4]]));
    const ownerCurrent = new Map(m.byOwner.map((row) => [row.ownerId, row]));
    const ownerPrevious = new Map(p.byOwner.map((row) => [row.ownerId, row]));
    [...new Set([...ownerCurrent.keys(), ...ownerPrevious.keys()])].forEach((id) => {
      const row = ownerCurrent.get(id) || ownerPrevious.get(id);
      const current = ownerCurrent.get(id) || { matchingCount: 0, proposalSentCount: 0, meetingEventCount: 0, meetingCohortCount: 0, conversionRate: null };
      const before = ownerPrevious.get(id) || { matchingCount: 0, proposalSentCount: 0, meetingEventCount: 0, meetingCohortCount: 0, conversionRate: null };
      rows.push(["担当者", row.ownerName,
        `マッチング ${current.matchingCount} / 提案 ${current.proposalSentCount} / 面談実施 ${current.meetingEventCount} / コホート面談 ${current.meetingCohortCount} / 移行率 ${rate(current.conversionRate)}`,
        `マッチング ${before.matchingCount} / 提案 ${before.proposalSentCount} / 面談実施 ${before.meetingEventCount} / コホート面談 ${before.meetingCohortCount} / 移行率 ${rate(before.conversionRate)}`,
        "", ""]);
    });
    const previousReasons = new Map(p.lossReasons.map((row) => [row.key, row]));
    const currentReasons = new Map(m.lossReasons.map((row) => [row.key, row]));
    new Set([...currentReasons.keys(), ...previousReasons.keys()]).forEach((key) => {
      const current = currentReasons.get(key) || { label: previousReasons.get(key).label, count: 0 };
      rows.push(["失注理由", current.label, current.count, previousReasons.get(key)?.count || 0, "件", ""]);
    });
    const blastCurrent = new Map(m.blastCompanies.map((row) => [row.key, row]));
    const previousBlasts = new Map(p.blastCompanies.map((row) => [row.key, row]));
    [...new Set([...blastCurrent.keys(), ...previousBlasts.keys()])].forEach((key) => {
      const current = blastCurrent.get(key);
      const before = previousBlasts.get(key);
      const company = current || before;
      rows.push(["ブラスト限定候補", company.companyName,
        current ? current.sentCount : "—", current ? current.meetingCount : "—",
        current ? "当期間提案 / 面談" : "当期間は対象外", `前期間候補 ${before ? "あり" : "なし"}`]);
    });
    Object.entries({proposal:"提案担当",cs:"CS登録担当",closing:"クロージング登録担当"}).forEach(([role,label]) =>
      (m.roleRows?.[role] || []).forEach(row => rows.push([label,row.ownerName,row.sentCount,row.meetingCount,"対象提案 / 面談到達",`面談率 ${rate(row.rate)}・現在成約 ${row.wonCount}・実行者記録 ${row.recordedActorCount}`])));
    (m.sentRecords || []).forEach(row => rows.push(["提案送信",row.companyName,row.sentAt,row.ownerName,row.actorBasis,`経過時間 ${row.elapsedHours == null ? "未確認" : row.elapsedHours+"時間"}・実作業時間未計測`]));
    (m.byCompany || []).forEach(row => rows.push(["提案先企業", row.companyName, row.sentCount, row.meetingCount, "提案 / 面談到達", `面談率 ${rate(row.rate)}・送信コホート・終了理由 ${(row.lossReasons || []).map(reason => reason.label+" "+reason.count+"件").join("／") || "記録なし"}`]));
    report.insights.issues.forEach((row) => rows.push(["課題", row, "", "", "", ""]));
    report.insights.improvements.forEach((row) => rows.push(["改善点", row, "", "", "", ""]));
    report.insights.actions.forEach((row) => rows.push(["次の行動", row, "", "", "", ""]));
    rows.splice(1, 0, ["対象期間", "", `${period.from}〜${period.to} JST`, `${previousPeriod.from}〜${previousPeriod.to} JST`, "", ""]);
    const blob = new Blob(["\uFEFF", rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `sales_dashboard_${period.from}_${period.to}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function init() {
    const initial = readUrl();
    state = { key: initial.key, from: initial.from, to: initial.to };
    if (state.key === "custom" && (!state.from || !state.to)) {
      const today = todayJst();
      state.from = addDays(today, -29);
      state.to = today;
      writeUrl(state, true);
    } else if (!initial.hasPeriod) {
      writeUrl(state, true);
    }
    $("db-period-from").value = state.from;
    $("db-period-to").value = state.to;
    $("db-period-to").min = state.from || "";
    $("db-period-from").addEventListener("change", () => {
      $("db-period-to").min = $("db-period-from").value;
    });
    $("db-periods").addEventListener("click", (event) => {
      const button = event.target.closest("[data-period]");
      if (button) choosePeriod(button.dataset.period);
    });
    $("db-period-range").addEventListener("submit", (event) => {
      event.preventDefault();
      const from = $("db-period-from").value;
      const to = $("db-period-to").value;
      const error = validateRange(from, to);
      if (error) {
        requestVersion++;
        report = null;
        $("db-business-csv").disabled = true;
        $("db-business-content").innerHTML = "";
        setRangeCaption("期間指定の入力を確認してください。");
        showError(error);
        return;
      }
      state = { key: "custom", from, to };
      writeUrl(state);
      load();
    });
    $("db-business-csv").addEventListener("click", exportCsv);
    window.addEventListener("popstate", () => {
      const urlState = readUrl();
      state = { key: urlState.key, from: urlState.from, to: urlState.to };
      $("db-period-from").value = state.from;
      $("db-period-to").value = state.to;
      load();
    });
  }

  init();
  window.SalesDashboardReport = { load };
})();
