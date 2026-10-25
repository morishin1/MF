// Source-scoped update cards: run without a browser, live DB or external requests.
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const code=readFileSync(new URL("../js/marketing-site-status.js",import.meta.url),"utf8");
const page=readFileSync(new URL("../marketing/index.html",import.meta.url),"utf8");
const api=readFileSync(new URL("../api/marketing/index.js",import.meta.url),"utf8");
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.className="";this.dataset={};}
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
assert.match(readable(root),/公開設定 2026\/10\/22/);
assert.match(readable(root),/連動記事/);
assert.doesNotMatch(readable(root),/公開設定 2026\/10\/25/);
assert.match(readable(root),/実反映は未照合/);
assert.match(readable(root),/直近30日の記録/,"取得範囲は直近30日だけと明示");
assert.match(readable(root),/確認待ち/,"公開設定日を公開完了（実反映）とは扱わない");
assert.match(readable(root),/未接続/);
assert.match(readable(root),/保留/,"EC は保留");
assert.doesNotMatch(readable(root),/PRから発信を始める/,"重複した主操作はヘッダーだけ");
// 1サイト1行（コーポレート・無限道場・EIGHT SPACE・AIまち・8EC）
const rows=(e)=>[...(e.className==="mk-site-row"?[e]:[]),...e.children.flatMap(c=>typeof c==="string"?[]:rows(c))];
assert.deepEqual(rows(root).map(r=>r.dataset.site),["site","mugen","space","machi","ec"]);
render(root,{sources:[{key:"site_news",state:"ok"}],items:[]},null);
assert.match(readable(root),/直近30日：公開記録なし/);
assert.match(readable(root),/それより前の更新が無いという意味ではありません/,"記録なしを「更新なし」と言い換えない");
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
