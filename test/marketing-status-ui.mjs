import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const page=read("marketing/index.html"),health=read("js/marketing-status-ui.js"),composer=read("js/marketing-handoff-composer.js");
let checks=0;const ok=(test,label)=>{assert.ok(test,label);checks++;};
class El {
 constructor(tag){this.tag=tag;this.children=[];this.className="";this.textContent="";this.attrs={};this.title="";}
 append(...n){this.children.push(...n);}
 replaceChildren(...n){this.children=[...n];}
 setAttribute(k,v){this.attrs[k]=String(v);}
}
const root=new El("div");
const apiCalls=[];
const context={window:{API:{api:async(path)=>{
 apiCalls.push(path);if(path==="/api/marketing/intake")return {items:[]};
 throw Error("Unexpected call");
}}},document:{createElement:t=>new El(t),getElementById:id=>id==="marketing-connection-summary"?root:null},console};
vm.createContext(context);vm.runInContext(health,context);
const ui=context.window.MarketingStatusUI;
const walk=e=>[e,...e.children.flatMap(x=>typeof x==="string"?[]:walk(x))];
const label=key=>walk(root).find(e=>e.attrs["data-connection"]===key);
ui.render();
ok(walk(root).filter(x=>x.className.includes("mkcs-item")).length===4,"four explicitly scoped statuses");
ok(label("pr").textContent===""&&walk(label("pr")).some(x=>x.textContent==="確認中"),"PR starts unknown");
ui.set("pr","ok","Read only successful");
ok(walk(label("pr")).some(x=>x.textContent==="利用可能"),"PR readiness shown only after success");
ui.set("production","not_ready");
ok(walk(label("production")).some(x=>x.textContent==="保存先未準備"),"database missing is visible");
ui.set("intake","forbidden");
ok(walk(label("intake")).some(x=>x.textContent==="権限なし"),"403 is not a generic 0");
ok(ui.normalized({status:403})==="forbidden","403 classified");
ok(ui.normalized({status:503})==="not_ready","503 classified");
ok(ui.normalized({status:500})==="failed","500 classified");
await ui.checkIntake();
ok(apiCalls.length===1&&apiCalls[0]==="/api/marketing/intake","GET only intake status");
ok(walk(label("intake")).some(x=>x.textContent==="利用可能"),"empty table can be ready, not unconnected");
ok(walk(label("analytics")).some(x=>x.textContent==="未接続"),"analytics is not claimed live");
ok(page.includes('id="marketing-connection-summary"')&&page.includes("marketing-status-ui.js"),"status module wired");
ok(!page.includes("保存・更新は接続先の実データに反映されます。各機能の権限"),"confusing full-width alarm removed");
ok(page.includes("window.MarketingStatusUI.checkIntake()")&&page.includes('window.MarketingStatusUI?.set("production"'),"all three source readiness flows connected");
ok(composer.includes('window.MarketingStatusUI?.set("pr"'),"PR reports source-backed API readiness");
ok(!/\.post\(|method:\s*["']POST|fetch\(/.test(health),"status module performs no writes");
console.log("Marketing feature readiness UI: "+checks+" checks passed (all synthetic)");
