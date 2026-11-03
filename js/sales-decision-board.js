// Sales judgment dashboard. The period KPI and its drilldown share one authenticated API.
(() => {
  const root=document.getElementById('db-decision-board');
  if(!root)return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
  const num=v=>Number(v||0).toLocaleString('ja-JP');
  const OPEN='https://dx.enger.jp/workboard';
  const groups=[
    ['openCases','期間内に更新された進行中の提案','Sales同期済み・現在も進行中'],
    ['proposalToVerify','提案前の確認候補','需要・人材・採算を確認'],
    ['contactToInspect','連絡・回答状況の確認','未返信の原因を分析'],
    ['interviewToInspect','面談・結果の確認','面談から成約への進行確認'],
  ];
  let loading=false,done=false,authorized=false,version=0,modalVersion=0,modalMetric='',modalPage=1;
  const period=()=>window.SalesDashboardReport?.getPeriod?.()||null;
  const query=(metric='',page=1)=>{
    const selected=period();
    if(!selected)return '/api/sales/decision-brief';
    const q=new URLSearchParams({period:selected.key});
    if(selected.key==='custom'){q.set('from',selected.from);q.set('to',selected.to);}
    if(metric){q.set('metric',metric);q.set('page',String(page));}
    return '/api/sales/decision-brief?'+q.toString();
  };
  const formatDate=v=>{const t=Date.parse(v||'');return Number.isFinite(t)?new Date(t).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'—';};
  function closeModal(){
    modalVersion++;modalMetric='';
    document.getElementById('db-decision-modal')?.remove();
    document.getElementById('db-decision-return')?.focus?.();
  }
  function modalShell(){
    let el=document.getElementById('db-decision-modal');
    if(!el){el=document.createElement('div');el.id='db-decision-modal';document.body.appendChild(el);}
    return el;
  }
  async function openMetric(metric,page=1){
    const label=groups.find(g=>g[0]===metric)?.[1];if(!label)return;
    const reqId=++modalVersion;modalMetric=metric;modalPage=page;
    const modal=modalShell();
    modal.innerHTML='<div class="db-metric-bg" data-close-metric></div><section class="db-metric-dialog" role="dialog" aria-modal="true" tabindex="-1" aria-label="'+esc(label)+'">'+
      '<header><h2>'+esc(label)+'</h2><button type="button" class="btn btn-secondary btn-sm" data-close-metric>閉じる</button></header>'+
      '<div id="db-metric-body" aria-live="polite">選択期間の案件を取得中…</div></section>';
    modal.querySelector('.db-metric-dialog')?.focus();
    try {
      const data=await window.API.api(query(metric,page));if(reqId!==modalVersion)return;
      const body=document.getElementById('db-metric-body');
      if(!body)return;
      const records=(data.rows||[]).map(r=>{
        const link=r.sourceProposalId&&/^[0-9a-f-]{36}$/i.test(r.sourceProposalId)
          ?'https://dx.enger.jp/proposals/'+encodeURIComponent(r.sourceProposalId)
          :'/sales/proposals.html';
        return '<tr><td>'+esc(formatDate(r.updatedAt))+'</td><td><strong>'+esc(r.companyName)+'</strong><small>'+esc(r.title)+'</small></td>'+
          '<td>'+esc(r.statusLabel)+'</td><td><a href="'+link+'" rel="noopener noreferrer" target="_blank">確認</a></td></tr>';
      }).join('');
      const total=Number(data.total)||0,limit=Number(data.pageSize)||100;
      body.innerHTML='<p class="db-metric-note">対象：'+esc(data.period?.from||'—')+'〜'+esc(data.period?.to||'—')+
        '（JST）／'+num(total)+'件。<strong>同じ期間・同じ状態</strong>で集計しています。過去時点の状態復元ではありません。</p>'+
        '<div class="db-metric-table"><table class="sl-table"><thead><tr><th>最終更新</th><th>企業・案件</th><th>進行状況</th><th>詳細</th></tr></thead>'+
        '<tbody>'+ (records||'<tr><td colspan="4">対象の案件はありません。</td></tr>')+'</tbody></table></div>'+
        '<div class="db-metric-pager"><span>'+num(total?((page-1)*limit+1):0)+'〜'+num(Math.min(total,page*limit))+
        ' / '+num(total)+'件</span><button class="btn btn-secondary btn-sm" data-metric-page="'+(page-1)+'" '+(page<=1?'disabled':'')+'>前へ</button>'+
        '<button class="btn btn-secondary btn-sm" data-metric-page="'+(page+1)+'" '+(page*limit>=total?'disabled':'')+'>次へ</button></div>';
    }catch(e){
      if(reqId===modalVersion){
        const body=document.getElementById('db-metric-body');
        if(body)body.textContent=e?.hint||'明細の取得に失敗しました。期間と閲覧権限をご確認ください。';
      }
    }
  }
  function draw(data){
    const m=data.metrics||{};
    const kpis=groups.map(x=>'<button type="button" class="db-decision-kpi" data-metric="'+x[0]+'" aria-label="'+esc(x[1])+' '+num(m[x[0]])+'件の明細を開く">'+
      '<small>'+esc(x[1])+'</small><strong>'+esc(num(m[x[0]]))+'</strong><span>件</span>'+
      '<span class="db-metric-action">'+esc(x[2])+' ／ 一覧を見る ›</span></button>').join('');
    const outstanding=Math.max(0,Number(m.openCases||0)-Number(m.proposalToVerify||0)-Number(m.contactToInspect||0)-Number(m.interviewToInspect||0));
    const stages=[
      {label:'提案前の条件確認',value:m.proposalToVerify||0},
      {label:'連絡・回答を確認',value:m.contactToInspect||0},
      {label:'面談・結果を確認',value:m.interviewToInspect||0},
      {label:'その他の進行中',value:outstanding},
    ];
    const chart=window.SalesVisuals?
      '<section class="db-visual-card" style="margin-bottom:12px"><h3>選択期間に更新された案件の現在段階</h3>'+
      '<p>Salesの更新履歴と現在状態から抽出。過去時点の状態を復元したものではありません。</p>'+
      window.SalesVisuals.bars(stages,{title:'期間内更新案件の現在段階',maxRows:4})+'</section>':'';
    const cases=(data.priority||[]).map(c=>{
      const link=c.sourceProposalId&&/^[0-9a-f-]{36}$/i.test(c.sourceProposalId)
        ?'https://dx.enger.jp/proposals/'+encodeURIComponent(c.sourceProposalId):OPEN;
      return '<div class="db-decision-item"><div><strong>'+esc(c.title)+'</strong>'+
        '<small>'+esc(c.companyName)+' ／ '+esc(c.statusLabel)+(c.hasRegisteredOwner?' ／ 担当設定あり':' ／ 担当記録未確認')+'</small>'+
        '<div class="db-decision-gates">需要：未確認 ／ 人材：未確認 ／ 採算：未確認</div></div>'+
        '<a href="'+link+'" rel="noopener noreferrer">ENGERで確認</a></div>';
    }).join('');
    root.innerHTML='<div class="db-decision-kpis">'+kpis+'</div>'+
      '<p class="db-decision-foot">集計：'+esc(data.period?.from||'—')+'〜'+esc(data.period?.to||'—')+
      ' JST。件数カードをクリックすると、同じ条件の全明細を確認できます（100件ずつ）。</p>'+
      chart+
      (data.partial?'<p class="db-decision-error">優先候補の表示は一部の提案から抽出しています。件数と明細は期間別に確認してください。</p>':'')+
      '<div class="db-decision-grid"><section class="db-decision-card"><h3>★ 確認を優先する案件</h3>'+
      '<p class="desc">進行段階から抽出した暫定5件。提案前に募集継続、本人承諾と採算を照合してください。</p>'+
      (cases||'<p class="sl-empty">この期間に更新された進行案件はありません。</p>')+
      '<p class="db-decision-foot">「勝てる案件」や利益の確定ランキングではありません。</p></section>'+
      '<section class="db-decision-card"><h3>営業判断のチェックポイント</h3>'+
      '<div class="db-judge-step"><span>1</span><div><b>発注意思・予算の確認</b><p>募集継続・決裁者・参画時期を確認。</p></div></div>'+
      '<div class="db-judge-step"><span>2</span><div><b>提案可能人材の確認</b><p>所属・稼働時期・単価・本人承諾を確認。</p></div></div>'+
      '<div class="db-judge-step"><span>3</span><div><b>利益・企業実績の確認</b><p>粗利、面談率、失注理由を確認して注力先を選ぶ。</p></div></div>'+
      '<button type="button" id="db-judge-company" class="btn btn-secondary btn-sm" style="margin-top:9px">企業の掘り起こし・評価へ</button>'+
      '<p class="db-decision-foot">提案・電話・面談調整の実行はENGERの案件進行カードへ。</p></section></div>'+
      '<p class="db-decision-foot">集計範囲：'+esc(data.note||'Sales記録')+
      ' ／ 更新：'+esc(formatDate(data.updatedAt))+' JST</p>';
  }
  async function load(){
    if(loading||done)return;
    const ticket=++version;loading=true;
    root.innerHTML='<p class="sl-empty">選択期間の進行案件を確認中…</p>';
    try{
      const data=await window.API.api(query());
      if(ticket!==version)return;
      draw(data);done=true;
    }catch(e){
      if(ticket===version)root.innerHTML='<div class="db-decision-error">'+esc(e?.hint||e?.data?.hint||'営業判断の記録を取得できませんでした。')+
        ' <button type="button" id="db-judge-retry" class="btn btn-sm btn-secondary">再取得</button></div>';
    }finally{if(ticket===version)loading=false;}
  }
  root.addEventListener('click',e=>{
    const metric=e.target.closest?.('[data-metric]');
    if(metric){const button=metric;button.id='db-decision-return';openMetric(button.dataset.metric);return;}
    if(e.target.closest?.('#db-judge-company'))window.SalesDashboardTabs?.selectView('company');
    if(e.target.closest?.('#db-judge-retry'))load();
  });
  document.addEventListener('click',e=>{
    const modal=document.getElementById('db-decision-modal');
    if(!modal||!modal.contains(e.target))return;
    if(e.target.closest?.('[data-close-metric]')){closeModal();return;}
    const page=e.target.closest?.('[data-metric-page]');
    if(page&&!page.disabled)openMetric(modalMetric,Number(page.dataset.metricPage));
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('db-decision-modal'))closeModal();});
  window.SalesDecisionBoard={ready(){authorized=true;return load();},
    periodChanged(){version++;done=false;loading=false;closeModal();if(authorized)return load();return undefined;}};
})();
