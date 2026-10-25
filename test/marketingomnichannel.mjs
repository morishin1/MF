import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const code=readFileSync(new URL("../js/marketing-omni-dashboard.js",import.meta.url),"utf8");
const html=readFileSync(new URL("../marketing/index.html",import.meta.url),"utf8");
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.value="";this.hidden=false;this.attrs={};this.className="";this.dataset={};}
 setAttribute(k,v){this.attrs[k]=v;}
 append(...v){this.children.push(...v);}
 replaceChildren(...v){this.children=[...v];}
}
const document={createElement:tag=>new Element(tag)};
const ctx={window:{},document,URL,Error,Object,Number,Array,String,navigator:{clipboard:{writeText:async()=>{}}}};
vm.createContext(ctx);vm.runInContext(code,ctx);
const api=ctx.window.MarketingOmniDashboard;
assert.equal(Array.from(api.channels).length,7);
assert.equal(Array.from(api.kpis).length,6);
const origin="https://8grp.co.jp/lp/?keep=yes&utm_campaign=old#apply";
const built=api.buildUtm(origin,"blastmail","new_course_oct","email_a");
const u=new URL(built);
assert.equal(u.searchParams.get("keep"),"yes");
assert.equal(u.searchParams.get("utm_source"),"blastmail");
assert.equal(u.searchParams.get("utm_medium"),"email");
assert.equal(u.searchParams.get("utm_campaign"),"new_course_oct");
assert.equal(u.searchParams.get("utm_content"),"email_a");
assert.equal(u.hash,"#apply");
assert.equal(Array.from(u.searchParams.keys()).filter(k=>k==="utm_campaign").length,1);
assert.equal(new URL(api.buildUtm(origin,"x","campaign_test","")).searchParams.get("utm_medium"),"social");
for(const bad of ["javascript:alert(1)","http://8grp.co.jp/","https://user:password@8grp.co.jp/","not-a-url"]){
  assert.throws(()=>api.buildUtm(bad,"x","campaign_test",""));
}
assert.throws(()=>api.buildUtm("https://8grp.co.jp/","not_found","campaign_test",""));
assert.throws(()=>api.buildUtm("https://8grp.co.jp/","blastmail","test@example.com",""));
assert.throws(()=>api.buildUtm("https://8grp.co.jp/","blastmail","campaign_test","someone@example.com"));

const root=new Element("section");
const text=e=>[e.textContent,...(e.children||[]).map(c=>typeof c==="string"?c:text(c))].join(" ");
const descendants=e=>[e,...(e.children||[]).flatMap(c=>typeof c==="string"?[]:descendants(c))];
api.render(root,{work:null,production:null,biz:""});
const t=text(root);
// P0（2026-10-25）：KPI の名前は仕様書どおり（発信数／Web PV／SNS流入／メールクリック／有効問い合わせ／商談・成約）
for(const word of ["発信数","Web PV","SNS流入","メールクリック","有効問い合わせ","商談・成約","ブラストメール","LINE公式","未計測","計測接続待ち","計測リンク（UTM）を作る",
  "今週やること","設定に必要なこと","媒体別の成果","記事別の伸び","0件ではありません"])assert.match(t,new RegExp(word));
// 6つのKPIは、ラベル／大きな数字（—）／状態（未計測）。押すと根拠を開く（未計測なので計測の接続状況・原本の一覧）
const kpiCards=descendants(root).filter(e=>e.className==="om-kpi");
assert.equal(kpiCards.length,6);
assert.deepEqual(kpiCards.map(e=>e.dataset.kpi),["publications","pageviews","socialSessions","emailClicks","inquiries","won"]);
assert.ok(kpiCards.every(e=>e.tag==="button"&&typeof e.onclick==="function"&&/未計測/.test(text(e))&&/—/.test(text(e))&&e.title));
assert.ok(kpiCards.every(e=>!/[0-9]+件/.test(text(e))),"未計測を0件・件数で出さない");
const opened=[];
api.render(root,{},{onOpen:(t,c)=>opened.push([t,c.kpi||c.channel||""])});
descendants(root).filter(e=>e.className==="om-kpi").forEach(e=>e.onclick());
assert.deepEqual(opened.map(x=>x[0]),["production","connections","connections","connections","work","connections"]);
// 事業は、原本につながっている事業だけ。EC は保留中で選べない
const bizSel=descendants(root).find(e=>e.attrs?.["aria-label"]==="事業");
assert.deepEqual(bizSel.children.map(o=>o.value),["","site","mugen","space","ec"]);
assert.equal(bizSel.children.find(o=>o.value==="ec").disabled,true);
const changes=[];
api.render(root,{},{onChange:(v)=>changes.push(v)});
const bs=descendants(root).find(e=>e.attrs?.["aria-label"]==="事業");bs.value="space";bs.onchange();
assert.deepEqual(JSON.parse(JSON.stringify(changes.at(-1))),{days:30,biz:"space"});
api.render(root,{},{biz:""});
assert.doesNotMatch(t,/実績\s*[1-9][0-9]*件/);
assert.ok(descendants(root).some(e=>e.tag==="details"&&e.id==="om-connections"));
assert.ok(descendants(root).some(e=>e.tag==="form"&&typeof e.onsubmit==="function"));
const select=descendants(root).find(e=>e.attrs?.["aria-label"]==="集計期間");
assert.equal(select.value,"30");select.value="90";select.onchange();
assert.match(text(root),/過去90日/);

assert.ok(html.indexOf('id="marketing-omnichannel"')<html.indexOf('id="marketing-site-status"'));
assert.ok(html.indexOf('id="marketing-omnichannel"')<html.indexOf('id="marketing-outcomes"'));
assert.match(html,/MarketingOmniDashboard\.render/);
assert.match(html,/marketing-omni\.css\?v=20261025p0/);
// 並べ方（P0）：ヘッダー → KPI → サイト別の更新状況｜今週やること → 媒体別 → 記事別 → 詳細（折りたたみ）
const at=(id)=>html.indexOf(`id="${id}"`);
for(const [a,b] of [["marketing-omnichannel","marketing-site-status"],["marketing-site-status","marketing-tasks"],["marketing-tasks","marketing-channels"],
  ["marketing-channels","marketing-articles"],["marketing-articles","mk-details"],["mk-details","marketing-outcomes"],["mk-details","mk-worklist"]])assert.ok(at(a)>0&&at(a)<at(b),a+" は "+b+" より前");
assert.match(html,/<a class="of-btn" href="publishing\.html\?kind=press">PRを作成<\/a><a class="of-btn sec" href="publishing\.html">発信管理<\/a>/);
assert.match(html,/詳細：制作予定・問い合わせ・接続状態・原本グラフ/);
assert.match(html,/確認用ブランチです。本番と同じデータ接続の可能性があります。閲覧のみで確認/,"確認用の注意書きは省略しない");
assert.match(html,/公開・アクセス計測は準備中です/);
assert.doesNotMatch(html,/PRリリースを作成・展開する/);
assert.match(html,/mk-raw-dashboard/);
assert.doesNotMatch(code,/fetch\(|API\.api\(|service_role|access_token/);
console.log("omnichannel dashboard: 6 KPIs, 7 channels, no invented data, functional UTM builder and safe source links PASS");
