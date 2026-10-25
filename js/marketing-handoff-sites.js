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
   const link=el("button","mkh-link","公開・制作の一覧を見る");
   link.type="button";
   link.onclick=()=>document.querySelector('[data-marketing-step="pr"][role="tab"]')?.click();
   top.append(link);card.append(top);
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
   }
   table.append(tbody);scroller.append(table);card.append(scroller);
   const footer=el("p","mkh-table-note","『公開設定』は原本の記録日であり、サイトへの実反映は未照合です。公開件数は取得範囲に限られます。アクセス増減・更新担当・次の予定は未連携です。");
   card.append(footer);root.append(card);
 }
 window.MarketingHandoffSites={render};
})();
