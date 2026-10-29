// Read-only presentation aggregates. No network, writes, inferred attribution or fabricated series.
(function () {
  'use strict';
  const SOURCES = [
    {key:'hr_lead',biz:'mugen',label:'無限道場リード',limit:300},
    {key:'mugen_course',biz:'mugen',label:'受講申込',limit:300},
    {key:'space_inquiry',biz:'space',label:'Space 問い合わせ・予約',limit:300},
    {key:'site_contact',biz:'site',label:'会社HP問い合わせ',limit:300},
  ];
  const fits = (row,biz) => row.biz !== 'ec' && (!biz || row.biz === biz);
  const day = value => {
    if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date=new Date(value+'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===value ? value : null;
  };
  const scaled = rows => {
    const values=rows.map(r=>r.value).filter(v=>v!==null), max=values.length ? Math.max(...values) : null;
    return rows.map(r=>({...r,max:r.value===null?null:max,ratio:r.value===null?null:(max ? r.value/max : 0)}));
  };
  function build({work=null,production=null,biz='',now=null}={}) {
    const business = biz === 'all' ? '' : biz;
    // An invalid filter must not accidentally broaden access or display all businesses.
    const validBiz=['','mugen','space','site'].includes(business);
    const at = now === null ? null : new Date(now);
    const today=at && Number.isFinite(at.getTime()) ? new Date(at.getTime()+9*3600000).toISOString().slice(0,10) : day(production?.today);
    const sourceBars=scaled(SOURCES.filter(s=>validBiz&&fits(s,business)).map(def=>{
      const source=(work?.sources||[]).find(s=>s.key===def.key);
      const state=source?.state === 'ok' && !Array.isArray(work?.items) ? 'failed' : source?.state || 'not_loaded';
      const rows=state==='ok' ? work.items.filter(r=>r.source===def.key&&r.biz===def.biz) : null;
      const capped=state!=='ok'||typeof source.capped!=='boolean' ? null : source.capped;
      return {key:def.key,biz:def.biz,label:source?.label||def.label,state,
        value:rows ? rows.length : null,openValue:rows && rows.every(r=>typeof r.status?.open==='boolean') ? rows.filter(r=>r.status.open).length : null,
        capped,limit:source?.limit||def.limit,coverage:state!=='ok'?'unavailable':capped===true?'capped':capped===false?'bounded':'unknown',
        scope:source?.scope||'取得済み原本のみ。全期間・全流入を網羅しません。',fetchedAt:source?.fetchedAt||work?.fetchedAt||null};
    }));
    const workCounts=scaled(sourceBars.map(r=>({...r,value:r.openValue})));
    const planSource=(production?.sources||[]).find(s=>s.key==='plan');
    const state=planSource?.state==='ok' && !Array.isArray(production?.items) ? 'failed' : planSource?.state||'not_loaded';
    const plans=state==='ok'&&validBiz ? production.items.filter(p=>p.origin==='plan'&&fits(p,business)&&['mugen','space','site'].includes(p.biz)) : null;
    const active=plans?.filter(p=>p.state?.key!=='published');
    const details=(active||[]).map(p=>{
      const reasons=[];
      if(today&&day(p.due)&&p.due<today) reasons.push('overdue');
      if(!p.ownerId) reasons.push('unassigned');
      return {key:p.key,title:p.title||'無題',biz:p.biz,due:p.due||null,ownerId:p.ownerId||null,reasons};
    }).filter(p=>p.reasons.length);
    const overdue=plans&&today ? details.filter(p=>p.reasons.includes('overdue')).length : null;
    const unassigned=plans ? details.filter(p=>p.reasons.includes('unassigned')).length : null;
    return {sourceBars,workCounts,
      issues:[{key:'overdue',label:'期限超過の制作予定',value:overdue},{key:'unassigned',label:'担当未設定の制作予定',value:unassigned}],
      production:{state,overdue,unassigned,issues:details,coverage:state==='ok'?'bounded':'unavailable',limit:300,capped:null,
        fetchedAt:production?.fetchedAt||null,today,scope:'更新順で最大300件の制作予定から集計。公開済みを除外。原本お知らせには担当・期限項目がないため対象外。'},
      meta:{unit:'原本件数',note:'原本件数はユニーク人数・売上・施策による成果ではありません。原本ごとに取得期間・上限が異なり、大小は効果の優劣を示しません。電話のGW対応受付はこの原本比較に含みません。',
        goals:null,attribution:null,revenue:null,timeline:null,excludedBusinesses:['ec'],validBiz,
        measurementState:'not_connected',measurementNote:'目標・媒体別反応・流入帰属・売上の効果計測は未接続です。未取得を0として表示しません。'}};
  }
  window.MarketingDashboardMetrics={build};
})();
