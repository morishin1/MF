// Confirmed-data-only dashboard. Never treats a planned DB state as verified public site delivery.
//
// 2026-10-25 P0：大きなカード5枚をやめて、1サイト1行（サイト名｜日付｜状態）にした。説明は行を開いたときだけ。
//   ・published_on は「公開設定日」。実際にサイトへ出たか（公開URL・反映の照合）は未確認なので、公開完了とは書かない
//   ・取得できるのは直近30日の原本だけ。記録が無くても「最終更新なし」「未更新」とは書かない
//   ・未接続／未取得／取得失敗／権限なし／未準備を別々に出す（0件にしない）
(function () {
  "use strict";
  const sites = [
    {key:"site",name:"コーポレート",host:"8grp.co.jp",source:"site_news"},
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
  // 状態の札（色だけでなく文字でも）：取得済み＝緑、確認待ち・未準備＝黄、取得失敗＝赤、未接続・権限なし・保留＝灰
  const badge=(label,tone)=>make("span","om-badge t-"+tone,label);
  const SRC_STATE={forbidden:["権限なし","muted"],not_ready:["未準備","attention"],failed:["取得失敗","danger"],not_connected:["未接続","muted"]};

  /** 1サイト分：{ date（表に出す日付）, label, tone, note（開いたときの説明） } */
  function siteRow(site,prod,loadError){
    if(loadError)return {date:"—",label:"取得失敗",tone:"danger",note:"制作原本を確認できませんでした。"};
    if(!prod)return {date:"—",label:"取得中",tone:"muted",note:"サイト情報を確認しています。"};
    if(site.key==="ec")return {date:"—",label:"保留",tone:"muted",note:"現段階ではECの公開原本を接続しません。"};
    if(site.source!=="site_news")return {date:"—",label:"未接続",tone:"muted",note:"このサイトの公開日時・URL・更新履歴は未連携です。"};
    const source=(prod.sources||[]).find(s=>s.key==="site_news");
    if(source?.state!=="ok"){
      const [label,tone]=SRC_STATE[source?.state]||["未取得","muted"];
      return {date:"—",label,tone,note:"このサイトの公開原本を確認できません。"};
    }
    const articles=(prod.items||[]).filter(a=>(a.origin==="site_news"||(a.origin==="plan"&&a.sourceType==="site_news"&&a.publicUrl))&&a.state?.key==="published"&&knownDay(a.publishedOn));
    articles.sort((a,b)=>b.publishedOn.localeCompare(a.publishedOn));
    if(articles.length){
      return {date:"公開設定 "+localDay(articles[0].publishedOn),label:"確認待ち",tone:"attention",
        note:"直近30日の記録。最新の公開設定：「"+String(articles[0].title||"無題")+"」。公開ページへの実反映は未照合です。"};
    }
    return {date:"直近30日：公開記録なし",label:"取得済み",tone:"ok",
      note:"直近30日分の公開原本に対象がありません。それより前の更新が無いという意味ではありません。"};
  }

  function render(root,prod,loadError){
    if(!root)return;
    root.replaceChildren();
    const head=make("div","om-panel-top");
    head.append(make("h2","om-h","サイト別の更新状況"),make("span","om-muted","公開設定日と実反映日は別"));
    root.append(head);
    const list=make("ul","mk-sites-list");
    for(const site of sites){
      const r=siteRow(site,prod,loadError);
      const li=make("li","mk-site-row");li.dataset.site=site.key;
      const d=make("details");
      const sum=make("summary");
      const name=make("span","mk-site-name",site.name);
      name.append(make("small","",site.host));
      // 日付が無い（未接続・保留など）行は「—」。スマホでは行を詰めるため隠す（状態の札は残る）
      sum.append(name,make("span","mk-site-date"+(r.date==="—"?" none":""),r.date),badge(r.label,r.tone));
      d.append(sum,make("p","mk-site-note",r.note));
      li.append(d);list.append(li);
    }
    root.append(list);
    root.append(make("p","om-note","記録が無いサイトを「未更新」とは扱いません。"));
  }
  window.MarketingSiteStatus={render,rowOf:siteRow};
})();
