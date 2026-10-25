// Confirmed-data-only dashboard. Never treats a planned DB state as verified public site delivery.
(function () {
  "use strict";
  const sites = [
    {key:"site",name:"コーポレートサイト",host:"8grp.co.jp",source:"site_news"},
    {key:"mugen",name:"無限道場",host:"無限道場サイト"},
    {key:"space",name:"EIGHT SPACE",host:"8sp.jp"},
    {key:"machi",name:"AIまち",host:"ai-machi.jp"},
    {key:"ec",name:"8EC",host:"ECサイト"}
  ];
  const make=(tag,cls,txt)=>{
    const e=document.createElement(tag); if(cls)e.className=cls;
    if(txt!==undefined)e.textContent=txt; return e;
  };
  const knownDay=(s)=>{
    if(typeof s!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(s))return null;
    const date=new Date(s+"T00:00:00Z");
    return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===s?s:null;
  };
  const localDay=(d)=>d?d.replace(/-/g,"/"):null;
  function render(root,prod,loadError){
    if(!root)return;
    root.replaceChildren();
    const top=make("div","mk-update-top");
    const intro=make("div");
    intro.append(make("h2","","サイト別の公開・更新状況"),
      make("p","mk-note","公開設定日と、実際のサイト反映確認日は別です。取得済みの根拠だけを表示します。"));
    const jump=make("a","of-btn","PRから発信を始める");
    jump.href="/marketing/publishing.html?kind=press";
    top.append(intro,jump);root.append(top);
    const grid=make("div","mk-update-grid");
    for(const site of sites){
      const card=make("section","mk-update-card");
      card.append(make("h3","",site.name),make("div","mk-update-host",site.host));
      const state=make("div","mk-update-state");
      const msg=make("p","mk-note");
      if(loadError){state.textContent="取得失敗";msg.textContent="制作原本を確認できませんでした。";}
      else if(!prod){state.textContent="取得中";msg.textContent="サイト情報を確認しています。";}
      else if(site.source==="site_news"){
        const source=(prod.sources||[]).find(s=>s.key==="site_news");
        if(source?.state!=="ok"){
          const labels={forbidden:"権限なし",not_ready:"未準備",failed:"取得失敗",not_connected:"未連携"};
          state.textContent=labels[source?.state]||"未取得";
          msg.textContent="このサイトの公開原本を確認できません。";
        }else{
          const articles=(prod.items||[]).filter(a=>a.origin==="site_news"&&a.state?.key==="published"&&knownDay(a.publishedOn));
          articles.sort((a,b)=>b.publishedOn.localeCompare(a.publishedOn));
          if(articles.length){
            state.textContent="公開設定 "+localDay(articles[0].publishedOn);
            msg.textContent="直近の公開設定：「"+String(articles[0].title||"無題")+"」。公開ページへの実反映は未照合。";
          }else{
            state.textContent="取得範囲に記録なし";
            msg.textContent="直近30日分の公開原本に対象なし。最終更新日がないという意味ではありません。";
          }
        }
      }else{
        state.textContent=site.key==="ec"?"対象保留":"未接続";
        msg.textContent=site.key==="ec"?"現段階ではECの公開原本を接続しません。":"このサイトの公開日時・URL・更新履歴は未連携です。";
      }
      card.append(state,msg);grid.append(card);
    }
    root.append(grid);
    const foot=make("p","mk-note","サイトで実際に表示されていることを確認できる公開URL・反映日時・更新担当と、各ページPVの計測は今後の連携対象です。記録がないサイトを「未更新」と断定しません。");
    root.append(foot);
    const measurement=make("div","mk-measure-empty");
    measurement.append(make("h3","","記事別アクセス・公開後の伸び"),
      make("p","","PV計測・公開イベント・記事IDの対応付けが未接続のため、ランキングと公開前後比較はまだ算出できません。接続後は7日／30日／90日の推移、公開前7日との比較、増加記事、問い合わせを表示します。"));
    root.append(measurement);
  }
  window.MarketingSiteStatus={render};
})();
