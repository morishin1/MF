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
  const phases = { issue:"課題", evidence:"根拠", action:"営業対応", result:"成果検証" };
  const fromQuery = new URLSearchParams(window.location?.search || "").get("step");
  const phase = Object.hasOwn(phases,fromQuery) ? fromQuery : "issue";
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
    const pageTitle = document.getElementById("an-main-title");
    if (pageTitle) pageTitle.textContent = phases[phase];
    const selected = `<div class="pdca-periods" role="group" aria-label="分析期間">
      ${Object.keys(periodLabel).map(k=>`<button type="button" data-period="${k}" aria-pressed="${String(period===k)}">${periodLabel[k]}</button>`).join("")}</div>`;
    if (!report) {
      target.innerHTML = `<div class="pdca-head"><h2>${phases[phase]}</h2>${selected}</div><p class="sl-muted">集計中…</p>`;
      return;
    }
    const m = report.metrics || {}, prev = report.previousMetrics || {};
    const issues = pick(m, proposals);
    const main = issues[0];
    const hasProposals = Boolean(proposals);
    const callKpi = proposals?.kpi?.total || null;
    const callPeriod = proposals?.kpi?.days || 365;
    const callEvidence = callKpi
      ? `<p class="pdca-note">電話実施率 ${percent(callKpi.callRate)}（${num(callKpi.called)}/${num(callKpi.callBase)}件）・期限内率 ${percent(callKpi.onTimeRate)}（${num(callKpi.onTime)}/${num(callKpi.onTimeBase)}件）。電話は別集計の直近${num(callPeriod)}日。</p>`
      : "";
    const sync = report.dataStatus?.note ? `<p class="pdca-note">${esc(report.dataStatus.note)}</p>` : "";
    const proof = [
      evidence("sent","提案送信",m.proposalSentCount,"送信日時を基準"),
      evidence("meet","面談実施到達",m.meetingCohortCount,"送信コホートの記録"),
      evidence("rate","提案→面談率",percent(m.conversionRate),"目標10%"),
    ];
    const proofHtml = proof.map(x=>`<div class="pdca-proof"><b>${esc(x.text)}</b><strong>${x.key==="rate"?esc(x.value):num(x.value)}${x.key==="rate"?"":"件"}</strong><small>${esc(x.label)}</small></div>`).join("");
    const nextPhase = {issue:"evidence",evidence:"action",action:"result",result:"issue"};
    const nextLabel = {issue:"根拠を確認",evidence:"営業対応へ",action:"成果を検証",result:"課題へ戻る"};
    let body;
    if (phase === "issue") {
      const items = issues.length ? issues.slice(0,5).map((x,i)=>
        `<div class="pdca-item"><span class="pdca-rank">${i+1}</span><div><b>${esc(x.name)}</b><p>${x.count==null?"":num(x.count)+"件 · "}${esc(x.owner)}</p></div>
          <a href="/sales/analytics.html?step=evidence">根拠</a></div>`).join("")
        : `<p class="pdca-note">${hasProposals ? "現在の記録では指定した検出条件に一致する課題はありません。" : "提案一覧を取得できていません。課題なしとは判断できません。"}</p>`;
      body = `<section class="pdca-panel"><h3>優先して確認する課題</h3>${items}</section>`;
    } else if (phase === "evidence") {
      body = `<section class="pdca-panel"><h3>${main?esc(main.name):"分析根拠"}</h3>
        <p>${main?esc(main.basis):"検出した課題がない場合も実績を確認できます。"}</p>
        <div class="pdca-proofs">${proofHtml}</div>${callEvidence}
        <a class="pdca-inline-link" href="/sales/analytics.html?step=action">対応方法を確認</a></section>`;
    } else if (phase === "action") {
      const items = issues.length ? issues.slice(0,4).map(x=>
        `<div class="pdca-item"><div><b>${esc(x.next)}</b><p>${esc(x.owner)} / ${esc(x.name)}</p></div>
          <a href="${link(x.filter)}">対象を開く</a></div>`).join("")
        : `<div class="pdca-item"><b>営業ダッシュボードを確認</b><a href="/sales/">対応一覧</a></div>`;
      body = `<section class="pdca-panel"><h3>改善アクション</h3>${items}
        <p class="pdca-note">電話・メール・面談はダッシュボードの提案詳細で記録します。</p></section>`;
    } else {
      body = `<section class="pdca-panel"><h3>提案→面談率の比較</h3>
        <div class="pdca-outcome">${percent(prev.conversionRate)} <span>→</span> <strong>${percent(m.conversionRate)}</strong></div>
        <div class="pdca-proofs">${proofHtml}</div>
        <p class="pdca-note">比較対象：直前の同日数期間。施策を行った因果効果や売上・粗利は、この比較だけでは確定できません。</p></section>`;
    }
    target.innerHTML=`<div class="pdca-head"><div><h2>${phases[phase]}</h2></div>${selected}</div>
      ${sync}${body}
      <div class="pdca-bottom"><a class="pdca-action" href="/sales/analytics.html?step=${nextPhase[phase]}">${nextLabel[phase]}</a></div>
      <p class="pdca-note">提案・面談はSalesの記録。未架電・期限超過は現在の提案一覧で、期間集計とは母数が異なります。${proposals?.truncated?" 最新2,000件上限のため一部です。":""}</p>`;
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
