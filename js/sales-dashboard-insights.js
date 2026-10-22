// /sales ホーム専用。読み取り専用の提案分析を描画する（外部チャートライブラリ不要）。
(function () {
  "use strict";
  const el = (id) => document.getElementById(id);
  const esc = (s) => SalesLayout.esc(String(s == null ? "" : s));
  const num = (n) => Number(n || 0).toLocaleString("ja-JP");
  const pct = (n) => n == null ? "—" : Number(n).toFixed(1) + "%";
  const width = (n, base) => base ? Math.max(0, Math.min(100, Math.round(1000 * n / base) / 10)) : 0;
  let days = 30;
  let role = "proposal";
  let metrics = null;
  let sequence = 0;
  const roles = { proposal: "提案担当", cs: "CS担当", closing: "クロージング担当" };
  const stageNames = [
    ["matched", "起票"], ["sent", "提案送信"], ["called", "電話記録"], ["meeting", "面談に進展"],
    ["cs", "CS引継ぎ"], ["closing", "クロージング"], ["won", "成約"]
  ];

  function periodControls() {
    el("metrics-period").innerHTML = [30, 90, 365].map((n) =>
      '<button type="button" class="' + (days === n ? 'on' : '') + '" aria-pressed="' + (days === n) +
      '" onclick="SalesInsights.changePeriod(' + n + ')">' + (n === 365 ? "1年" : n + "日") + '</button>'
    ).join("");
  }
  function card(label, value, detail, accent) {
    return '<div class="db-kpi' + (accent ? ' main' : '') + '"><div class="label">' + esc(label) +
      '</div><div class="num">' + num(value) + '</div><div class="small">' + esc(detail) + '</div></div>';
  }
  function progress(name, n, base, suffix) {
    return '<div class="db-step"><span>' + esc(name) + '</span><div class="db-track"><div class="db-bar" style="width:' +
      width(n, base) + '%"></div></div><strong>' + (suffix === "rate" ? pct(base ? 100 * n / base : null) : num(n) + "件") + '</strong></div>';
  }
  function trendHtml(trend) {
    const max = Math.max(1, ...(trend || []).map((x) => Number(x.matched) || 0));
    const series = [["matched", "#aebacf", "起票"], ["sent", "#5273af", "提案"], ["won", "#3e957a", "成約"]];
    return '<div class="db-trend" role="img" aria-label="起票・提案送信・成約の起票日別棒グラフ">' +
      (trend || []).map((b) => '<div class="db-trend-col"><div class="db-trend-pins">' + series.map((s) => {
        const value = Number(b[s[0]] || 0);
        const h = value ? Math.max(3, Math.round(100 * value / max)) : 0;
        return '<i style="height:' + h + 'px;background:' + s[1] + '" title="' +
          esc(b.label + " " + s[2] + " " + value + "件") + '"></i>';
      }).join("") + '</div><small>' + esc(b.label) + '</small></div>').join("") +
      '</div><div class="db-legend">' + series.map((s) =>
        '<span><i style="background:' + s[1] + '"></i>' + esc(s[2]) + '</span>').join("") + '</div>';
  }
  function reasonsHtml(reasons, total) {
    if (!reasons || !reasons.length) return '<div class="sl-empty">失注・見送りはまだありません。</div>';
    return reasons.map((r) => '<div class="db-loss"><span>' + esc(r.label) +
      '</span><div class="db-track"><div class="db-bar" style="width:' + width(r.count, total) +
      '%"></div></div><strong>' + num(r.count) + '</strong></div>').join("");
  }
  function roleHtml() {
    if (!metrics) return;
    const tabs = el("role-tabs");
    const body = el("role-body");
    if (!tabs || !body) return;
    tabs.innerHTML = Object.keys(roles).map((key) =>
      '<button type="button" class="' + (role === key ? 'on' : '') + '" aria-pressed="' + (role === key) +
      '" onclick="SalesInsights.changeRole(\'' + key + '\')">' + roles[key] + '</button>'
    ).join("");
    const items = (metrics.roles && metrics.roles[role]) || [];
    const goal = role === "proposal" ? ["sent", "提案送信"] : role === "cs" ?
      ["closing", "クロージング移行"] : ["won", "成約"];
    const explanation = role === "proposal"
      ? "送信行動の実施者を優先し、記録がない案件は起点担当（ENGER等）を暫定表示します。"
      : role === "cs" ? "正式に登録されたCS担当者の案件を集計します。"
      : "正式に登録されたクロージング担当者の案件を集計します。";
    if (!items.length) {
      body.innerHTML = '<p class="db-insight-note">' + explanation + '</p><div class="sl-empty">対象の担当記録はありません。</div>';
      return;
    }
    body.innerHTML = '<p class="db-insight-note">' + explanation + ' 未割当は「担当未登録」で表示します。</p>' +
      '<div class="db-role-table"><table class="sl-table"><thead><tr><th>担当者</th><th class="num">対象</th>' +
      '<th class="num">' + goal[1] + '</th><th class="num">成約</th><th class="num">失注</th><th class="num">成約率</th></tr></thead><tbody>' +
      items.map((r) => '<tr><td><b>' + esc(r.name) + '</b></td><td class="num">' + num(r.total) +
        '</td><td class="num">' + num(r[goal[0]]) + '</td><td class="num">' + num(r.won) +
        '</td><td class="num">' + num(r.lost) + '</td><td class="num">' +
        (r.total < 10 ? '<small title="10件未満のため傾向判断には不十分">参考 </small>' : '') +
        pct(r.winRate) + '</td></tr>').join("") + '</tbody></table></div>';
  }
  function render() {
    if (!metrics) return;
    const d = metrics, c = d.counts || {}, root = el("insights");
    const warnings = [d.notice, d.activityTruncated ? "活動の取得上限に達しました。電話・面談件数は参考値です。" : null]
      .filter(Boolean).map((s) => '<div class="banner warn" style="margin-bottom:10px;">' +
        '<span class="material-symbols-outlined">warning</span><div>' + esc(s) + '</div></div>').join("");
    const rates = [
      ["起票→提案送信", c.sent, c.matched],
      ["提案送信→CS引継ぎ", c.cs, c.sent],
      ["提案送信→クロージング", c.closing, c.sent],
      ["提案送信→成約", c.won, c.sent]
    ];
    root.innerHTML = warnings + '<div class="db-kpis">' +
      card("起票", c.matched, "マッチング・手動登録") +
      card("提案送信", c.sent, "起票から " + pct(c.sentRate)) +
      card("CS引継ぎ", c.cs, "正式な引継ぎ") +
      card("クロージング", c.closing, "提案から " + pct(c.closingRate), true) +
      card("成約", c.won, "提案から " + pct(c.winRate), true) +
      card("失注・終了", c.lost, "理由を分析") + '</div>' +
      '<p class="db-insight-note">対象：' + esc(d.since) +
      '〜今日に起票された提案（1提案＝1件）。その後の到達・成約を追跡。営業担当に関係なく過去工程を自動で補完しません。</p>' +
      '<div class="db-charts"><section class="db-chart"><h3>提案 → クロージングの到達</h3>' +
      '<p class="db-insight-note">起票件数を分母にした到達数（別工程として独立集計）</p>' +
      stageNames.map((a) => progress(a[1], c[a[0]] || 0, c.matched)).join("") +
      '<a href="/sales/proposals.html" style="font-size:12px;">提案一覧で確認する →</a></section>' +
      '<section class="db-chart"><h3>提案数・成約の推移</h3>' +
      '<p class="db-insight-note">起票時期別に、現在どこまで進んだかを比較</p>' +
      trendHtml(d.trend) + '</section></div>' +
      '<div class="db-charts"><section class="db-chart"><h3>失注・見送り理由</h3>' +
      '<p class="db-insight-note">見送り・連絡停止・無回答クローズの内訳（' + num(c.lost) + '件）</p>' +
      reasonsHtml(d.reasons, c.lost) + '</section>' +
      '<section class="db-chart"><h3>工程別の転換率</h3><p class="db-insight-note">提案送信を分母に、引継ぎ・成約の進展を確認</p>' +
      rates.map((x) => progress(x[0], x[1] || 0, x[2] || 0, "rate")).join("") +
      '<p class="db-insight-note">10件未満の母数の率は参考値です。引継ぎを経ずに成約した案件も独立して数えます。</p>' +
      '</section></div>' +
      '<section class="db-chart" style="margin-bottom:24px;"><h3>担当者別｜どこまで進めたか</h3>' +
      '<p class="db-insight-note">提案担当・CS・クロージング担当を分け、引継ぎによる担当変更後も役割別に計測します。</p>' +
      '<div class="db-role-tabs" id="role-tabs" role="group" aria-label="役割別の集計"></div>' +
      '<div id="role-body"></div></section>';
    roleHtml();
  }
  async function load() {
    const n = ++sequence;
    periodControls();
    const target = el("insights");
    if (!target) return;
    target.innerHTML = '<div class="sl-empty">提案の集計を読み込み中…</div>';
    try {
      const data = await API.api("/api/sales/proposals/metrics?days=" + days);
      if (n !== sequence) return;
      if (data.notReady) throw new Error(data.message || "提案DBが未設定です");
      metrics = data;
      render();
    } catch (e) {
      if (n !== sequence) return;
      metrics = null;
      target.innerHTML = '<div class="banner warn"><span class="material-symbols-outlined">info</span><div>' +
        '提案の分析を表示できません。今日の対応は引き続き使えます。' +
        esc(e.hint || e.detail || e.message || "") + ' <a href="/sales/proposals.html">提案管理を確認する</a></div></div>';
    }
  }
  window.SalesInsights = {
    load,
    changePeriod(n) { if (![30,90,365].includes(n)) return; days = n; load(); },
    changeRole(key) { if (!Object.hasOwn(roles,key)) return; role = key; roleHtml(); }
  };
})();
