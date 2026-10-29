// Navigation only; article reads/writes remain behind the existing owner/admin API.
(function(){
  "use strict";
  const kinds=["お知らせ","エイトコラム","採用コラム"];
  const categories=["all","news","column","pr","other"];
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function parse(search,hash){
    const q=new URLSearchParams(search);
    const kind=kinds.includes(q.get("kind"))?q.get("kind"):null;
    const raw=String(hash||"").replace(/^#/,"");
    const id=uuid.test(raw)?raw:null;
    const fromMarketing=q.get("from")==="marketing";
    const category=categories.includes(q.get("contentType"))?q.get("contentType"):kind==="お知らせ"?"news":kind?"column":"all";
    return {id,kind,fromMarketing,create:!raw&&q.get("new")==="1"&&!!kind,
      backUrl:"/marketing/?step=list&prSite=site&contentType="+category};
  }
  window.SiteNewsNavigation={parse};
})();
