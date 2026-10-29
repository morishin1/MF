// Presentation-only list state. Uses authorized production responses; never fetches or writes.
(function () {
  "use strict";
  const sites = [["", "すべて"], ["site", "自社サイト"], ["mugen", "無限道場"], ["space", "EIGHT SPACE"], ["ec", "EC"]];
  const categories = [["all", "すべて", "view_list"], ["pr", "PR一覧", "campaign"], ["column", "コラム一覧", "article"], ["news", "自社お知らせ", "newspaper"], ["other", "その他・制作予定", "event_note"]];
  const siteIcons = {"":"language",site:"corporate_fare",mugen:"school",space:"meeting_room",ec:"shopping_bag"};
  const categoryOf = item => {
    if (item.sourceKind === "お知らせ") return "news";
    if (item.sourceKind === "プレスリリース") return "pr";
    if (["エイトコラム", "採用コラム"].includes(item.sourceKind)) return "column";
    // A linked original without readable kind is unknown, not a column by inference.
    if (item.origin === "plan" && !item.sourceType && item.medium === "column") return "column";
    return "other";
  };
  const steps = ["dashboard", "pr", "distribution", "list", "analytics"];
  const labels = {not_connected:"未接続",forbidden:"権限なし",not_ready:"未準備",failed:"取得失敗",on_hold:"保留"};
  const validSite = value => sites.some(([key]) => key === value) ? value : "";
  function fromUrl(query) {
    const tab = query.get("tab") === "work" ? "work" : "production";
    const requested = query.get("step");
    const step = steps.includes(requested) ? requested : query.has("tab") ? (tab === "production" ? "list" : "pr") : "dashboard";
    const page = Number(query.get("prPage"));
    return {step,tab,category:categories.some(([key])=>key===query.get("contentType"))?query.get("contentType"):"all",biz:validSite(query.get("biz")),
      site:validSite(query.has("prSite") ? query.get("prSite") : !steps.includes(requested) && step === "list" ? query.get("biz") : ""),
      page:Number.isSafeInteger(page) && page > 0 ? page : 1};
  }
  function items(production, site, category = "all") {
    const ready = new Set((production?.sources || []).filter(source => source.state === "ok").map(source => source.key));
    return (production?.items || []).filter(item => (!site || item.biz === site) && ready.has(item.origin) && (category === "all" || categoryOf(item) === category));
  }
  function availability(production, site, category = "all") {
    const sources = (production?.sources || []).filter(source => !site || source.biz === site);
    const unavailable = sources.filter(source => source.state !== "ok");
    const count = items(production, site, category).length;
    const known = sources.some(source => source.state === "ok") || count > 0;
    const status = [...new Set(unavailable.map(source => labels[source.state] || "未取得"))].join("・");
    return {count,partial:unavailable.length > 0,label:known ? `${count}件${unavailable.length ? "・一部未取得" : ""}` : status || "未取得"};
  }
  function paginate(rows, requested, size = 20) {
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(pages, Math.max(1, Number.isSafeInteger(requested) ? requested : 1));
    return {page,pages,total:rows.length,start:(page-1)*size,rows:rows.slice((page-1)*size,page*size)};
  }
  window.MarketingPRList = {sites,steps,categories,siteIcons,categoryOf,fromUrl,items,availability,paginate};
})();
