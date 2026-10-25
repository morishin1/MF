// Presentation-only list state. Uses authorized production responses; never fetches or writes.
(function () {
  "use strict";
  const sites = [["", "すべて"], ["site", "自社サイト"], ["mugen", "無限道場"], ["space", "EIGHT SPACE"], ["ec", "EC"]];
  const steps = ["dashboard", "pr", "distribution", "list", "analytics"];
  const labels = {not_connected:"未接続",forbidden:"権限なし",not_ready:"未準備",failed:"取得失敗",on_hold:"保留"};
  const validSite = value => sites.some(([key]) => key === value) ? value : "";
  function fromUrl(query) {
    const tab = query.get("tab") === "work" ? "work" : "production";
    const requested = query.get("step");
    const step = steps.includes(requested) ? requested : query.has("tab") ? (tab === "production" ? "list" : "pr") : "dashboard";
    const page = Number(query.get("prPage"));
    return {step,tab,biz:validSite(query.get("biz")),
      site:validSite(query.has("prSite") ? query.get("prSite") : !steps.includes(requested) && step === "list" ? query.get("biz") : ""),
      page:Number.isSafeInteger(page) && page > 0 ? page : 1};
  }
  function items(production, site) {
    const ready = new Set((production?.sources || []).filter(source => source.state === "ok").map(source => source.key));
    return (production?.items || []).filter(item => (!site || item.biz === site) && ready.has(item.origin));
  }
  function availability(production, site) {
    const sources = (production?.sources || []).filter(source => !site || source.biz === site);
    const unavailable = sources.filter(source => source.state !== "ok");
    const count = items(production, site).length;
    const known = sources.some(source => source.state === "ok") || count > 0;
    const status = [...new Set(unavailable.map(source => labels[source.state] || "未取得"))].join("・");
    return {count,partial:unavailable.length > 0,label:known ? `${count}件${unavailable.length ? "・一部未取得" : ""}` : status || "未取得"};
  }
  function paginate(rows, requested, size = 20) {
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(pages, Math.max(1, Number.isSafeInteger(requested) ? requested : 1));
    return {page,pages,total:rows.length,start:(page-1)*size,rows:rows.slice((page-1)*size,page*size)};
  }
  window.MarketingPRList = {sites,steps,fromUrl,items,availability,paginate};
})();
