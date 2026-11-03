// Sales focus display: safe read-only compact ENGER items, no fake confirmation.
(() => {
  const rootJobs=document.getElementById('db-focus-jobs-list');
  const rootTalents=document.getElementById('db-focus-talents-list');
  if(!rootJobs||!rootTalents)return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
  const number=v=>Number(v||0).toLocaleString('ja-JP');
  const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')?v:'';
  const stages=[
    {root:rootJobs,key:'jobs',name:'注力案件',url:'https://dx.enger.jp/matching?tab=job'},
    {root:rootTalents,key:'talents',name:'注力人材',url:'https://dx.enger.jp/matching?tab=talent'},
  ];
  let loaded=false,loading=false;
  const render=(block)=>{
    const state=block.data;
    const count=block.root.closest('section')?.querySelector('[data-enger-focus-count]');
    if(count)count.textContent=number(state.count)+'件';
    const rows=state.rows||[];
    block.root.innerHTML=rows.length?rows.map((row,index)=>{
      const title=block.key==='jobs'?row.title:row.initials+(row.role?'／'+row.role:'');
      // Link to the existing authoritative focus tab; no guessed per-record routing.
      const meta=(row.no?'No.'+number(row.no)+' ／ ':'')+(row.skills||[]).join('・');
      return '<li class="db-focus-row"><span class="db-focus-position">'+(index+1)+'</span>'+
        '<div><strong>'+esc(title)+'</strong><small>'+esc(meta||'条件情報未登録')+'</small>'+
        '<small>条件の確認：'+(row.decisionDue?'期限 '+esc(date(row.decisionDue)):'要確認')+
        (block.key==='jobs'&&row.lastConfirmedAt?' ／ 更新の記録あり':'')+'</small></div>'+
        '<a href="'+block.url+'" rel="noopener noreferrer" target="_blank">ENGERで確認</a></li>';
    }).join(''):'<li class="sl-empty">現在注力中の'+esc(block.name)+'はありません。</li>';
    const notes=block.root.closest('section')?.querySelector('[data-focus-source]');
    if(notes)notes.textContent='ENGER現在注力：'+number(state.count)+'件 ／ 表示は上位'+Math.min(5,rows.length)+'件。提案の許可状況は別途確認してください。';
  };
  async function load(){
    if(loaded||loading)return;loading=true;
    try{
      const data=await window.API.api('/api/sales/enger-focus');
      if(data?.source!=='enger'||!data?.complete||!data.jobs||!data.talents)throw Error('invalid response');
      for(const block of stages){block.data=data[block.key];render(block);}
      loaded=true;
    }catch{
      for(const block of stages){
        block.root.innerHTML='<li class="sl-empty">ENGERの注力情報を取得できません。ENGERで確認してください。</li>';
        const notes=block.root.closest('section')?.querySelector('[data-focus-source]');
        if(notes)notes.textContent='取得できなかったため、件数は表示していません。';
      }
    }finally{loading=false;}
  }
  window.SalesEngerFocus={ready:load,reload:()=>{loaded=false;return load();}};
})();
