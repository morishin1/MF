// HR応募分析：既存の応募者APIだけを使用する読み取り専用の集計。
// 既存のstageは「現在いる段階」。過去に通過した事実として扱わない。
// 面談は interviewCount（予約・キャンセルも含み得る）なので「面談記録あり」表記。
// 理由情報が無い場合は推測せず「未収集」と表示する。
(function(root){
  "use strict";
  const CLOSED=new Set(["passed","declined","position_closed"]);
  const LABELS={passed:"見送り・不採用",declined:"本人辞退",position_closed:"募集終了"};
  const STAGES=[
    ["applied","新規応募"],["casual_interview","カジュアル面談"],
    ["ceo_recommend","社長推薦"],["ceo_interview","社長面談"],
    ["offer","内定"],["joining_scheduled","入社予定"]
  ];
  const escapeText=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const jstDay=v=>{const t=Date.parse(v);return Number.isFinite(t)?new Date(t+9*3600000).toISOString().slice(0,10):"";};
  const jstMonth=v=>jstDay(v).slice(0,7);
  const defaultSource=v=>String(v||"未記録").trim()||"未記録";
  const defaultJob=v=>String(v||"未記録").trim()||"未記録";
  const dateRange=(today,days)=>{
    const base=new Date(today+"T00:00:00+09:00");
    return new Date(base.getTime()-(days-1)*86400000).toISOString().slice(0,10);
  };
  const percent=(part,total)=>total?Math.round(part/total*100)+"%":"—";
  function period(applicants,days,today){
    const since=dateRange(today,days);
    return (applicants||[]).filter(a=>{
      const date=jstDay(a.createdAt);
      return date&&date>=since&&date<=today;
    });
  }
  function groups(rows,key){
    const map=new Map();
    for(const r of rows)map.set(key(r),(map.get(key(r))||0)+1);
    return [...map.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],"ja"));
  }
  function summarize(applicants,days,today){
    const cohort=period(applicants,days,today);
    const statuses=Object.fromEntries([...CLOSED].map(x=>[x,cohort.filter(a=>a.status===x).length]));
    const active=cohort.filter(a=>!CLOSED.has(a.status));
    const interviewRecords=cohort.filter(a=>Number(a.interviewCount)>0).length;
    const offerStage=cohort.filter(a=>["offer","joining_scheduled"].includes(a.stage)).length;
    const todayMonth=today.slice(0,7);
    const months=[];
    const md=new Date(today.slice(0,7)+"-15T12:00:00+09:00");
    for(let i=5;i>=0;i--){
      const d=new Date(md.getTime());
      d.setUTCMonth(md.getUTCMonth()-i);
      const month=new Date(d.getTime()+9*3600000).toISOString().slice(0,7);
      months.push({name:month,count:cohort.filter(a=>jstMonth(a.createdAt)===month).length});
    }
    return {
      period:days,total:cohort.length,active:active.length,interviewRecords,offerStage,
      statusCounts:statuses,stage:STAGES.map(([id,label])=>({id,label,n:cohort.filter(a=>a.stage===id).length})),
      sources:groups(cohort,a=>defaultSource(a.source)),
      jobs:groups(cohort,a=>defaultJob(a.jobTitle)),
      trend:months,currentMonth:todayMonth,
      share:percent(interviewRecords,cohort.length),
      limited:applicants.length>=1000,
      hasMotivation:false,hasRejectionReasons:false,
    };
  }
  function bars(rows,maxRows=8){
    if(!rows.length)return '<p class="ha-empty">対象データはありません。</p>';
    const max=Math.max(1,...rows.map(r=>r[1]));
    const total=rows.reduce((v,r)=>v+r[1],0);
    return rows.slice(0,maxRows).map(([label,n])=>
      '<div class="ha-bar-row"><div class="ha-bar-label">'+escapeText(label)+'</div>'+
      '<div class="ha-bar-track"><div class="ha-bar-value" style="width:'+Math.max(n/max*100,3)+'%"></div></div>'+
      '<b>'+n+'件</b><span class="ha-bar-pct">'+percent(n,total)+'</span></div>'
    ).join("");
  }
  function render(data){
    const states=Object.entries(LABELS).map(([id,label])=>[label,data.statusCounts[id]||0]);
    const stageMax=Math.max(1,...data.stage.map(x=>x.n));
    const trends=data.trend, trendMax=Math.max(1,...trends.map(x=>x.count));
    return {
      kpi:
        '<div class="ha-kpi"><span>対象期間の応募</span><strong>'+data.total+'</strong><small>名</small></div>'+
        '<div class="ha-kpi"><span>面談記録あり</span><strong>'+data.interviewRecords+'</strong><small>名（記録率 '+data.share+'）</small></div>'+
        '<div class="ha-kpi"><span>内定段階にいる人数</span><strong>'+data.offerStage+'</strong><small>名（現在の状態）</small></div>'+
        '<div class="ha-kpi"><span>選考中・対応中</span><strong>'+data.active+'</strong><small>名</small></div>',
      source:bars(data.sources),
      jobs:bars(data.jobs),
      outcomes:bars(states,3),
      stages:data.stage.map(x=>
        '<div class="ha-stage-row"><span>'+escapeText(x.label)+'</span><div class="ha-bar-track"><div class="ha-bar-value" style="width:'+Math.max(3,x.n/stageMax*100)+'%"></div></div><b>'+x.n+'人</b></div>'
      ).join(""),
      trend:trends.map(x=>
        '<div class="ha-trend-col"><b>'+x.count+'</b><div class="ha-trend-track"><i style="height:'+Math.max(4,x.count/trendMax*100)+'%"></i></div><small>'+escapeText(x.name.slice(5))+'月</small></div>'
      ).join(""),
      note:(data.limited
        ? '応募者APIは現在、最大1000件を取得します。1000件以上の全期間集計は集計専用APIが必要です。'
        : '応募者の登録日を基準とした対象期間の集計です。')+
        ' 面談記録には予約・キャンセルが含まれる場合があります。段階は現在の値であり、過去の通過者数ではありません。'
    };
  }
  root.HRApplicantAnalytics={summarize,render,escapeText,period};
})(typeof window!=="undefined"?window:globalThis);
