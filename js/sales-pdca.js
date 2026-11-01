// Sales売上改善PDCA: 読み取り専用。既存のSales分析APIと提案一覧を再利用し、架空数値を作らない。
window.SalesPDCA = (() => {
  const root = () => document.getElementById("sales-pdca");
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const num = (v) => Number(v ?? 0).toLocaleString("ja-JP");
  const percent = (v) => v == null || !Number.isFinite(Number(v)) ? "未取得" : `${Number(v).toFixed(1)}%`;
  let period = "last_30";
  let report = null;
  let proposals = null;
  let request = 0;
  const periodLabel = { last_7:"直近7日", last_30:"直近30日", this_month:"今月" };
  const link = (filter) => `/sales/proposals.html?filter=${encodeURIComponent(filter)}&sort=due`;
  const evidence = (key, text, value, label) => ({key, text, value, label});

  function pick(m, d) {
    const counts = d?.counts ?? null;
    const issues = [];
    if (counts && Number(counts.no_call) > 0) {
      issues.push({key:"no_call",name:"提案後の電話が未実施",count:Number(counts.no_call),
        basis:"現在のSales閲覧可能な提案で、送信記録があり電話記録がない件数（期間集計とは別）",
        next:"初回電話の結果を記録する",filter:"no_call",owner:"Sales / クロージング担当"});
    }
    if (counts && Number(counts.overdue) > 0) {
      issues.push({key:"overdue",name:"営業対応が期限超過",count:Number(counts.overdue),
        basis:"現在の提案タスクに期限超過がある件数。電話未実施と重複する可能性があります",
        next:"期限の古い提案から対応を確認",filter:"overdue",owner:"Sales / 営業担当"});
    }
    if (Number(m.unsubmittedMatchedCount) > 0) {
      issues.push({key:"proposal_wait",name:"マッチング確定後、企業へ未送信",count:Number(m.unsubmittedMatchedCount),
        basis:`${periodLabel[period]}に確定した提案のうち、現在も企業への送信日時がない件数`,
        next:"ENGERのマッチング担当へ送信状況を確認する",filter:"proposal_wait",owner:"ENGER / マッチング担当"});
    }
    if (m.proposalSentCount >= 10 && m.conversionRate != null && Number(m.conversionRate) < 10) {
      issues.push({key:"meeting",name:"提案から面談への転換率が10%未満",count:null,
        basis:`${periodLabel[period]}に企業へ送信した${num(m.proposalSentCount)}件のうち、現時点で面談実施に到達したのは${num(m.meetingCohortCount)}件（${percent(m.conversionRate)}）`,
        next:"企業別の見送り理由・提案条件を確認する",filter:"open",owner:"管理者 / マッチング・Sales"});
    }
    if ((m.blastCompanies || []).length) {
      issues.push({key:"blast",name:"15提案・面談0の企業がある",count:m.blastCompanies.length,
        basis:`${periodLabel[period]}の送信コホートで15件以上提案・面談実施0件。新規提案を自動停止する判定ではありません`,
        next:"企業ごとの根拠を確認して継続方針を決める",filter:"all",owner:"Sales / 管理者"});
    }
    return issues;
  }

  function render() {
    const target = root();
    if (!target) return;
    const selected = `<div class="pdca-periods" role="group" aria-label="改善対象期間">
      ${Object.keys(periodLabel).map(k=>`<button type="button" data-period="${k}" aria-pressed="${String(period===k)}">${periodLabel[k]}</button>`).join("")}</div>`;
    if (!report) { target.innerHTML = `<h2>売上改善・PDCA</h2>${selected}<p class="sl-muted">実績と課題を確認しています…</p>`; return; }
    const m = report.metrics || {}, prev = report.previousMetrics || {};
    const issues = pick(m, proposals);
    const main = issues[0];
    const hasProposals = Boolean(proposals);
    const sync = report.dataStatus?.note ? `<p class="pdca-note">${esc(report.dataStatus.note)}</p>` : "";
    const title = main ? main.name : hasProposals ? "現在の記録から優先課題は検出されませんでした" : "提案一覧の状態は未取得";
    const action = main
      ? `<a class="pdca-action" href="${link(main.filter)}">対象の提案を表示 → 営業対応</a>`
      : `<a class="pdca-action" href="/sales/">営業ダッシュボードを開く</a>`;
    const proof = [
      evidence("sent","提案送信",m.proposalSentCount,"期間内の送信日時で集計"),
      evidence("meet","面談到達",m.meetingCohortCount,"送信コホートの実施記録"),
      evidence("rate","提案→面談率",percent(m.conversionRate),"目標10%（母数10件未満は参考）"),
    ];
    const proofHtml = proof.map(x=>`<div class="pdca-proof"><b>${esc(x.text)}</b><strong>${x.key==="rate"?esc(x.value):num(x.value)}${x.key==="rate"?"":"件"}</strong><small>${esc(x.label)}</small></div>`).join("");
    const other = issues.length>1
      ? `<details class="pdca-others"><summary>その他の要確認 ${issues.length-1}件</summary><ul>${issues.slice(1).map(x=>`<li><a href="${link(x.filter)}">${esc(x.name)}${x.count==null?"":`（${num(x.count)}件）`}</a><span>${esc(x.basis)}</span></li>`).join("")}</ul></details>`
      : "";
    target.innerHTML = `<div class="pdca-head"><div><h2>売上改善・PDCA</h2><p>課題 → 根拠 → 営業対応 → 成果検証を同じ記録から確認</p></div>${selected}</div>
      ${sync}
      <div class="pdca-flow">
        <section><span class="pdca-step">01 課題発見</span><h3>${esc(title)}</h3>
          <p>${main && main.count!==null ? `対象 ${num(main.count)}件。` : ""}${main ? esc(main.owner) : "既存データを確認してください"}</p></section>
        <section><span class="pdca-step">02 根拠確認</span>
          <p>${main?esc(main.basis):"データのない工程は0件と断定しません。"}</p>
          <div class="pdca-proofs">${proofHtml}</div></section>
        <section><span class="pdca-step">03 営業対応</span><h3>${main?esc(main.next):"対応一覧を確認"}</h3>
          <p>作業と結果の記録はダッシュボード側で行います。</p>${action}</section>
        <section><span class="pdca-step">04 成果検証</span>
          <div class="pdca-outcome">${percent(prev.conversionRate)} <span>→</span> <strong>${percent(m.conversionRate)}</strong></div>
          <p>前の同日数期間と比較（提案→面談率）。改善施策の因果効果を証明する値ではありません。</p></section>
      </div>${other}
      <p class="pdca-note">データの定義：送信・面談はSalesの実記録。電話未実施と期限超過は現在の提案一覧（${hasProposals?"取得済み":"未取得"}）で、上の期間集計とは分母が異なります。${proposals?.truncated?" 提案一覧は2,000件上限のため一部のみです。":""}</p>`;
    target.querySelectorAll("[data-period]").forEach(b=>b.addEventListener("click",()=>load(b.dataset.period)));
  }

  async function load(nextPeriod = period) {
    if (!Object.hasOwn(periodLabel,nextPeriod)) nextPeriod="last_30";
    period=nextPeriod;
    const id=++request;
    report=null;
    render();
    try {
      const result=await API.api("/api/sales/dashboard-analysis?period="+encodeURIComponent(period));
      if(id!==request)return;
      report=result;
      render();
    } catch(err) {
      if(id!==request)return;
      const node=root();
      if(node)node.innerHTML=`<h2>売上改善・PDCA</h2><div class="pdca-error" role="alert">分析データを取得できません：${esc(err.hint||err.detail||err.message||"権限・接続状態を確認してください")}</div>`;
    }
  }

  function observeProposals(data) {
    // 提案一覧APIが取得した認可済みsnapshotを共有し、二重APIコールを避ける。
    proposals=data && Array.isArray(data.proposals) ? data : null;
    if(report)render();
  }

  return {load,observeProposals};
})();
