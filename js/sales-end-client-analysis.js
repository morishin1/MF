// /sales/analytics.html の「エンド営業」タブ。集計API以外の生データをブラウザへ出さない。
window.SalesEndClientAnalysis = (() => {
  const root = () => document.getElementById("an-end-body");
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const number = (value) => Number.isSafeInteger(value) ? value.toLocaleString("ja-JP") : "—";
  let seq = 0;

  function card(title, value, note) {
    return '<div class="an-ec-card"><div class="an-ec-label">' + esc(title) + '</div>'
      + '<div class="an-ec-value">' + esc(value) + '</div>'
      + '<div class="an-ec-small">' + esc(note) + '</div></div>';
  }
  function section(title, subtitle, body) {
    return '<section class="an-ec-section"><div class="an-ec-heading">' + esc(title) + '</div>'
      + '<p class="an-ec-note">' + esc(subtitle) + '</p>' + body + '</section>';
  }
  function valueTable(items) {
    return '<div class="an-ec-table-wrap"><table class="sl-table an-ec-table">'
      + '<thead><tr><th>項目</th><th class="num">記録件数</th></tr></thead><tbody>'
      + items.map((row) => '<tr><td>' + esc(row[0]) + '</td><td class="num">' + esc(number(row[1])) + '</td></tr>').join("")
      + '</tbody></table></div>';
  }
  function bars(items, textKey, numberKey, noData) {
    const max = Math.max(1, ...items.map((x) => x[numberKey] || 0));
    if (!items.length) return '<div class="sl-empty">' + esc(noData || "集計対象がありません") + '</div>';
    return '<div class="an-ec-bars">' + items.map((x) => {
      const label = String(x[textKey] || "未分類");
      const count = Number(x[numberKey] || 0);
      const width = Math.min(100, Math.max(0, count / max * 100));
      return '<div class="an-ec-bar-row"><span>' + esc(label) + '</span>'
        + '<div class="an-ec-bar-track"><div class="an-ec-bar-fill" style="width:' + width.toFixed(1) + '%"></div></div>'
        + '<strong>' + esc(number(count)) + '</strong></div>';
    }).join("") + '</div>';
  }

  function render(data) {
    if (!data || data.version !== 1 || !data.inventory || !data.activity) {
      throw new Error("analysis_format_mismatch");
    }
    const inv = data.inventory;
    const act = data.activity;
    const contracts = data.contracts;
    const company = inv.endClients || {};
    const history = inv.proposalHistory || {};
    const period = data.periodSince + "〜" + data.asOfJst;
    const kpis = '<div class="an-ec-grid">'
      + card("エンド企業の登録フラグ", number(company.flaggedCount) + "社", "企業区分の登録値。エンド直取引の証明ではありません")
      + card("Sales営業先", number(act.salesTargets) + "社", "営業先マスターの登録総数")
      + card("即アサイン可能", number(inv.immediate) + "件", "人材の登録状態。最新の稼働・本人同意は未確認")
      + card("稼働契約台帳", contracts ? number(contracts.totalRecords) + "件" : "—",
        contracts ? "過去を含む契約記録。月次の実稼働・売上とは別" : "管理者権限のあるユーザーだけに表示")
      + '</div>';
    const activity = section("営業活動", "期間：" + period
      + "。送信・クリックは別日時の記録であり、クリック率には換算していません。",
      valueTable([
        ["Sales アタック送信", act.approachesSent],
        ["Sales クリック日時の記録", act.approachClicks],
        ["Sales 提案送信", act.proposalsSent],
        ["Sales 商談画面の開始セッション（実商談数ではない）", act.meetingScreenSessions],
      ]) + '<div class="an-ec-small">全期間のアプローチ登録は ' + esc(number(act.approachesTotal))
      + ' 件。実商談・有効案件・成約は、行動の証拠と契約台帳の紐付けが必要です。</div>');
    const supply = section("人材供給と案件", "現在の登録状態のスナップショット。複数職種・重複候補・稼働確認前の候補を含みます。",
      valueTable([
        ["人材登録総数", inv.registeredCandidates],
        ["削除・クローズされていない人材", inv.candidatesAvailable],
        ["「即アサイン可能」", inv.immediate],
        ["「提案可」", inv.proposable],
        ["スキルシートURLあり（非削除）", inv.candidateSheets],
        ["直近30日の人材情報メールあり（非削除）", inv.candidateSourceMail30],
        ["案件登録総数", inv.registeredJobs],
        ["削除・クローズされていない案件", inv.jobsNotClosed],
      ]) + '<div class="an-ec-subheading">主な登録職種</div>'
      + bars(inv.roles || [], "title", "count", "職種を集計できません")
      + '<p class="an-ec-note">この職種数は登録データの内訳であり、営業先へ確約できる人数ではありません。</p>');
    const losses = section("過去の提案・見送り理由", "ENGER提案履歴の全期間集計。失注の理由は入力文字列を分類した参考値です。",
      '<div class="an-ec-grid an-ec-grid-three">'
      + card("過去の提案記録", number(history.totalRecords) + "件", "削除されていないENGER提案")
      + card("見送り", number(history.rejectedRecords) + "件", "登録ステージ")
      + card("失注", number(history.lostRecords) + "件", "登録ステージ")
      + '</div><div class="an-ec-subheading">主な見送り・失注理由</div>'
      + bars(history.lossReasons || [], "label", "count", "見送り理由は未登録です"));
    const business = section("ENGER BUSINESSの利用記録", "登録・オファーは成約や請求を意味しません。",
      valueTable([
        ["企業ポータルの有効利用者", act.portalActiveMembers],
        ["企業からのオファー", act.portalOffers],
        ["企業からの案件・人材登録（審査状態を問わない）", act.portalSubmissions],
      ]));
    const finance = contracts
      ? section("成約・契約台帳の整備状況（管理者向け）",
        "ENGERは稼働契約記録、Salesは営業案件・成果報酬記録を管理。両者はまだ売上として統合されていません。",
        valueTable([
          ["ENGER契約記録（過去含む）", contracts.totalRecords],
          ["「稼働中」と登録されている契約", contracts.statusWorking],
          ["ENGER契約の会社名（表記ベースの重複除外）", contracts.companyNames],
          ["終了日未設定の契約", contracts.endDateMissing],
          ["提案IDが登録された契約", contracts.withProposalId],
          ["Sales受注案件台帳", contracts.salesDealRecords],
          ["Sales成約ステージ台帳", contracts.salesWonDealRecords],
          ["Sales成果報酬台帳", contracts.salesSuccessFeeRecords],
        ]) + '<p class="an-ec-note">Sales側が0件でも、ENGER事業の売上が0円とは判断できません。'
        + '実際の請求・入金・原価・契約証憑を確認して初めて売上・粗利益を算出できます。</p>')
      : '<section class="an-ec-section"><div class="an-ec-heading">契約・売上管理</div>'
        + '<p class="an-ec-note">契約台帳の集計は経営者・管理者権限で表示します。</p></section>';
    const quality = section("エンド企業データの精度", "「エンド企業」フラグと契約はまだ自動照合されていません。",
      valueTable([
        ["ENGERの登録企業（非削除）", inv.registeredCompanies],
        ["エンド企業フラグあり", company.flaggedCount],
        ["エンド企業フラグあり・業種の入力あり", company.industryKnown],
        ["エンド企業フラグあり・企業規模の入力あり", company.sizeKnown],
      ]) + '<p class="an-ec-note">エンド企業が29社登録されていても、29社の成約実績とは解釈しません。</p>');
    const notes = (data.notes || []).map((x) => '<li>' + esc(x) + '</li>').join("");
    root().innerHTML = '<p class="an-ec-status">集計日：' + esc(data.asOfJst)
      + ' ／ ソース：Sales・ENGER ／ 集計範囲：' + (data.scope === "manager" ? "管理者" : "営業担当") + '</p>'
      + kpis + activity + supply + losses + business + finance + quality
      + '<section class="an-ec-section"><div class="an-ec-heading">次の営業アクション</div>'
      + '<p class="an-ec-note">営業先リストをエンド企業に絞り込み、提案可能な人材の最新条件を確認してください。</p>'
      + '<div class="an-ec-links">'
      + '<a href="/sales/companies.html">営業先を確認</a>'
      + '<a href="/sales/proposals.html">提案管理を確認</a>'
      + '<a href="/sales/enger-progress.html?view=analysis">ENGER進捗を確認</a></div>'
      + '<div class="an-ec-subheading">集計時の注意</div><ul class="an-ec-caveats">' + notes + '</ul></section>';
  }

  async function load(days) {
    const mySeq = ++seq;
    const target = root();
    if (!target) return;
    target.innerHTML = '<div class="sl-empty">Sales・ENGERの記録を集計しています…</div>';
    try {
      const response = await API.api("/api/sales/end-client-analysis?days=" + encodeURIComponent(days));
      if (mySeq !== seq) return;
      render(response);
    } catch (error) {
      if (mySeq !== seq) return;
      const hint = error?.hint || error?.detail || (
        error?.code === "forbidden" ? "この分析はエイトのSales担当のみ閲覧できます。" : "集計データを取得できませんでした。"
      );
      root().innerHTML = '<div class="banner warn">' + esc(hint) + '</div>';
    }
  }
  return { load };
})();
