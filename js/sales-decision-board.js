// Sales judgment board: analysis/decision only, no execution or DB writes.
(() => {
  const root=document.getElementById('db-decision-board');
  if(!root)return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>Number(v||0).toLocaleString('ja-JP');
  const OPEN='https://dx.enger.jp/workboard';
  let loading=false,done=false;
  function draw(data) {
    const m=data.metrics||{};
    const kpis=[
      ['進行中の提案記録',m.openCases,'Salesに同期済み'],
      ['提案前の確認候補',m.proposalToVerify,'需要・人材・採算を確認'],
      ['連絡・回答状況の確認',m.contactToInspect,'未返信の原因を分析'],
      ['面談・結果の確認',m.interviewToInspect,'面談から成約への進行確認']
    ].map(x=>'<div class="db-decision-kpi"><small>'+esc(x[0])+'</small><strong>'+esc(num(x[1]))+
      (data.partial?'<span>件以上</span>':'<span>件</span>')+'</strong><span>'+esc(x[2])+'</span></div>').join('');
    const outstanding=Math.max(0,Number(m.openCases||0)-Number(m.proposalToVerify||0)-
      Number(m.contactToInspect||0)-Number(m.interviewToInspect||0));
    const stages=[
      {label:"提案前の条件確認",value:m.proposalToVerify||0},
      {label:"連絡・回答を確認",value:m.contactToInspect||0},
      {label:"面談・結果を確認",value:m.interviewToInspect||0},
      {label:"その他の進行中",value:outstanding}
    ];
    const statusGraph=window.SalesVisuals?
      '<section class="db-visual-card" style="margin-bottom:12px"><h3>進行中の案件はどこで止まっているか</h3>'+
      '<p>棒はSalesに同期された進行段階の件数。面談や成約の実績を示すものではありません。</p>'+
      window.SalesVisuals.bars(stages,{title:"Sales進行中案件の現在段階",maxRows:4})+'</section>':"";
    const cases=(data.priority||[]).map(c=>{
      const link=c.sourceProposalId && /^[0-9a-f-]{36}$/i.test(c.sourceProposalId)
        ? 'https://dx.enger.jp/proposals/'+encodeURIComponent(c.sourceProposalId) : OPEN;
      return '<div class="db-decision-item"><div><strong>'+esc(c.title)+'</strong>'+
        '<small>'+esc(c.companyName)+' ／ '+esc(c.statusLabel)+(c.hasRegisteredOwner?' ／ 担当設定あり':' ／ 担当記録未確認')+'</small>'+
        '<div class="db-decision-gates">需要：未確認 ／ 人材：未確認 ／ 採算：未確認</div></div>'+
        '<a href="'+link+'" rel="noopener noreferrer">ENGERで確認</a></div>';
    }).join('');
    const note='「未確認」はSalesに判定根拠が連携されていない意味であり、ENGER側で確認済みの可能性があります。'+
      '「勝てる案件」や利益の確定ランキングではありません。';
    root.innerHTML=
      '<div class="db-decision-kpis">'+kpis+'</div>'+statusGraph+
      (data.partial?'<p class="db-decision-error">取得上限に達しました。件数は一部のみです。詳細は成果分析を確認してください。</p>':'')+
      '<div class="db-decision-grid"><section class="db-decision-card"><h3>★ 条件確認を優先する案件</h3>'+
      '<p class="desc">未提案・面談調整など、進行状態から抽出した暫定5件。実際の提案は3つの条件が揃ってから。</p>'+
      (cases||'<p class="sl-empty">対象の進行案件がありません。同期状態も確認してください。</p>')+
      '<p class="db-decision-foot">'+esc(note)+'</p></section>'+
      '<section class="db-decision-card"><h3>営業判断のチェックポイント</h3>'+
      '<p class="desc">この順序で案件・企業の優先順位を決めます。</p>'+
      '<div class="db-judge-step"><span>1</span><div><b>発注意思・予算の確認</b><p>募集継続・決裁者・参画時期を確認し、需要がある案件を選ぶ。</p></div></div>'+
      '<div class="db-judge-step"><span>2</span><div><b>提案可能人材の確認</b><p>スキルだけでなく、所属確認・稼働時期・単価・提案承諾を確認する。</p></div></div>'+
      '<div class="db-judge-step"><span>3</span><div><b>利益・企業実績の確認</b><p>原価・営業工数・面談化率・失注理由を見て重点先を決める。</p></div></div>'+
      '<button type="button" id="db-judge-company" class="btn btn-secondary btn-sm" style="margin-top:9px">企業別の判断を見る</button>'+
      '<p class="db-decision-foot">進行中の電話・メール・アタックを行う場所は ENG​​ER です。</p></section></div>'+
      '<p class="db-decision-foot">集計範囲：'+esc(data.note||'Salesに保存された記録')+' ／ 更新：'+
      esc(new Date(data.updatedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}))+'（JST）</p>';
  }
  async function load() {
    if(loading||done)return;
    loading=true;
    root.innerHTML='<p class="sl-empty">Salesの進行案件を確認中…</p>';
    try {
      const data=await window.API.api('/api/sales/decision-brief');
      draw(data);done=true;
    } catch(e){
      root.innerHTML='<div class="db-decision-error">'+esc(e?.hint||e?.data?.hint||'営業判断の記録を読み込めませんでした。権限・同期を確認してください。')+
        ' <button type="button" id="db-judge-retry" class="btn btn-sm btn-secondary">再取得</button></div>';
    } finally {loading=false;}
  }
  root.addEventListener('click',e=>{
    if(e.target.closest?.('#db-judge-company'))window.SalesDashboardTabs?.selectView('company');
    if(e.target.closest?.('#db-judge-retry'))load();
  });
  window.SalesDecisionBoard={ready:load};
})();