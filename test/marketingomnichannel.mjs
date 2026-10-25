import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const code=readFileSync(new URL("../js/marketing-omni-dashboard.js",import.meta.url),"utf8");
const html=readFileSync(new URL("../marketing/index.html",import.meta.url),"utf8");
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.value="";this.hidden=false;this.attrs={};this.className="";}
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
for(const word of ["発信数","WebサイトPV","SNSからの流入","メールのクリック","有効問い合わせ","商談・成約","ブラストメール","LINE公式","未計測","計測接続待ち","計測リンク（UTM）を作る"])assert.match(t,new RegExp(word));
assert.doesNotMatch(t,/実績\s*[1-9][0-9]*件/);
assert.ok(descendants(root).some(e=>e.tag==="details"&&e.id==="om-connections"));
assert.ok(descendants(root).some(e=>e.tag==="form"&&typeof e.onsubmit==="function"));
const select=descendants(root).find(e=>e.attrs?.["aria-label"]==="集計期間");
assert.equal(select.value,"30");select.value="90";select.onchange();
assert.match(text(root),/過去90日/);

// The dashboard-first design puts source-backed production charts before the site cards,
 // while cross-channel, still-unmeasured KPIs live in the separate Analysis tab.
assert.ok(html.indexOf('id="marketing-home-charts"')<html.indexOf('id="marketing-site-status"'));
assert.ok(html.indexOf('id="mkt-panel-analytics"')<html.indexOf('id="marketing-omnichannel"'));
assert.ok(html.indexOf('id="marketing-omnichannel"')<html.indexOf('id="marketing-outcomes"'));
assert.match(html,/MarketingOmniDashboard\.render/);
assert.match(html,/marketing-omni\.css\?v=20261025o1/);
assert.match(html,/mk-raw-dashboard/);
assert.doesNotMatch(code,/fetch\(|API\.api\(|service_role|access_token/);
console.log("omnichannel dashboard: 6 KPIs, 7 channels, no invented data, functional UTM builder and safe source links PASS");
