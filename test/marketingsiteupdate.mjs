// Source-scoped update cards: run without a browser, live DB or external requests.
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const code=readFileSync(new URL("../js/marketing-site-status.js",import.meta.url),"utf8");
const page=readFileSync(new URL("../marketing/index.html",import.meta.url),"utf8");
const api=readFileSync(new URL("../api/marketing/index.js",import.meta.url),"utf8");
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.className="";}
  append(...v){this.children.push(...v);}
  replaceChildren(...v){this.children=[...v];}
}
const root=new Element("section");
const ctx={window:{},document:{createElement:(tag)=>new Element(tag)},Date};
vm.runInNewContext(code,ctx);
const render=ctx.window.MarketingSiteStatus.render;
const readable=(e)=>[e.textContent,...e.children.map(v=>typeof v==="string"?v:readable(v))].join(" ");
render(root,null,null);
assert.match(readable(root),/取得中/);
assert.doesNotMatch(readable(root),/0件/);
render(root,{sources:[{key:"site_news",state:"ok"}],items:[
 {origin:"site_news",state:{key:"published"},title:"最新リリース",publishedOn:"2026-10-20"},
 {origin:"site_news",state:{key:"draft"},title:"未公開",publishedOn:"2026-10-25"},
 {origin:"plan",state:{key:"published"},title:"計画表",publishedOn:"2026-10-24"},
 {origin:"plan",sourceType:"site_news",publicUrl:"https://8grp.co.jp/news/test/",state:{key:"published"},title:"連動記事",publishedOn:"2026-10-22"}]},null);
assert.match(readable(root),/公開設定 2026\/10\/20/);
assert.match(readable(root),/連動記事/);
assert.doesNotMatch(readable(root),/公開設定 2026\/10\/25/);
assert.match(readable(root),/実反映は未照合/);
assert.match(readable(root),/未接続/);
assert.match(readable(root),/未計測/);
render(root,{sources:[{key:"site_news",state:"forbidden"}],items:[]},null);
assert.match(readable(root),/権限なし/);
assert.doesNotMatch(readable(root),/公開設定 2026\/10\/20/);
render(root,null,"api-failed");
assert.match(readable(root),/取得失敗/);
assert.match(page,/id="marketing-site-status"/);
assert.match(page,/id="mk-worklist"/);
assert.match(page,/MarketingSiteStatus\.render/);
assert.match(api,/publishedOn: a\.published_on \|\| null/);
assert.doesNotMatch(code,/fetch\(|API\.|method:|localStorage/);
console.log("ok marketing site updates: source state, published date provenance, privacy & navigation (VM/static)");
