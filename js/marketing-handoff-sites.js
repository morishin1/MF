// Public-date vs verified-live-date are different. The grid shows only authorized originals.
(function(){
 "use strict";
 const locations=[
  ["site","コーポレート","8grp.co.jp"],
  ["mugen","無限道場","mugendojo.jp"],
  ["space","EIGHT SPACE","8sp.jp"],
  ["machi","AIまち","ai-machi.jp"],
  ["ec","8EC","8ec.jp"]
 ];
 const el=(t,c,s)=>{const x=document.createElement(t);if(c)x.className=c;if(s!==undefined)x.textContent=s;return x;};
 const local=s=>s?String(s).slice(0,10).replace(/-/g,"/"):"—";
 const findArticles=prod=>{
   const news=prod?.sources?.find(x=>x.key==="site_news");
   if(news?.state!=="ok")return null;
   return (prod.items||[]).filter(a=>(a.origin==="site_news"||(a.origin==="plan"&&a.sourceType==="site_news"&&a.publicUrl))&&a.state?.key==="published"&&/^\d{4}-\d{2}-\d{2}$/.test(a.publishedOn||""));
 };
 function render(root,prod,loadError){
   if(!root)return;
   root.replaceChildren();
   const card=el("section","mkh-card mkh-site-card");
   const top=el("div","mkh-cardhead");
   const heading=el("div");
   heading.append(el("h3","","サイト別の更新状況"),el("p","","公開設定日・更新予定・計測の接続状況を確認"));
   top.append(heading);
   card.append(top);
   const mini=el("div","mkh-site-mini");
   const scroller=el("div","mkh-table-scroll");
   const table=el("table","mkh-table");
   const thead=el("thead"),hrow=el("tr");
   ["サイト","最終公開設定","表示範囲の公開","PV増減","担当者","次の予定","効果測定"].forEach(label=>hrow.append(el("th","",label)));
   thead.append(hrow);table.append(thead);
   const tbody=el("tbody");
   const articles=!loadError?findArticles(prod):null;
   for(const [key,name,host] of locations){
      const row=el("tr");
      const nameCell=el("td","mkh-site-name");
      nameCell.append(el("b","",name),el("small","",host));row.append(nameCell);
      const latest=key==="site"&&articles?articles.slice().sort((a,b)=>b.publishedOn.localeCompare(a.publishedOn))[0]:null;
      let published=key==="site"&&articles?(latest?"公開設定 "+local(latest.publishedOn):"範囲内に記録なし"):"—";
      if(key==="site"&&!articles)published=loadError?"取得失敗":prod?(prod.sources||[]).find(s=>s.key==="site_news")?.state==="forbidden"?"権限なし":"未取得":"取得中";
      row.append(el("td","mkh-mono",published));
      row.append(el("td","mkh-mono",key==="site"&&articles?articles.length+" 件（限定）":"—"));
      row.append(el("td","mkh-mute","",""));
      row.children[row.children.length-1].textContent="未計測";
      row.append(el("td","mkh-mute","—"));
      row.append(el("td","mkh-mute","—"));
      const status=el("td");
      status.append(el("span","mkh-status",key==="ec"?"対象保留":"未接続"));
      row.append(status);tbody.append(row);
      const line=el("div","mkh-site-mini-row");
      const nameBlock=el("div","mkh-site-mini-name");
      nameBlock.append(el("b","",name),el("small","",host));
      const date=el("span","mkh-site-mini-date",
        key==="site"?published:(key==="ec"?"対象保留":"最終公開日 未取得"));
      const flag=el("span","mkh-site-mini-status",
        key==="ec"?"保留":key==="site"&&latest?"反映未確認":
        key==="site"&&!articles?"取得不可":
        key==="site"?"記録なし":"未接続");
      line.append(nameBlock,date,flag);mini.append(line);
   }
   table.append(tbody);scroller.append(table);card.append(mini);
   const details=el("details","mkh-site-details");
   details.append(el("summary","","公開の件数・更新担当などの詳細を見る"),scroller);
   const footer=el("p","mkh-table-note","『公開設定』は原本の記録日であり、サイトへの実反映は未照合です。公開件数は取得範囲に限られます。アクセス増減・更新担当・次の予定は未連携です。");
   details.append(footer);card.append(details);root.append(card);
 }
 window.MarketingHandoffSites={render};
})();
