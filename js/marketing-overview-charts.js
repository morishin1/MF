// The first Marketing screen. Charts are drawn only from accessible production originals.
// Do not treat "published" DB state as confirmed public-site delivery, or infer PV.
(function () {
  "use strict";
  const STATES=[
    {key:"plan",label:"企画",color:"#9ca3af"},
    {key:"drafting",label:"作成中",color:"#6d8fb4"},
    {key:"review",label:"確認待ち",color:"#d9a44d"},
    {key:"scheduled",label:"公開予定",color:"#5297af"},
    {key:"published",label:"公開設定済",color:"#418c71"}
  ];
  const MEDIUMS=[
    {key:"column",label:"記事・コラム"},
    {key:"sns",label:"SNS"},
    {key:"youtube",label:"YouTube"},
    {key:"campaign",label:"キャンペーン"}
  ];
  const svgNS="http://www.w3.org/2000/svg";
  const element=(tag,cls,text)=>{
    const el=document.createElement(tag);
    if(cls)el.className=cls;
    if(text!==undefined)el.textContent=String(text);
    return el;
  };
  function getModel(prod){
    const sources=prod?.sources||[];
    const available=new Set(sources.filter(s=>s.state==="ok"&&(s.key==="plan"||s.key==="site_news")).map(s=>s.key));
    const ready=available.size>0;
    const items=Array.isArray(prod?.items)?prod.items.filter(x=>(x.origin==="plan"&&available.has("plan"))||(x.origin==="site_news"&&available.has("site_news"))):[];
    const counts=Object.fromEntries(STATES.map(s=>[s.key,0]));
    const media=Object.fromEntries(MEDIUMS.map(m=>[m.key,0]));
    for(const item of items){
      if(Object.hasOwn(counts,item?.state?.key))counts[item.state.key]++;
      if(Object.hasOwn(media,item?.medium))media[item.medium]++;
    }
    return {
      ready,partial:available.size!==2,items,counts,media,
      total:STATES.reduce((sum,s)=>sum+counts[s.key],0),
      mediumTotal:MEDIUMS.reduce((sum,m)=>sum+media[m.key],0),
      coverage:"取得済み原本の表示対象のみ。制作予定は最大300件、サイト記事の公開済みは直近30日が対象。全期間・全件の数字ではありません。公開設定済はサイトへの実反映確認を意味しません。"
    };
  }
  function svg(tag,attributes){
    const el=document.createElementNS(svgNS,tag);
    for(const [k,v] of Object.entries(attributes||{}))el.setAttribute(k,String(v));
    return el;
  }
  const fmt=value=>value==null?"—":value.toLocaleString("ja-JP");
  function donut(parent,model){
    const chart=element("div","mt-donut-layout");
    const circle=svg("svg",{viewBox:"0 0 200 200",role:"img","aria-label":"取得済み原稿の状態別構成円グラフ"});
    const base=svg("circle",{cx:100,cy:100,r:69,fill:"none",stroke:"#ebedf0","stroke-width":23});
    circle.append(base);
    if(model.total){
      const circumference=2*Math.PI*69;
      let offset=0;
      for(const s of STATES){
        const count=model.counts[s.key];if(count===0)continue;
        const part=circumference*count/model.total;
        circle.append(svg("circle",{
          cx:100,cy:100,r:69,fill:"none",stroke:s.color,"stroke-width":23,
          "stroke-dasharray":part+" "+(circumference-part),
          "stroke-dashoffset":-offset,transform:"rotate(-90 100 100)"
        }));
        offset+=part;
      }
    }
    const center=svg("text",{x:100,y:98,"text-anchor":"middle","font-size":32,"font-weight":800,fill:"#1b2440"});
    center.textContent=fmt(model.total);
    const small=svg("text",{x:100,y:118,"text-anchor":"middle","font-size":11,fill:"#6b7080"});
    small.textContent="表示対象の原稿";
    circle.append(center,small);
    chart.append(circle);
    const legend=element("div","mt-legend");
    const label=element("p","mt-chart-sub","制作段階（表示対象内の構成比）");
    legend.append(label);
    const table=element("table","mt-chart-table");
    for(const s of STATES){
      const tr=element("tr");const td=element("td");const marker=element("span","mt-chart-dot");
      marker.style.backgroundColor=s.color;td.append(marker,element("span","",s.label));
      const val=element("td","mt-num",fmt(model.counts[s.key]));
      tr.append(td,val);table.append(tr);
    }
    legend.append(table);chart.append(legend);parent.append(chart);
  }
  function bars(parent,model){
    const max=Math.max(1,...MEDIUMS.map(m=>model.media[m.key]));
    const list=element("div","mt-bars");
    for(const m of MEDIUMS){
      const row=element("div","mt-bar-row");
      const top=element("div","mt-bar-label");
      top.append(element("span","",m.label),element("strong","mt-num",fmt(model.media[m.key])+"件"));
      const track=element("div","mt-bar-track");
      const fill=element("div","mt-bar-fill");
      fill.style.width=(model.media[m.key]/max*100)+"%";
      track.append(fill);row.append(top,track);list.append(row);
    }
    parent.append(list);
  }
  function render(root,prod){
    if(!root)return;
    root.replaceChildren();
    const model=getModel(prod);
    const title=element("div","mt-heading");
    const left=element("div");
    left.append(element("h2","","今の制作・公開状況"),element("p","mt-caption","発信の進み具合を先に確認。WebアクセスやSNSの成果は「効果分析」タブへ。"));
    title.append(left);root.append(title);
    const summary=element("div","mt-stat-grid");
    const cards=[
      {label:"表示対象の原稿",value:model.ready?model.total:null,desc:"取得済みの原本"},
      {label:"確認待ち",value:model.ready?model.counts.review:null,desc:"担当者が確認する段階"},
      {label:"公開予定",value:model.ready?model.counts.scheduled:null,desc:"公開待ち・予約済み"},
      {label:"公開設定済",value:model.ready?model.counts.published:null,desc:"実サイト反映は別確認"}
    ];
    for(const c of cards){
      const box=element("section","mt-stat");
      box.append(element("span","mt-stat-label",c.label),element("strong","mt-stat-value",fmt(c.value)),element("small","mt-stat-desc",model.ready?c.desc:"原本未取得"));
      summary.append(box);
    }
    root.append(summary);
    const grid=element("div","mt-chart-grid");
    const doughnutCard=element("section","mt-chart");
    doughnutCard.append(element("h3","","制作状況の内訳"));
    const barCard=element("section","mt-chart");
    barCard.append(element("h3","","媒体別の制作件数"));
    if(model.ready){
      if(model.total)donut(doughnutCard,model);
      else doughnutCard.append(element("p","mt-empty","取得できた対象原稿は0件です。"));
      if(model.mediumTotal)bars(barCard,model);
      else barCard.append(element("p","mt-empty","該当する制作データはありません。"));
    }else{
      doughnutCard.append(element("p","mt-empty","原稿の原本が未取得です。連携・権限を確認してください。"));
      barCard.append(element("p","mt-empty","媒体別のグラフは原本取得後に表示します。"));
    }
    grid.append(doughnutCard,barCard);root.append(grid);
    const note=element("p","mt-caption",model.coverage);
    if(model.partial)note.textContent+=" 一部ソースは未取得のため、全体の内訳・合計ではありません。";
    root.append(note);
    return model;
  }
  window.MarketingOverviewCharts={render,getModel};
})();
