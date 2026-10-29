import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const formatter=read("js/marketing-space-release-draft.js");
const js=read("js/marketing-handoff-composer.js");
const share=read("js/marketing-manual-share.js");
const page=read("marketing/index.html");
const sql=read("db/proposal_marketing_pr_drafts.sql");
const api=read("api/marketing/pr-drafts.js");
let checks=0;const check=(v,msg)=>{assert.ok(v,msg);checks++;};
class Node{
 constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.className="";this.attrs={};this.value="";this.checked=false;this.hidden=false;this.files=[];this.style={};this.type="";}
 append(...xs){this.children.push(...xs);}
 prepend(...xs){this.children.unshift(...xs);}
 replaceChildren(...xs){this.children=[...xs];}
 setAttribute(k,v){this.attrs[k]=v;}
}
const doc={createElement:t=>new Node(t)};
const ctx={window:{},document:doc,URL,console,navigator:{clipboard:{writeText:async()=>{}}}};
vm.createContext(ctx);
vm.runInContext(formatter,ctx);
ctx.window.SpaceRelease=ctx.SpaceRelease;
check(ctx.SpaceRelease.KINDS.length===8,"8sp PR TIMES format categories retained");
vm.runInContext(js,ctx);
const app=ctx.window.MarketingHandoffComposer;
const root=new Node("section");
app.mount(root);
const walk=e=>[e,...(e.children||[]).flatMap(x=>typeof x==="string"?[]:walk(x))];
const button=text=>walk(root).find(x=>x.tag==="button"&&x.textContent===text);
function field(label){
 const parent=walk(root).find(x=>x.tag==="label"&&x.className==="mpr-field"&&x.children.some(y=>y.tag==="span"&&y.textContent.includes(label)));
 return parent?.children.find(x=>["input","select","textarea"].includes(x.tag));
}
function input(label,text){const f=field(label);assert.ok(f,"missing "+label);f.value=text;(f.oninput||f.onchange)?.();}
check(app.snapshot().stage==="edit"&&app.snapshot().tab===0,"starts on first of five input tabs");
check(walk(root).filter(x=>x.attrs.role==="tab").length===5,"five subtabs not a long form");
check(!page.includes("発信・制作の確認画面")&&!page.includes("既存8spでPR草案を作る"),"duplicate PR buttons removed");
input("タイトル","株式会社エイト、AI研修サービスを発表");
button("2. 発表内容").onclick();
input("概要・リード文","新しい学習体験を提供します。");
const feature=walk(root).find(x=>x.attrs["aria-label"]==="特徴1の見出し");
assert.ok(feature);feature.value="実践型";feature.oninput();
button("4. 会社・問い合わせ").onclick();
input("メールアドレス","press@example.com");
check(app.missing().length===0,"8sp required PR fields completed");
button("5. 画像・仕上げ").onclick();
check(!!button("下書き保存")&&!!button("プレビューを見る"),"draft and preview actions only after final tab");
check(button("下書き保存").disabled,"draft save cannot falsely succeed when SQL unready");
button("プレビューを見る").onclick();
check(app.snapshot().stage==="preview","preview follows last tab");
check(walk(root).some(x=>x.tag==="pre"&&x.textContent.includes("■ 会社概要")),"PR TIMES formatted full preview shown");
check(walk(root).some(x=>x.tag==="p"&&x.textContent.includes("保存先未接続")),"preview accurately labels unsaved state");
check(!walk(root).some(x=>x.tag==="button"&&x.textContent==="内容を確認して本登録"&&!x.disabled),"registration cannot complete without persisted draft");
check(app.buildDraft().includes("Email：press@example.com"),"8sp formatter maintains contact");
check(!/fetch\(|localStorage|sessionStorage|x\.com\/intent|instagram\.com/.test(js),"PR editor does not publish to social media");
check(share.includes("https://x.com/intent/tweet")&&share.includes("Instagram用リンクをコピー"),"social integration uses manual share");
check(!/api\.x\.com|graph\.facebook\.com|instagram\/media_publish/.test(share),"no social posting API");
check(sql.includes("enable row level security")&&sql.includes("revoke all")&&sql.includes("draft")&&sql.includes("registered"),"PR draft schema protects tenants and statuses");
check(api.includes('eq("tenant_id",ctx.tenantId)')&&api.includes('eq("created_by",user.id)')&&api.includes('eq("version",body.version)'),"API scopes reads and optimistic writes");
check(api.includes("confirmed!==true")&&api.includes('error:"conflict"'),"register requires explicit confirmation and detects concurrency");
check(page.includes("marketing-pr-compact.css")&&page.includes("marketing-manual-share.js"),"new UI assets wired");
console.log("PR subtabs draft->preview->registration contract: "+checks+" checks passed");
