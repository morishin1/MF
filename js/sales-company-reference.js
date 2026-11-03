// Sales Company Review: read-only reference view from existing, tenant/RLS-scoped analytics.
// A missing review snapshot must not hide companies present in actual proposals.
(() => {
  const root = document.getElementById('company-proposal-reference-content');
  const tab = document.getElementById('db-tab-company');
  if (!root || !tab) return;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = v => Number(v || 0).toLocaleString('ja-JP');
  const pct = v => v == null ? '—' : Number(v).toFixed(1) + '%';
  let companies = [], sentRecords = [], shown = 15, loaded = false, loading = false, sequence = 0, note = '';
  let currentModal = null, modalSequence = 0, reviewStars = 0, modalBusy = false, previousFocus = null;
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const companyIdFor = row => row && typeof row.key==='string' && row.key.startsWith('sales:')
    && UUID.test(row.key.slice(6)) ? row.key.slice(6) : null;
  const starText = n => '★'.repeat(Number(n)||0) + '☆'.repeat(5-(Number(n)||0));
  const dateText = d => {const time=Date.parse(d||'');return Number.isFinite(time)
    ? new Date(time).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}) : '—';};
  function closeModal() {
    modalSequence++; currentModal=null;reviewStars=0;modalBusy=false;
    document.getElementById('sales-company-reference-modal')?.remove();
    previousFocus?.focus?.();previousFocus=null;
  }
  function ratingButtons() {
    return Array.from({length:5},(_,i)=>'<button type="button" data-star="'+(i+1)+
      '" aria-label="'+(i+1)+'つ星" aria-pressed="'+(reviewStars===i+1)+
      '" style="border:0;background:transparent;font-size:25px;color:'+(i<reviewStars?'#b6790e':'#a4afbe')+
      ';padding:2px;cursor:pointer">★</button>').join('');
  }
  function showModalHtml(row, detail, rating, ratingError='') {
    const localId=companyIdFor(row), c=detail?.company||{};
    const timeline=Array.isArray(detail?.timeline)?[...detail.timeline].sort((a,b)=>String(b.at||'').localeCompare(String(a.at||''))).slice(0,60):[];
    const dataMissing=!detail && !!localId;
    const info=(label,value)=>'<div><dt>'+esc(label)+'</dt><dd>'+esc(value||'—')+'</dd></div>';
    const history=timeline.map(x=>'<li><time>'+esc(dateText(x.at))+'</time><b>'+esc(x.label||'記録')+'</b><small>'+esc(x.detail||'')+'</small></li>').join('');
    const approaches=Array.isArray(detail?.approaches)?detail.approaches:[];
    const meetings=Array.isArray(detail?.meetings)?detail.meetings:[];
    const title=row.companyName||'企業名未確認';

    // Exact key from byCompany: never merge distinct companies based on display name.
    const proposals=sentRecords.filter(x=>x.companyKey===row.key)
      .sort((a,b)=>String(b.sentAt||'').localeCompare(String(a.sentAt||'')));
    const rows=proposals.slice(0,100).map(x=>{
      const link=UUID.test(x.proposalId||'')?'/sales/proposals.html?id='+encodeURIComponent(x.proposalId):null;
      return '<tr><td>'+esc(dateText(x.sentAt))+'</td><td><b>'+esc(x.title||'提案内容未登録')+'</b>'+
        '<small>'+esc(x.companyName)+'</small></td><td>'+esc(x.ownerName||'記録未確認')+
        '<small>'+esc(x.actorBasis||'実行者未確認')+'</small></td><td>'+
        (x.meetingReached?'面談到達':'面談未到達')+'</td><td>'+
        (link?'<a href="'+esc(link)+'">提案内容・履歴を開く</a>':'原本ID未確認')+'</td></tr>';
    }).join('');
    const proposalHistory='<h3>提案履歴 <small>（送信日時・担当・原本）</small></h3>'+
      '<p class="sc-note">選択期間の提案件数と同じ集計元です。企業ID未照合でも表示します。</p>'+
      (rows?'<div class="sc-proposal-scroll"><table class="sl-table"><thead><tr>'+
        '<th>送信日時</th><th>内容</th><th>担当</th><th>面談</th><th>詳細</th></tr></thead>'+
        '<tbody>'+rows+'</tbody></table></div><p class="sc-note">'+
        num(Math.min(proposals.length,100))+' / '+num(row.sentCount)+'件表示'+
        (proposals.length!==Number(row.sentCount)?'（明細の一部が未取得です）':'')+'</p>':
        '<p class="sc-note">提案明細が取得できません。0件とは断定できません。</p>');
    const displayCount=value=>value==null?'—':num(value);
    const modal=document.getElementById('sales-company-reference-modal');
    if(!modal)return;
    modal.innerHTML='<div class="sc-modal-backdrop" data-close-company></div>'+
      '<section class="sc-modal" role="dialog" aria-modal="true" aria-labelledby="sc-modal-title" tabindex="-1">'+
      '<header><div><small>企業評価／選択期間 '+esc(note)+'</small><h2 id="sc-modal-title">'+esc(title)+'</h2></div>'+
      '<button type="button" class="btn btn-sm btn-secondary" data-close-company>閉じる ✕</button></header>'+
      '<div class="sc-modal-scroll"><div class="sc-summary">'+
      '<div><small>提案件数</small><strong>'+displayCount(row.sentCount)+'</strong></div>'+
      '<div><small>面談到達</small><strong>'+displayCount(row.meetingCount)+'</strong></div>'+
      '<div><small>面談率</small><strong>'+esc(pct(row.rate))+'</strong></div></div>'+
      '<p class="sc-note">上記は選択期間に送信した提案のコホート実績です。企業の累計実績や正式な評価とは異なります。</p>'+
      proposalHistory+'<h3>企業情報</h3><dl class="sc-info">'+
      info('会社名',c.name||c.companyName||title)+info('担当者',c.ownerName)+
      info('業種',c.industry)+info('住所',c.address)+info('企業状態',c.statusLabel||c.status)+
      info('次の対応',c.next)+info('最終連絡',dateText(detail?.contactStatus?.lastContactAt))+
      '</dl>'+
      (dataMissing?'<p role="alert" class="sc-error">企業情報を取得できませんでした。詳細は企業一覧で確認してください。</p>':'')+
      (!localId?'<p class="sc-error">企業IDが未照合です。同名企業の誤結合を防ぐため★評価は登録できません。企業マスターとの照合が必要です。</p>':'')+
      '<h3>★ 企業の担当者評価 <small>（正式なA〜D評価とは別）</small></h3>'+
      (localId?'<div class="sc-stars" id="sc-rating-stars">'+ratingButtons()+'</div>'+
      '<label class="sc-note" for="sc-review-note">評価理由・対応メモ（500文字以内）</label>'+
      '<textarea id="sc-review-note" maxlength="500" rows="3" placeholder="例：条件確認が早く、面談日程が決まりやすい"></textarea>'+
      '<div class="sc-actions"><button class="btn btn-primary btn-sm" type="button" id="sc-save-star" '+(ratingError?'disabled':'')+'>★評価を保存</button>'+
      '<span id="sc-rating-result" role="status" class="sc-note">'+esc(ratingError||'個人の担当判断を記録。提案停止や優先掲載には自動反映しません。')+'</span></div>':
      '<p class="sc-note">★評価は企業IDの照合後に利用できます。</p>')+
      '<h3>営業履歴 <small>（直近最大60件）</small></h3>'+
      (history?'<ol class="sc-timeline">'+history+'</ol>':localId?'<p class="sc-note">履歴がありません、または取得できませんでした。</p>':'<p class="sc-note">企業マスター未照合のため、アタック・通話履歴は表示できません。送信提案の履歴は上で確認できます。</p>')+
      '<p class="sc-note">既存の営業送信 '+num(approaches.length)+'件 ／ 面談記録 '+num(meetings.length)+'件（表示可能な範囲）</p>'+
      '<div class="sc-actions"><a class="btn btn-secondary btn-sm" href="/sales/companies.html'+(localId?'?id='+encodeURIComponent(localId):'')+'">企業管理画面で開く</a>'+
      '<button type="button" class="btn btn-secondary btn-sm" data-close-company>戻る</button></div></div></section>';
    const field=modal.querySelector('#sc-review-note');if(field)field.value=rating?.note||'';
    modal.querySelector('.sc-modal')?.focus();
  }
  async function openRow(row) {
    if(!row)return;
    const id=companyIdFor(row),ticket=++modalSequence;
    previousFocus=document.activeElement;currentModal=row;reviewStars=0;
    let modal=document.getElementById('sales-company-reference-modal');
    if(!modal){modal=document.createElement('div');modal.id='sales-company-reference-modal';document.body.appendChild(modal);}
    modal.innerHTML='<div class="sc-modal-backdrop" data-close-company></div>'+
      '<div class="sc-modal" role="dialog" aria-modal="true" tabindex="-1"><p>企業情報・履歴を読み込み中…</p>'+
      '<button type="button" class="btn btn-secondary btn-sm" data-close-company>閉じる</button></div>';
    if(!id){showModalHtml(row,null,null);return;}
    const results=await Promise.allSettled([
      window.API.api('/api/sales/companies/detail?id='+encodeURIComponent(id)),
      window.API.api('/api/sales/company-stars?company_id='+encodeURIComponent(id)),
    ]);
    if(ticket!==modalSequence)return;
    const detail=results[0].status==='fulfilled'?results[0].value:null;
    const rating=results[1].status==='fulfilled'?results[1].value.review:null;
    const error=results[1].status==='rejected'?'★評価機能はDBの準備が必要です。保存はできません。':'';
    reviewStars=Number(rating?.stars||0);
    showModalHtml(row,detail,rating,error);
  }
  function openCompany(index){return openRow(companies[index]);}
  const style=document.createElement('style');style.textContent=`
    #company-proposal-reference-content [data-company-index]{border:0;background:transparent;color:#184d7d;text-align:left;text-decoration:underline;text-underline-offset:3px;font:inherit;font-weight:700;cursor:pointer}
    #company-proposal-reference-content tbody tr:hover{background:#f2f6fb}
    #sales-company-reference-modal{position:fixed;inset:0;z-index:150;display:grid;place-items:center;padding:16px}
    #sales-company-reference-modal .sc-modal-backdrop{position:absolute;inset:0;background:#0d2339b9}
    #sales-company-reference-modal .sc-modal{position:relative;width:min(770px,96vw);max-height:90dvh;background:#fff;border-radius:10px;box-shadow:0 16px 60px #10233a33;outline:0;display:flex;flex-direction:column}
    #sales-company-reference-modal .sc-modal header{padding:18px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;gap:12px;align-items:center}
    #sales-company-reference-modal .sc-modal header h2{font-size:19px;margin:4px 0}
    #sales-company-reference-modal .sc-modal header small{color:#6b7990;font-size:11px}
    #sales-company-reference-modal .sc-modal-scroll{overflow-y:auto;padding:16px 20px}
    #sales-company-reference-modal .sc-modal h3{font-size:14px;margin:16px 0 10px;border-bottom:1px solid #e2e8f0;padding-bottom:7px}
    #sales-company-reference-modal .sc-modal h3 small{font-weight:400;color:#5e7188}
    #sales-company-reference-modal .sc-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    #sales-company-reference-modal .sc-summary>div{background:#f3f7fb;border:1px solid #e2e8f0;border-radius:6px;padding:10px}
    #sales-company-reference-modal .sc-summary small{font-size:10px;display:block;color:#58708c}
    #sales-company-reference-modal .sc-summary strong{font-size:23px}
    #sales-company-reference-modal .sc-note{font-size:12px;color:#5c6a7e;line-height:1.7}
    #sales-company-reference-modal .sc-info{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;margin:0}
    #sales-company-reference-modal .sc-info dt{font-size:10px;color:#6a7990}
    #sales-company-reference-modal .sc-info dd{font-size:12px;margin:2px 0;font-weight:700;overflow-wrap:anywhere}
    #sales-company-reference-modal .sc-error{padding:10px;background:#fff3d9;color:#815308;font-size:12px}
    #sales-company-reference-modal .sc-stars{display:flex;gap:5px}
    #sales-company-reference-modal #sc-review-note{width:100%;display:block;min-height:76px;padding:10px;border:1px solid #c8d3de;border-radius:6px}
    #sales-company-reference-modal .sc-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0}
    #sales-company-reference-modal .sc-proposal-scroll{max-height:320px;overflow:auto;border:1px solid #e2e8f0}
    #sales-company-reference-modal .sc-proposal-scroll .sl-table{min-width:670px}
    #sales-company-reference-modal .sc-proposal-scroll small{display:block;font-size:10px;color:#66788a}
    #sales-company-reference-modal .sc-timeline{margin:0;padding:0 0 0 12px;list-style:none;max-height:300px;overflow:auto}
    #sales-company-reference-modal .sc-timeline li{padding:9px 0 9px 13px;border-left:2px solid #dce6ee}
    #sales-company-reference-modal .sc-timeline time{font-size:10px;color:#6b7990;margin-right:10px}
    #sales-company-reference-modal .sc-timeline b{font-size:12px}
    #sales-company-reference-modal .sc-timeline small{display:block;font-size:11px;color:#6b7990}
    @media(max-width:560px){#sales-company-reference-modal .sc-info{grid-template-columns:1fr}#sales-company-reference-modal .sc-modal-scroll{padding:12px}}
  `;document.head.appendChild(style);


  function render() {
    if (!companies.length) {
      root.innerHTML = '<p>この期間に送信した提案先企業はありません。審査対象が0件であることとは別です。</p>';
      return;
    }
    const body = companies.slice(0, shown).map((c,index) => {
      const reasons = (c.lossReasons || []).slice().sort((a,b) => Number(b.count || 0) - Number(a.count || 0));
      const reason = reasons.length ? (reasons[0].label || '理由不明') + ' ' + num(reasons[0].count) + '件' : '終了理由の記録なし';
      return '<tr><td><button type="button" data-company-index="' + index + '">' + esc(c.companyName || '企業名不明') + '</button></td>' +
        '<td class="num">' + esc(num(c.sentCount)) + '</td><td class="num">' + esc(num(c.meetingCount)) +
        '</td><td class="num">' + esc(pct(c.rate)) + '</td><td>' + esc(reason) +
        '</td><td>要照合</td></tr>';
    }).join('');
    const visual=window.SalesVisuals;
    const leaders=[...companies].sort((a,b)=>Number(b.sentCount||0)-Number(a.sentCount||0)).slice(0,7);
    const reasonMap=new Map();
    for(const company of companies){
      for(const reason of company.lossReasons||[]){
        const label=String(reason.label||"理由不明");
        reasonMap.set(label,(reasonMap.get(label)||0)+Number(reason.count||0));
      }
    }
    const companyGraph=visual?visual.bars(leaders.map(x=>({
      label:x.companyName||"企業未確認",value:x.sentCount,
      detail:"面談 "+num(x.meetingCount)+"/"+num(x.sentCount)+"件"+(Number(x.sentCount)<10?"・少数参考":"")
    })),{title:"企業別の提案と面談状況",maxRows:7}):"";
    const lossGraph=visual?visual.donut([...reasonMap].map(([label,value])=>({label,value})),
      {title:"提案先企業の現在の終了理由",centerLabel:"終了理由"}):"";
    const charts=visual?
      '<div class="db-visual-grid"><section class="db-visual-card"><h3>企業別の提案件数</h3>'+
      '<p>面談到達数を補足。提案が多い会社が優良とは限りません。</p>'+companyGraph+'</section>'+
      '<section class="db-visual-card"><h3>提案先の終了理由</h3>'+
      '<p>選択期間に送信された提案の現時点の終了理由。返答待ちは失注として数えません。</p>'+
      lossGraph+'</section></div>':"";
    root.innerHTML = '<p class="db-short-note">' + esc(note) + '　表示 ' + num(Math.min(shown, companies.length)) +
      ' / ' + num(companies.length) + ' 企業レコード。企業名やIDが未照合のため重複の可能性があります。</p>' + charts +
      '<div style="overflow-x:auto"><table class="sl-table"><thead><tr>' +
      '<th>企業</th><th>提案</th><th>面談</th><th>面談率</th><th>主な終了理由</th><th>評価</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      (shown < companies.length ? '<button type="button" data-more-companies class="btn btn-sm btn-secondary" style="margin-top:10px">さらに15件表示</button>' : '');
  }

  async function load() {
    if (loaded || loading) return;
    const ticket = ++sequence;
    loading = true;
    root.textContent = '提案先企業を取得中…';
    // Always use the same selected JST period as Rankings/Analysis.
    const selected = window.SalesDashboardReport?.getPeriod?.() || {key:'last_30',from:'',to:''};
    const params = new URLSearchParams({period:selected.key});
    if (selected.key === 'custom') {
      params.set('from', selected.from);
      params.set('to', selected.to);
    }
    try {
      const result = await window.API.api('/api/sales/dashboard-analysis?' + params);
      if (ticket !== sequence) return;
      companies = Array.isArray(result.metrics?.byCompany) ? result.metrics.byCompany : [];
      sentRecords = Array.isArray(result.metrics?.sentRecords) ? result.metrics.sentRecords : [];
      shown = 15;
      const scope = result.dataStatus?.scope === 'assigned' ? '担当分' : '閲覧できる範囲';
      const sync = result.dataStatus?.sourceState === 'ready' ? '' : '・ENGER同期未確認';
      const dates = result.period?.from && result.period?.to ?
        result.period.from + '〜' + result.period.to : '指定期間';
      note = '期間 ' + dates + '（JST）・' + scope + sync +
        '。面談率は送信コホートの到達率です。正式な企業評価ではありません。';
      loaded = true;
      render();
    } catch (e) {
      if (ticket === sequence) root.textContent = e?.hint || e?.data?.hint || 'Salesの提案データを取得できません。閲覧権限・同期状態を確認してください。';
    } finally {
      if (ticket === sequence) loading = false;
    }
  }
  const onShow = () => { if (tab.getAttribute('aria-selected') === 'true') load(); };
  function periodChanged() {
    // In-flight responses for the previous interval must never overwrite the new one.
    sequence++;
    loading = false;
    loaded = false;
    companies = [];
    sentRecords = [];
    shown = 15;
    root.textContent = 'このタブを開くと選択期間の企業を集計します。';
    Promise.resolve().then(onShow);
  }
  tab.addEventListener('click', () => Promise.resolve().then(onShow));
  window.addEventListener('popstate', () => Promise.resolve().then(onShow));
  root.addEventListener('click', e => {
    const company=e.target.closest?.('[data-company-index]');
    if(company){openCompany(Number(company.dataset.companyIndex));return;}
    if (e.target.closest?.('[data-more-companies]')) { shown += 15; render(); }
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&currentModal)closeModal();});
  document.addEventListener('click',async e=>{
    const container=document.getElementById('sales-company-reference-modal');
    if(!container||!container.contains(e.target))return;
    if(e.target.closest?.('[data-close-company]')){closeModal();return;}
    const star=e.target.closest?.('[data-star]');
    if(star&&!modalBusy){reviewStars=Number(star.dataset.star);container.querySelector('#sc-rating-stars').innerHTML=ratingButtons();return;}
    if(e.target.closest?.('#sc-save-star')){
      if(modalBusy)return;
      const id=companyIdFor(currentModal);
      const el=container.querySelector('#sc-rating-result');
      if(!id||reviewStars<1){if(el)el.textContent='★を1〜5の範囲で選択してください。';return;}
      modalBusy=true;const button=container.querySelector('#sc-save-star');
      if(button)button.disabled=true;if(el)el.textContent='保存結果を確認しています…';
      try{
        const note=container.querySelector('#sc-review-note')?.value||'';
        const response=await window.API.api('/api/sales/company-stars',{method:'POST',body:{company_id:id,stars:reviewStars,note}});
        if(el)el.textContent=response.review?'★'+reviewStars+' の評価を保存しました。':'保存結果を確認できませんでした。';
      }catch(error){if(el)el.textContent=error?.hint||'評価を保存できませんでした。DB構成と権限を確認してください。';}
      finally{modalBusy=false;if(button)button.disabled=false;}
    }
  });
  window.SalesCompanyReference = { periodChanged, loadIfVisible: onShow,
    openCompanyById(id,name){
      if(typeof id!=='string'||!UUID.test(id))return;
      const found=companies.find(row=>companyIdFor(row)===id);
      return openRow(found||{key:'sales:'+id,companyName:String(name||'企業名未確認'),sentCount:null,meetingCount:null,rate:null});
    },
  };
  onShow();
})();
