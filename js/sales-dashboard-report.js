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
  let customEditorOpen = false;

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

  // Shared period selector mirrors the JST calendar rules in lib/sales-period.js.
  // The authenticated API remains authoritative for event date boundaries.
  const weekMonday = day => addDays(day, -((new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7));
  function boundsOf(next) {
    const today = todayJst();
    const monthStart = day => day.slice(0, 7) + "-01";
    let from = today, to = today;
    if (next.key === "yesterday") from = to = addDays(today, -1);
    else if (next.key === "this_week") from = weekMonday(today);
    else if (next.key === "last_week") {
      to = addDays(weekMonday(today), -1); from = addDays(to, -6);
    } else if (next.key === "this_month") from = monthStart(today);
    else if (next.key === "last_month") {
      to = addDays(monthStart(today), -1); from = monthStart(to);
    } else if (next.key === "last_7") from = addDays(today, -6);
    else if (next.key === "last_30") from = addDays(today, -29);
    else if (next.key === "custom") { from = next.from; to = next.to; }
    return { from, to };
  }
  function showGlobalError(message = "") {
    const error = $("db-global-period-error");
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  }
  function updateGlobalPeriod() {
    if (!state) return;
    const bounds = boundsOf(state);
    const label = $("db-global-period-summary");
    if (label) label.textContent = (labels[state.key] || "期間指定") + "：" +
      ymd(bounds.from) + "〜" + ymd(bounds.to) + "（JST）";
    setSelected(state.key);
  }
  function notifyPeriodChanged(loadVisible = true) {
    requestVersion++;
    report = null;
    $("db-business-csv").disabled = true;
    $("db-rankings-content").innerHTML = '<p class="sl-empty">選択期間のランキングを読み込むと表示されます。</p>';
    $("db-business-content").innerHTML = '<p class="sl-empty">このタブを開くと選択期間を集計します。</p>';
    $("db-period-caption").textContent = "集計対象：" + (labels[state.key] || "期間指定");
    showError("");
    showGlobalError("");
    updateGlobalPeriod();
    window.SalesDashboardTabs?.periodChanged?.({loadVisible});
    window.SalesCompanyReference?.periodChanged?.();
  }


  function readUrl() {
    const url = new URL(location.href);
    return {
      key: url.searchParams.get("period") || "last_30",
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
    $("db-period-range").hidden = !(key === "custom" || customEditorOpen);
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

    // One compact row of three rankings. Raw data comes from the existing
    // authenticated dashboard API; do not invent demand, availability or margin.
    const statusLabels = {
      proposal_wait:"提案準備", call_wait:"電話待ち", mail_wait:"メール待ち",
      reply_wait:"回答待ち", meeting_adjust:"面談調整", meeting_done:"面談済み",
      considering:"継続検討", reproposal:"再提案",
    };
    const priorityCases = (m.priorityCases || []).slice(0, 10);
    const caseRow = (row, index) => {
      const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.proposalId || "");
      const label = `${index + 1}. ${row.title || "案件名未確認"}`;
      return `<li class="db-rank-item"><span class="db-rank-main">${valid
        ? `<a href="https://dx.enger.jp/proposals/${esc(row.proposalId)}" rel="noopener noreferrer">${esc(label)}</a>`
        : esc(label)}<small>${esc(row.companyName || "企業未確認")}</small></span>
        <span class="db-rank-tag">${esc(statusLabels[row.status] || "状態未確認")}</span></li>`;
    };
    const firstCases = priorityCases.slice(0, 5).map(caseRow).join("");
    const moreCases = priorityCases.length > 5
      ? `<details class="db-rank-more"><summary>残り${priorityCases.length - 5}件を見る</summary><ol start="6">${priorityCases.slice(5).map((row, i) => caseRow(row, i + 5)).join("")}</ol></details>` : "";
    const companyLeaders = [...(m.byCompany || [])]
      .filter((row) => row.companyName && row.companyName !== "（社名なし）")
      .sort((a, b) => b.sentCount - a.sentCount || b.meetingCount - a.meetingCount)
      .slice(0, 5);
    const staffLeaders = [...(m.roleRows?.proposal || [])]
      .filter((row) => row.ownerId && row.ownerId !== "unassigned")
      .sort((a, b) => b.sentCount - a.sentCount || b.meetingCount - a.meetingCount)
      .slice(0, 5);
    const visual=window.SalesVisuals;
    const companyRanks=visual?visual.bars(companyLeaders.map(x=>({
      label:x.companyName,value:x.sentCount,detail:"面談 "+n(x.meetingCount)+"/"+n(x.sentCount)+"件"+(x.sentCount<10?"・少数参考":"")
    })),{title:"企業別提案実績",maxRows:5})
      : companyLeaders.map((x,i)=>'<li class="db-rank-item">'+esc(String(i+1)+". "+x.companyName)+" / "+n(x.sentCount)+"件</li>").join("");
    const staffRanks=visual?visual.bars(staffLeaders.map(x=>({
      label:x.ownerName,value:x.sentCount,detail:"面談 "+n(x.meetingCount)+"/"+n(x.sentCount)+"件"+(x.sentCount<10?"・少数参考":"")
    })),{title:"担当者別提案実績",maxRows:5})
      : staffLeaders.map((x,i)=>'<li class="db-rank-item">'+esc(String(i+1)+". "+x.ownerName)+" / "+n(x.sentCount)+"件</li>").join("");
    const rankingMarkup = `<div class="db-rank-grid" aria-label="営業優先ランキング">
      <section class="db-rank-panel db-rank-cases"><h3>案件の確認優先 TOP10 <small>進行段階による確認順。需要・提案可能人数・採算は未照合</small></h3>
        ${priorityCases.length ? `<ol>${firstCases}</ol>${moreCases}` : '<p class="empty">対象期間の進行中提案がありません。</p>'}
        <p class="db-rank-note">募集継続・本人承諾・想定粗利益は未確認。確認後に重点営業へ昇格します。</p></section>
      <section class="db-rank-panel"><h3>企業別提案 TOP5 <small>棒：提案数／行内：面談到達。少数件数は参考</small></h3>
        ${companyRanks ? `<div>${companyRanks}</div>` : '<p class="empty">対象期間の企業実績なし</p>'}
        <p class="db-rank-note">同一企業IDで集計。少数データは参考値です。</p></section>
      <section class="db-rank-panel"><h3>担当者別提案 TOP5 <small>棒：提案数／行内：面談到達。実作業時間は未計測</small></h3>
        ${staffRanks ? `<div>${staffRanks}</div>` : '<p class="empty">対象期間の担当実績なし</p>'}
        <p class="db-rank-note">実行者記録を優先。登録担当との混在・少数データに注意。</p></section>
      </div>`;

    const sentByHour=m.sentByHour||[];
    const bins=[
      {label:"0〜8時",start:0,end:9},{label:"9〜11時",start:9,end:12},
      {label:"12〜14時",start:12,end:15},{label:"15〜17時",start:15,end:18},
      {label:"18〜23時",start:18,end:24}
    ].map(g=>({label:g.label,value:sentByHour.filter(h=>h.hour>=g.start&&h.hour<g.end)
      .reduce((sum,h)=>sum+Number(h.count||0),0)}));
    const funnel=[
      {label:"企業へ提案送信",value:m.proposalSentCount},
      {label:"面談に到達",value:m.meetingCohortCount},
      {label:"成約記録",value:m.wonCohortCount||0}
    ];
    const reasonParts=(m.lossReasons||[]).map(r=>({label:r.label,value:r.count}));
    const trend=visual?visual.line(m.dailyTrend||[],{title:"日別の提案送信と面談実施"}):'<p class="empty">日別データ未確認</p>';
    const funnelGraph=visual?visual.bars(funnel,{title:"送信提案コホート",maxRows:3}):bars(funnel.map(r=>({label:r.label,count:r.value})));
    const lossGraph=visual?visual.donut(reasonParts,{title:"期間内の失注・クローズ理由",centerLabel:"終了"}):bars(m.lossReasons||[]);
    const hoursGraph=visual?visual.bars(bins,{title:"送信した時間帯",maxRows:5}):bars(bins.map(r=>({label:r.label,count:r.value})));
    $("db-rankings-content").innerHTML = rankingMarkup;
    $("db-business-content").innerHTML = `
      <div class="db-kpis">${cards}</div>
      <div class="db-visual-grid">
        <section class="db-visual-card"><h3>日別の提案・面談の推移</h3><p>提案送信日と面談実施日（別のイベント）を比較します。</p>${trend}</section>
        <section class="db-visual-card"><h3>送信した提案の進行</h3><p>選択期間に送信した案件の現時点の到達状況。未面談でも失注確定とは限りません。</p>${funnelGraph}</section>
        <section class="db-visual-card"><h3>失注・クローズ理由</h3><p>対象期間中に終了した記録の内訳。提案全体の失注率ではありません。</p>${lossGraph}</section>
        <section class="db-visual-card"><h3>提案送信の時間帯</h3><p>JSTの送信件数。時間帯と返信・面談の因果関係は未判定です。</p>${hoursGraph}</section>
      </div>
      
      <details class="db-deep-dive"><summary>詳しい分析・履歴を見る（担当別・企業別・失注理由）</summary><div class="db-report-grid">
        ${roleMarkup}
        <details class="db-report-card full"><summary>提案送信者・日時の明細</summary><p class="empty">最新50件まで表示。JST。確定から送信までの経過時間は待機・休日も含み、実作業時間ではありません。</p>${tableMarkup([{label:"提案先"},{label:"担当・根拠"},{label:"送信日時"},{label:"経過時間",num:true},{label:"実作業時間"}],sentRows,"対象期間の提案送信はありません。")}</details>
        <details class="db-report-card full"><summary>提案先企業別（分母・面談率）</summary><p class="empty">提案件数順に100社まで表示。全件はCSVで確認できます。終了理由は当期間の送信コホートの現在記録です。会社IDが異なる記録は別集計です。</p>${tableMarkup([{label:"企業"},{label:"提案",num:true},{label:"面談到達",num:true},{label:"面談率",num:true},{label:"コホートの終了理由"},{label:"確認"}],companyRows,"対象期間の提案送信はありません。")}</details>
        <section class="db-report-card"><h3>課題</h3>${listMarkup(data.insights.issues)}</section>
        <section class="db-report-card"><h3>改善点</h3>${listMarkup(data.insights.improvements)}</section>
        <section class="db-report-card"><h3>次の行動</h3>${listMarkup(data.insights.actions)}</section>
        <section class="db-report-card"><h3>失注・クローズ理由<small>当期間 / 前期間 / 差</small></h3>${tableMarkup([{ label: "理由" }, { label: "当期間", num: true }, { label: "前期間", num: true }, { label: "差", num: true }], lossRows, "対象期間内の失注・クローズはありません。")}</section>
        <details class="db-report-card full"><summary>担当者別の記録を開く</summary><h3>担当者別<small>当期間 / 前期間。面談実施は実施日、面談率は期間内に送信した提案コホートです。担当はSalesの現在の担当に集約。当時の実行者・役割別ランキングではありません。少数の率だけで比較しないでください。</small></h3>${tableMarkup([{ label: "担当者" }, { label: "マッチング（当 / 前）", num: true }, { label: "提案送信（当 / 前）", num: true }, { label: "面談実施（当 / 前）", num: true }, { label: "コホート面談（当 / 前）", num: true }, { label: "面談率（当 / 前）", num: true }], ownerRows, "対象期間内の担当者別記録はありません。")}</details>
        <section class="db-report-card full"><h3>ブラスト限定候補<small>${esc(blastComparison)}。当期間内に15件以上提案し、当期間内送信コホートの面談実施が0件の企業。自動停止や配信登録は行いません。</small></h3>${tableMarkup([{ label: "企業" }, { label: "当期間の提案", num: true }, { label: "当期間の面談", num: true }, { label: "当期間の面談率", num: true }, { label: "前期間も候補" }], blastRows, "対象期間内に条件を満たす企業はありません。")}</section>
      </div></details>`;
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
    if (!Object.hasOwn(labels, key)) return;
    if (key === "custom") {
      const fromInput = $("db-period-from"), toInput = $("db-period-to");
      if (!fromInput.value || !toInput.value) {
        const bounds = boundsOf(state);
        fromInput.value = bounds.from;
        toInput.value = bounds.to;
      }
      customEditorOpen = true;
      $("db-period-range").hidden = false;
      showGlobalError("");
      return; // Do not change results before the calendar range is applied.
    }
    customEditorOpen = false;
    state = { key, from: "", to: "" };
    writeUrl(state);
    notifyPeriodChanged();
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
    updateGlobalPeriod();
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
        showGlobalError(error);
        return;
      }
      customEditorOpen = false;
      state = { key: "custom", from, to };
      writeUrl(state);
      notifyPeriodChanged();
    });
    $("db-business-csv").addEventListener("click", exportCsv);
    window.addEventListener("popstate", () => {
      const urlState = readUrl();
      const next = { key: urlState.key, from: urlState.from, to: urlState.to };
      if (state.key === next.key && state.from === next.from && state.to === next.to) return;
      state = next;
      customEditorOpen = false;
      $("db-period-from").value = state.from;
      $("db-period-to").value = state.to;
      $("db-period-to").min = state.from || "";
      notifyPeriodChanged(false);
    });
  }

  init();
  window.SalesDashboardReport = { load, getPeriod: () => state ? { ...state } : null };
})();
