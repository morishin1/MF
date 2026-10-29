(() => {
  const $ = (id) => document.getElementById(id);
  const labels = {
    today: "今日", yesterday: "昨日", this_week: "今週", last_week: "先週",
    this_month: "今月", last_month: "先月", last_30: "直近30日", custom: "期間指定",
  };
  const MAX_DAYS = 400;
  let state = null;
  let report = null;

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


  let analysisTab = "overview";
  let rankingMetric = "proposalSentCount";
  function enhanceAnalysis(data) {
    const root = $("db-business-content");
    const grid = root.querySelector(".db-report-grid");
    const sections = [...grid.children];
    const m = data.metrics;
    const bars = (rows) => {
      const max = Math.max(1, ...rows.map(r => r.value));
      return rows.length ? '<ol class="db-bars">' + rows.map(r => '<li><span>' + esc(r.label) + '</span><div class="db-bar-track"><i style="width:' + (r.value / max * 100) + '%"></i></div><b>' + esc(r.text) + '</b></li>').join('') + '</ol>' : '<p class="empty">対象期間の記録なし</p>';
    };
    const groups = {overview:[0,1,2], owners:[4], losses:[3], blast:[5]};
    const tabs = [['overview','概要'],['companies','企業別分析'],['owners','担当者別分析'],['losses','失注理由'],['blast','ブラスト候補（' + m.blastCompanies.length + '）']];
    const nav = document.createElement('nav'); nav.className='db-analysis-tabs'; nav.setAttribute('aria-label','分析の切替');
    nav.innerHTML=tabs.map(([key,label]) => '<button type="button" data-analysis-tab="' + key + '" aria-pressed="' + (analysisTab === key) + '">' + esc(label) + '</button>').join('');
    root.insertBefore(nav,grid);
    const company = document.createElement('section'); company.className='db-report-card full';
    company.innerHTML='<h3>企業別提案分析</h3>' + tableMarkup([{label:'企業'},{label:'提案数',num:true},{label:'面談数',num:true},{label:'面談化率',num:true},{label:'分類'}], (m.companies || []).map(r => '<tr><td>' + esc(r.companyName) + '</td><td class="num">' + n(r.sentCount) + '</td><td class="num">' + n(r.meetingCount) + '</td><td class="num">' + rate(r.rate) + '</td><td>' + (r.blastCandidate ? 'ブラスト候補' : '継続確認') + '</td></tr>'),'対象期間の提案なし');
    grid.append(company);
    const charts=document.createElement('section'); charts.className='db-report-card';
    charts.innerHTML='<h3>担当者ランキング</h3><label>評価指標 <select id="db-ranking-metric"><option value="proposalSentCount">提案数</option><option value="conversionRate">面談化率（提案10件以上）</option><option value="quality">マッチング精度</option><option value="duration">提案作業時間</option></select></label><div id="db-ranking-bars"></div>';
    grid.append(charts);
    const loss=document.createElement('section'); loss.className='db-report-card'; loss.innerHTML='<h3>失注理由の比較</h3>'+bars(m.lossReasons.map(r=>({label:r.label,value:r.count,text:n(r.count)+'件'}))); grid.append(loss);
    const trend=document.createElement('section'); trend.className='db-report-card full';
    const points=m.trend || []; const max=Math.max(1,...points.flatMap(r=>[r.sent,r.meetings]));
    const line=key=>points.map((r,i)=>(20+i*960/Math.max(1,points.length-1))+','+(130-r[key]*110/max)).join(' ');
    trend.innerHTML='<h3>日別推移<small>青：提案送信 ／ 緑：面談実施。実施日による別集計</small></h3>'+(points.length ? '<svg viewBox="0 0 1000 155" role="img" aria-label="提案送信と面談実施の日別推移"><path d="M20 20 V130 H980" fill="none" stroke="#ddd"/><polyline points="'+line('sent')+'" fill="none" stroke="#334a78" stroke-width="3"/><polyline points="'+line('meetings')+'" fill="none" stroke="#28745b" stroke-width="3"/></svg><small>'+esc(points[0].day)+' 〜 '+esc(points.at(-1).day)+' ／ 最大 '+max+'件</small><details><summary>日別の数値</summary>'+tableMarkup([{label:'日付'},{label:'提案数'},{label:'面談実施数'}],points.map(r=>'<tr><td>'+esc(r.day)+'</td><td>'+n(r.sent)+'</td><td>'+n(r.meetings)+'</td></tr>'),'記録なし')+'</details>' : '<p>推移データなし</p>'); grid.append(trend);
    const funnel=document.createElement('section'); funnel.className='db-report-card full';
    funnel.innerHTML='<h3>提案から面談へのファネル<small>期間内送信の同一提案を追跡</small></h3>'+bars([{label:'提案送信',value:m.proposalSentCount,text:n(m.proposalSentCount)+'件'},{label:'面談済み',value:m.meetingCohortCount,text:n(m.meetingCohortCount)+'件（'+rate(m.conversionRate)+'）'}]); grid.prepend(funnel);
    function rank() {
      const metric=rankingMetric;
      if (metric==='quality' || metric==='duration') { $('db-ranking-bars').innerHTML='<p class="empty">'+(metric==='quality'?'AIマッチングスコア':'作業開始・完了時刻')+'は現在のSales連携に記録されていません。未計測のため順位は算出できません。</p>'; return; }
      const rows=m.byOwner.filter(r=>metric!=='conversionRate'||r.proposalSentCount>=10).slice().sort((a,b)=>(b[metric]||0)-(a[metric]||0)||a.ownerName.localeCompare(b.ownerName,'ja'));
      $('db-ranking-bars').innerHTML=bars(rows.map((r,i)=>({label:(i+1)+'. '+r.ownerName,value:r[metric]||0,text:metric==='conversionRate'?rate(r[metric]):n(r[metric])+'件'})));
    }
    $('db-ranking-metric').value=rankingMetric;
    $('db-ranking-metric').onchange=e=>{rankingMetric=e.target.value;rank();}; rank();
    function selectTab(key) {
      analysisTab=key;
      sections.forEach((section,i)=>section.hidden=!(groups[key]||[]).includes(i));
      company.hidden=key!=='companies'; charts.hidden=key!=='overview'&&key!=='owners'; loss.hidden=key!=='overview'; trend.hidden=key!=='overview'; funnel.hidden=key!=='overview';
      nav.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.analysisTab===key)));
    }
    nav.onclick=e=>{const b=e.target.closest('button[data-analysis-tab]');if(b)selectTab(b.dataset.analysisTab);}; selectTab(analysisTab);
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
    const blastChange = m.blastCompanies.length - p.blastCompanies.length;
    const blastComparison = `今回 ${n(m.blastCompanies.length)}社／前期間 ${n(p.blastCompanies.length)}社（${signed(blastChange)}社）`;

    $("db-business-content").innerHTML = `
      <div class="db-kpis">${cards}</div>
      <div class="db-report-grid">
        <section class="db-report-card"><h3>課題</h3>${listMarkup(data.insights.issues)}</section>
        <section class="db-report-card"><h3>改善点</h3>${listMarkup(data.insights.improvements)}</section>
        <section class="db-report-card"><h3>次の行動</h3>${listMarkup(data.insights.actions)}</section>
        <section class="db-report-card"><h3>失注・クローズ理由<small>当期間 / 前期間 / 差</small></h3>${tableMarkup([{ label: "理由" }, { label: "当期間", num: true }, { label: "前期間", num: true }, { label: "差", num: true }], lossRows, "対象期間内の失注・クローズはありません。")}</section>
        <section class="db-report-card full"><h3>担当者別<small>当期間 / 前期間。面談実施は実施日、面談率は期間内に送信した提案コホートです。担当はSalesの現在の担当に集約。</small></h3>${tableMarkup([{ label: "担当者" }, { label: "マッチング（当 / 前）", num: true }, { label: "提案送信（当 / 前）", num: true }, { label: "面談実施（当 / 前）", num: true }, { label: "コホート面談（当 / 前）", num: true }, { label: "面談率（当 / 前）", num: true }], ownerRows, "対象期間内の担当者別記録はありません。")}</section>
        <section class="db-report-card full"><h3>ブラスト限定候補<small>${esc(blastComparison)}。当期間内に15件以上提案し、当期間内送信コホートの面談実施が0件の企業。自動停止や配信登録は行いません。</small></h3>${tableMarkup([{ label: "企業" }, { label: "当期間の提案", num: true }, { label: "当期間の面談", num: true }, { label: "当期間の面談率", num: true }, { label: "前期間も候補" }], blastRows, "対象期間内に条件を満たす企業はありません。")}</section>
      </div>`;
    enhanceAnalysis(data);
    $("db-business-csv").disabled = false;
  }

  function setRangeCaption(text) {
    $("db-period-caption").textContent = text;
  }

  async function load() {
    if (!state) return;
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
      render(data);
    } catch (error) {
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
