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
    const base=new Date(today+"T00:00:00Z");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(today)||!Number.isFinite(base.getTime())||base.toISOString().slice(0,10)!==today)
      throw new Error("集計基準日を確認してください");
    if(!Number.isInteger(days)||days<1||days>366)throw new Error("集計期間を確認してください");
    base.setUTCDate(base.getUTCDate()-(days-1));
    return base.toISOString().slice(0,10);
  };
  const percent=(part,total)=>total?Math.round(part/total*100)+"%":"—";
  function period(applicants,days,today){
    const since=dateRange(today,days);
    if(!Array.isArray(applicants))throw new Error("応募データを確認できませんでした");
    return applicants.filter(a=>{
      const date=jstDay(a?.createdAt);
      return date&&date>=since&&date<=today;
    });
  }
  // 月別の見出しを維持。選択範囲に交差する月だけを出し、端の部分月を明示する。
  // 180日は7か月にまたがり得るため、固定6か月には切り詰めない。
  function monthTrend(cohort,since,today){
    const months=[];
    const cursor=new Date(since.slice(0,7)+"-01T00:00:00Z");
    while(cursor.toISOString().slice(0,10)<=today){
      const first=cursor.toISOString().slice(0,10),name=first.slice(0,7);
      const next=new Date(cursor.getTime());next.setUTCMonth(next.getUTCMonth()+1);
      const last=new Date(next.getTime()-86400000).toISOString().slice(0,10);
      const from=first<since?since:first,to=last>today?today:last;
      months.push({name,from,to,partial:from!==first||to!==last,count:cohort.filter(a=>jstMonth(a.createdAt)===name).length});
      cursor.setTime(next.getTime());
    }
    return months;
  }
  function groups(rows,key){
    const map=new Map();
    for(const r of rows)map.set(key(r),(map.get(key(r))||0)+1);
    return [...map.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],"ja"));
  }
  function summarize(applicants,days,today){
    const cohort=period(applicants,days,today);
    const since=dateRange(today,days);
    const dateMissing=applicants.filter(a=>!jstDay(a?.createdAt)).length;
    const limited=applicants.length>=1000;
    const statuses=Object.fromEntries([...CLOSED].map(x=>[x,cohort.filter(a=>a.status===x).length]));
    const active=cohort.filter(a=>!CLOSED.has(a.status)&&!["accepted","done"].includes(a.status));
    const interviewRecords=cohort.filter(a=>Number(a.interviewCount)>0).length;
    const offerStage=cohort.filter(a=>["offer","joining_scheduled"].includes(a.stage)&&!CLOSED.has(a.status)).length;
    const todayMonth=today.slice(0,7);
    const months=monthTrend(cohort,since,today);
    return {
      period:days,total:cohort.length,active:active.length,interviewRecords,offerStage,
      statusCounts:statuses,stage:STAGES.map(([id,label])=>({id,label,n:cohort.filter(a=>a.stage===id).length})),
      sources:groups(cohort,a=>defaultSource(a.source)),
      jobs:groups(cohort,a=>defaultJob(a.jobTitle)),
      trend:months,currentMonth:todayMonth,
      share:percent(interviewRecords,cohort.length),
      limited,dateMissing,range:{from:since,to:today},trendComplete:!limited&&!dateMissing,
      hasMotivation:false,hasRejectionReasons:false,
    };
  }
  function renderTrend(data){
    const rows=data.trend,complete=data.trendComplete;
    const range=escapeText(data.range.from+" ～ "+data.range.to);
    const css='<style>#haTrend.ha-trend{display:block;height:auto}.ha-trend-chart{display:block;width:100%;height:auto;max-width:720px;margin:auto}.ha-trend-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}.ha-trend-table caption{text-align:left;font-weight:700;padding:8px 0}.ha-trend-table th,.ha-trend-table td{padding:7px 5px;border-bottom:1px solid #e1e4e9;text-align:left;overflow-wrap:anywhere}.ha-trend-table td:last-child,.ha-trend-table th:last-child{text-align:right;white-space:nowrap}.ha-trend-caption{font-size:12px;line-height:1.7;color:#596479}.ha-trend-table-wrap{width:100%;overflow-x:auto}</style>';
    const warning=!complete?'<p class="ha-trend-caption" role="status">部分集計：'+
      (data.dateMissing?'登録日を確認できない応募が'+data.dateMissing+'名あります。 ':'')+
      (data.limited?'応募者APIの取得上限（1000件）に達しています。 ':'')+
      '全件を確認できないため折れ線は表示しません。表は確認できた分だけで、未確認を0件とは扱いません。</p>':'';
    let chart='';
    if(complete){
      const max=Math.max(1,...rows.map(x=>x.count));
      const point=(x,i)=>({x:rows.length===1?280:44+i*492/(rows.length-1),y:128-x.count/max*96});
      const points=rows.map(point);
      chart='<svg class="ha-trend-chart" viewBox="0 0 560 180" role="img" aria-labelledby="ha-trend-title ha-trend-desc">'+
        '<title id="ha-trend-title">月別応募受付数（日本時間）</title><desc id="ha-trend-desc">'+range+'。正確な件数と各月の集計範囲は下の表で確認できます。部分月は月全体の件数ではありません。</desc>'+
        '<path d="M44 32H536 M44 128H536" fill="none" stroke="#cfd6e0" stroke-width="1"/>'+
        '<text x="8" y="38" fill="#596479" font-size="16">'+max+'</text><text x="8" y="134" fill="#596479" font-size="16">0</text>'+
        (points.length>1?'<polyline points="'+points.map(p=>p.x+','+p.y).join(' ')+'" fill="none" stroke="#384e78" stroke-width="3"/>':'')+
        rows.map((r,i)=>'<circle cx="'+points[i].x+'" cy="'+points[i].y+'" r="4" fill="#384e78"/>'+
          '<text x="'+points[i].x+'" y="'+(points[i].y-12)+'" text-anchor="middle" fill="#1b2440" font-size="18">'+r.count+'</text>'+
          '<text x="'+points[i].x+'" y="160" text-anchor="middle" fill="#596479" font-size="16">'+Number(r.name.slice(5))+'月'+(r.partial?'*':'')+'</text>').join('')+'</svg>';
    }
    return css+warning+chart+'<p class="ha-trend-caption">集計範囲：'+range+'（日本時間・受付日基準）。* は部分月です。部分月の件数を完全な月とそのまま比較しないでください。'+
      (complete&&data.total===0?' この期間の応募記録は0名です。':'')+'</p>'+
      '<div class="ha-trend-table-wrap"><table class="ha-trend-table"><caption>月別応募受付数の数値表'+(complete?'':'（確認できた分）')+'</caption>'+
      '<thead><tr><th scope="col">月</th><th scope="col">集計範囲</th><th scope="col">応募者数</th></tr></thead><tbody>'+
      rows.map(r=>'<tr><th scope="row">'+escapeText(r.name)+(r.partial?' *':'')+'</th><td>'+escapeText(r.from)+' ～ '+escapeText(r.to)+(r.partial?'（部分月）':'')+'</td><td>'+
        (complete?r.count+'名':r.count?r.count+'名（確認分）':'未確認')+'</td></tr>').join('')+
      '</tbody></table></div>';
  }
  function bars(rows,maxRows=8,complete=true){
    if(!rows.length)return '<p class="ha-empty">'+(complete?'対象データはありません。':'登録日を確認できた対象データはありません。応募0件という意味ではありません。')+'</p>';
    const max=Math.max(1,...rows.map(r=>r[1]));
    const total=rows.reduce((v,r)=>v+r[1],0);
    return rows.slice(0,maxRows).map(([label,n])=>
      '<div class="ha-bar-row"><div class="ha-bar-label">'+escapeText(label)+'</div>'+
      '<div class="ha-bar-track"><div class="ha-bar-value" style="width:'+(n?Math.max(n/max*100,3):0)+'%"></div></div>'+
      '<b>'+(complete||n?n+'件':'—')+'</b><span class="ha-bar-pct">'+(complete?percent(n,total):'—')+'</span></div>'
    ).join("");
  }
  function render(data){
    const states=Object.entries(LABELS).map(([id,label])=>[label,data.statusCounts[id]||0]);
    const stageMax=Math.max(1,...data.stage.map(x=>x.n));
    const complete=data.trendComplete,scope=complete?'':'（確認分）';
    const count=n=>complete||n?n:'—';
    return {
      kpi:
        '<div class="ha-kpi"><span>対象期間の応募'+scope+'</span><strong>'+count(data.total)+'</strong><small>名</small></div>'+
        '<div class="ha-kpi"><span>面談記録あり'+scope+'</span><strong>'+count(data.interviewRecords)+'</strong><small>名（記録率 '+(complete?data.share:'—')+'）</small></div>'+
        '<div class="ha-kpi"><span>内定段階にいる人数'+scope+'</span><strong>'+count(data.offerStage)+'</strong><small>名（現在の状態）</small></div>'+
        '<div class="ha-kpi"><span>選考中・対応中'+scope+'</span><strong>'+count(data.active)+'</strong><small>名</small></div>',
      source:bars(data.sources,8,complete),
      jobs:bars(data.jobs,8,complete),
      outcomes:bars(states,3,complete),
      stages:data.stage.map(x=>
        '<div class="ha-stage-row"><span>'+escapeText(x.label)+'</span><div class="ha-bar-track"><div class="ha-bar-value" style="width:'+(x.n?Math.max(3,x.n/stageMax*100):0)+'%"></div></div><b>'+(complete||x.n?x.n+'人':'—')+'</b></div>'
      ).join(""),
      trend:renderTrend(data),
      note:(data.limited
        ? '応募者APIは現在、最大1000件を取得します。1000件以上の全期間集計は集計専用APIが必要です。'
        : '応募者の登録日を基準とした対象期間の集計です。')+
        (data.dateMissing?' 登録日未確認の'+data.dateMissing+'名は対象期間を判定できず、各集計から除外しています。':'')+
        (complete?'':' 各数値・棒は確認できた分だけです。「—」は未確認で、0件ではありません。率と推移は全件を確認できるまで表示しません。')+
        ' 面談記録には予約・キャンセルが含まれる場合があります。段階は現在の値であり、過去の通過者数ではありません。'
    };
  }
  root.HRApplicantAnalytics={summarize,render,escapeText,period};
})(typeof window!=="undefined"?window:globalThis);
