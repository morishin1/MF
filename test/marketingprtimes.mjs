import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const read=f=>readFileSync(new URL("../"+f,import.meta.url),"utf8");
const shared=read("js/marketing-space-release-draft.js");
const script=read("js/marketing-handoff-composer.js");
const html=read("marketing/index.html");
let checks=0;
function ok(x,label){assert.ok(x,label);checks++;}
class Element{
 constructor(tag){this.tag=tag;this.textContent="";this.children=[];this.attrs={};this.style={};this.value="";this.type="";this.placeholder="";this.className="";this.checked=false;this.hidden=false;this.files=[];}
 append(...n){this.children.push(...n);}
 prepend(...n){this.children.unshift(...n);}
 replaceChildren(...n){this.children=[...n];}
 setAttribute(k,v){this.attrs[k]=String(v);}
}
const document={createElement:t=>new Element(t),getElementById:id=>null};
const ctx={window:{},document,console,URL,navigator:{clipboard:{writeText:async()=>{}}}};
vm.createContext(ctx);
vm.runInContext(shared,ctx);
ctx.window.SpaceRelease=ctx.SpaceRelease;
ok(ctx.SpaceRelease.KINDS.length===8,"uses all eight PR TIMES release types from 8sp");
const sample={kind:"event",title:"地域イベント開催のご案内",summary:"地域企業の交流イベントを開催します。",background:"交流機会を設けるため。",features:[{title:"参加型",body:"地元の方が参加できます。"}],company:"株式会社エイト",location:"東京都渋谷区",contact_email:"press@example.com",event_on:"2026-11-14",event_start:"14:00",event_end:"16:00",venue:"online",fee_type:"free",future:"次回も検討中です。"};
const built=ctx.SpaceRelease.buildDraft(sample);
for(const expected of ["地域イベント開催のご案内","■ 背景","■ イベントの見どころ","■ 開催概要","■ 会社概要","■ 本件に関するお問い合わせ","2026年11月14日"])ok(built.includes(expected),"8sp upstream section "+expected);
ok(ctx.SpaceRelease.missing(sample).length===0,"8sp missing field validation");
vm.runInContext(script,ctx);
const app=ctx.window.MarketingHandoffComposer;
const root=new Element("section");
app.mount(root);
ok(app.snapshot().kind==="service"&&app.snapshot().step===0,"default service type and first step");
const walk=e=>[e,...e.children.flatMap(x=>typeof x==="string"?[]:walk(x))];
function inputFor(label){
 const field=walk(root).find(x=>x.tag==="label"&&x.className==="mkh-pr-field"&&x.children.some(c=>c.tag==="span"&&c.textContent.includes(label)));
 return field?.children.find(x=>["input","textarea","select"].includes(x.tag));
}
function set(label,value){
 const node=inputFor(label);assert.ok(node,"missing input "+label);
 node.value=value;
 (node.oninput||node.onchange)?.();
}
function pushButton(label){
 const btn=walk(root).find(x=>x.tag==="button"&&x.textContent===label);
 assert.ok(btn,"missing button "+label);btn.onclick?.();
}
pushButton("公開先ごとに調整");
ok(app.snapshot().step===0,"incomplete PR TIMES draft blocks next step");
set("タイトル","株式会社エイト、地域で学ぶAIセミナーを開催");
set("概要・リード文","地域での学びの機会としてAIセミナーを開催します。");
const ft=walk(root).find(x=>x.tag==="input"&&x.attrs["aria-label"]==="ポイント1の見出し");
assert.ok(ft);ft.value="実際に体験できる";ft.oninput();
set("メールアドレス","press@example.com");
ok(app.missing().length===0,"title, lead, company, point, press contact complete");
const s=app.buildDraft();
ok(s.includes("株式会社エイト")&&s.includes("■ サービスの特徴")&&s.includes("Email：press@example.com"),"writes PR TIMES compatible article from fields");
pushButton("公開先ごとに調整");
ok(app.snapshot().step===1,"valid PR advances to media editing");
pushButton("プレビューへ");
ok(app.snapshot().step===2,"PR content preview available");
ok(walk(root).some(n=>n.tag==="pre"&&n.textContent.includes("■ 会社概要")),"full PR TIMES preview visible");
ok(walk(root).some(n=>n.tag==="button"&&n.textContent==="ローカルAI校正用の指示文をコピー"),"manual AI edit prompt only");
ok(!/\bfetch\(|API\.api\(|\.post\(|localStorage|sessionStorage|service_role/.test(script),"composer never publishes, makes network requests or stores drafts");
ok(html.indexOf("marketing-space-release-draft.js")<html.indexOf("marketing-handoff-composer.js"),"PR TIMES formatter loads before composer");
ok(html.includes('id="marketing-handoff-pr-composer"'),"inline PR form in Marketing PR tab");
console.log("PR TIMES handoff: "+checks+" checks passed (synthetic DOM, no writes)");
