// Standalone owner review tool. No automatic analysis on page load and no outreach.
const el = id => document.getElementById(id);
const escapeHtml = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = d => d ? new Date(d).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}) : '未生成';
let rows=[], running=false,featureEnabled=false;
const label = status => ({completed:'分析済み',processing:'実行中',pending:'待機中',failed:'失敗',needs_review:'要確認'}[status]||'未分析');
function safeSource(href) {
  try {const u=new URL(href);return u.protocol==='https:'?u.href:null;}catch{return null;}
}
function downloadMd(row) {
  const md=row.analysis?.markdown;
  if (!md) return;
  const url=URL.createObjectURL(new Blob([md],{type:'text/markdown;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='enger-company-'+row.companyId+'.md';
  document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}
function listText(a) {
  return a?.length ? '<ul>'+a.map(x=>'<li>'+escapeHtml(typeof x==='string'?x:(x?.role||x?.type||x?.reason||'—'))+
    (typeof x==='object'&&x?.reason?' <span class="ap-muted">— '+escapeHtml(x.reason)+'</span>':'')+'</li>').join('')+'</ul>' :
    '<p class="ap-muted">確認できていません</p>';
}
function render() {
  const done=rows.filter(x=>x.analysis?.status==='completed').length;
  const bad=rows.filter(x=>x.analysis?.status==='failed').length;
  const linked=rows.filter(x=>(x.engerLinkRecordCount||0)>0).length;
  const sources=rows.reduce((n,x)=>n+(x.analysis?.sources?.length||0),0);
  const ks=[['対象企業',rows.length+' / 10'],['分析済み',done+'社'],['企業リンク記録あり',linked+'社'],['取得した公開ページ',sources+'件']];
  el('ap-kpis').innerHTML=ks.map(([k,v])=>'<div class="ap-kpi"><small>'+k+'</small><b class="ap-numbers">'+escapeHtml(v)+'</b></div>').join('');
  el('ap-start').disabled=running||!featureEnabled||!rows.some(x=>!x.analysis||x.analysis.status==='failed'&&x.analysis.attempt_count<3);
  el('ap-list').innerHTML=rows.map(row=>{
    const a=row.analysis,status=a?.status||'none',facts=a?.facts||{},signals=a?.match_signals||{};
    return '<article class="ap-result ap-row" data-id="'+escapeHtml(row.companyId)+'">'+
      '<h3>'+escapeHtml(row.name)+' <span class="ap-badge '+escapeHtml(status)+'">'+label(status)+'</span></h3>'+
      '<p class="ap-muted">企業ID：'+escapeHtml(row.companyId)+' ／ ENGER企業リンク記録：'+escapeHtml(row.engerLinkRecordCount)+
      ' ／ 確認日時：'+escapeHtml(date(a?.processed_at))+'</p>'+
      '<p>'+escapeHtml(a?.summary||'まだ分析していません。')+'</p>'+
      (a?.status==='completed'?'<details><summary>事業・技術・提案仮説を表示</summary>'+
       '<p><strong>主力事業：</strong>'+escapeHtml(facts.business||'未確認')+'</p>'+
       '<p><strong>規模：</strong>'+escapeHtml(facts.size||'未確認')+'</p>'+
       '<p><strong>技術：</strong>'+escapeHtml((facts.technology||[]).join(' / ')||'未確認')+'</p>'+
       '<p><strong>人材需要の仮説（未確認）</strong></p>'+listText(signals.demand_hypotheses)+
       '<p><strong>案件提供可能性の仮説（未確認）</strong></p>'+listText(signals.supply_hypotheses)+
       '<p><strong>商談で確認すること</strong></p>'+listText(a.next_actions)+
       '<p><strong>情報源</strong></p><ul class="ap-sources">'+(a.sources||[]).map(s=>{
         const url=safeSource(s.url);return url?'<li><a href="'+escapeHtml(url)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(url)+'</a></li>':'';
       }).join('')+'</ul>'+
       '</details><button type="button" data-md="'+escapeHtml(row.companyId)+'">企業情報MDファイル</button>':'')+
      (status==='failed'?'<p class="ap-muted">失敗：'+escapeHtml(a.last_error||'')+'（最大3回まで再試行可能）</p>':'')+
      '<p class="ap-muted">案件の確認済みニーズは別途ヒアリングが必要です。推定だけでは自動マッチングしません。</p>'+
      '</article>';
  }).join('')||'<p>対象データがありません</p>';
  for(const b of el('ap-list').querySelectorAll('[data-md]')) b.onclick=()=>{const row=rows.find(r=>r.companyId===b.dataset.md);if(row)downloadMd(row);};
  if(!running)el('ap-status').textContent='分析済み '+done+'/10社、失敗 '+bad+'社。自動で外部へ送信することはありません。';
}
async function load() {
  const d=await API.api('/api/sales/company-ai-pilot');
  if(!Array.isArray(d.rows)||d.limit!==10)throw Error('企業データを確認できませんでした');
  rows=d.rows;featureEnabled=!!d.featureEnabled;render();
  if(!featureEnabled)el('ap-status').textContent='試験実行は無効です。管理者がプレビュー環境で有効化してください。';
}
async function start() {
  if(running||!featureEnabled)return;
  running=true;render();
  const queue=rows.filter(x=>!x.analysis || x.analysis.status==='failed'&&x.analysis.attempt_count<3);
  for(let i=0;i<queue.length;i++){
    const row=queue[i];
    el('ap-status').textContent='AI分析 '+(i+1)+'/'+queue.length+'：'+row.name;
    try {
      const r=await API.api('/api/sales/company-ai-pilot',{method:'POST',body:{companyId:row.companyId}});
      if(!r.ok)throw Error(r.error||'実行に失敗しました');
    } catch(e) {
      el('ap-status').textContent=row.name+'：'+(e?.hint||e?.message||'失敗')+'。ほかの企業は続行します。';
    }
    try{await load();}catch{/* Continue while preserving previous visible rows */}
  }
  running=false;
  try{await load();}catch{render();}
}
el('ap-reload').onclick=async()=>{try{await load();}catch(e){el('ap-status').textContent=e?.hint||'結果を取得できませんでした';}};
el('ap-start').onclick=()=>void start();
SalesLayout.init({active:'companies'}).then(async ctx=>{
  if(!ctx){el('ap-status').textContent='ログインしてください。';return;}
  try{await load();}catch(e){el('ap-status').textContent=e?.hint||e?.message||'DBの準備状況を確認してください。';}
}).catch(()=>el('ap-status').textContent='権限を確認できません。');
