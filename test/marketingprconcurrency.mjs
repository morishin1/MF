// Delayed synthetic API responses only: no browser, credentials, database or sends.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
class Element {
 constructor(tag){Object.assign(this,{tag,children:[],attrs:{},textContent:"",className:"",value:"",files:[],style:{}});}
 append(...xs){this.children.push(...xs);}
 replaceChildren(...xs){this.children=[...xs];}
 setAttribute(k,v){this.attrs[k]=v;}
}
const walk=e=>[e,...e.children.flatMap(x=>typeof x==="string"?[]:walk(x))];
const copy=x=>JSON.parse(JSON.stringify(x));
let count=0;
function check(label,fn){fn();count++;console.log("ok",label);}
check("composer cache key changes for the fixed bundle",()=>assert.match(read("marketing/index.html"),/marketing-handoff-composer\.js\?v=20261029thumb1/));
const calls=[],pending=[];
const ctx={console,URL,document:{createElement:t=>new Element(t)},navigator:{}};
ctx.window=ctx;
ctx.API={api:(path,options)=>{
 if(!options)return Promise.resolve({ready:true,items:[]});
 const body=copy(options.body);calls.push(body);
 return new Promise((resolve,reject)=>pending.push({body,resolve,reject}));
}};
vm.createContext(ctx);
vm.runInContext(read("js/marketing-space-release-draft.js"),ctx);
// Test-only access to internal transitions; production exports are unchanged.
const source=read("js/marketing-handoff-composer.js").replace("snapshot(){return", "__review:{state,save,register,openSaved,signature,render},snapshot(){return");
vm.runInContext(source,ctx);
const app=ctx.MarketingHandoffComposer,r=app.__review,root=new Element("section");
app.mount(root);await new Promise(setImmediate);
Object.assign(r.state.draft,{title:"保存前のタイトル",summary:"概要",company:"エイト",contact_email:"press@example.com",features:[{title:"特徴",body:"詳細"}]});
const original=copy(r.state.draft);
const a={id:"a",version:1,status:"draft",registeredAt:null,payload:{draft:original,body_override:"",media:{}}};
const b={...copy(a),id:"b"};b.payload.draft.title="別の原稿";
r.state.items=[a,b];r.openSaved(a);
check("opened saved nested fields do not mutate their server snapshot",()=>{
 r.state.draft.features[0].body="未保存の変更";
 assert.equal(a.payload.draft.features[0].body,"詳細");
 r.openSaved(b);r.openSaved(a);
 assert.equal(r.state.draft.features[0].body,"詳細");
});
const oldTab=walk(root).find(x=>x.attrs.role==="tab"&&x.textContent.startsWith("2."));
const saving=r.save();
check("save freezes every input, subtab and saved-draft selector",()=>{
 const controls=walk(root).filter(x=>["input","textarea","button","select"].includes(x.tag));
 assert.ok(controls.length>5);assert.ok(controls.every(x=>x.disabled));
 assert.ok(controls.some(x=>x.tag==="select"&&x.attrs["aria-label"]==="保存されたPRを開く"));
});
await r.save();await r.register();r.openSaved(b);oldTab.onclick();
check("repeated save/register and stale navigation handlers cannot change the pending draft",()=>{
 assert.equal(calls.length,1);assert.equal(r.state.id,"a");assert.equal(r.state.tab,0);
});
// Model an in-flight edit even if some future UI fails to honor the control lock.
r.state.draft.title="保存中に編集したタイトル";r.state.dirty=true;
const first=pending.shift();
check("request payload is an immutable snapshot",()=>assert.equal(first.body.payload.draft.title,"保存前のタイトル"));
first.resolve({item:{...copy(a),version:2,payload:first.body.payload}});await saving;
check("late save does not mark newer changes as persisted",()=>{
 assert.equal(r.state.dirty,true);assert.notEqual(r.state.savedSignature,r.signature());
});
await r.register();
check("unpersisted edit cannot register",()=>assert.equal(calls.length,1));
const failed=r.save();pending.shift().reject(Error("temporary failure"));await failed;
check("failed save unlocks retry without clearing dirty state",()=>{
 assert.equal(r.state.busy,false);assert.equal(r.state.dirty,true);
 assert.ok(walk(root).some(x=>x.tag==="input"&&!x.disabled));
});
const retry=r.save(),second=pending.shift();
second.resolve({item:{...copy(a),version:3,payload:second.body.payload}});await retry;
check("successful retry saves the exact newer snapshot",()=>{
 assert.equal(r.state.dirty,false);assert.equal(r.state.savedSignature,r.signature());
});
r.state.stage="preview";r.render();
const registrationFailure=r.register();pending.shift().reject(Error("temporary registration failure"));await registrationFailure;
check("failed registration unlocks preview and preserves the saved original for retry",()=>{
 assert.equal(r.state.busy,false);assert.equal(r.state.stage,"preview");
 assert.equal(r.state.savedSignature,r.signature());assert.equal(r.state.registeredAt,null);
});
const back=walk(root).find(x=>x.tag==="button"&&x.textContent==="入力画面へ戻る");
const registering=r.register(),third=pending.shift();
await r.register();await r.save();back.onclick();r.openSaved(b);
check("registration locks back, draft selection and duplicate submissions",()=>{
 assert.equal(calls.length,5);assert.equal(r.state.id,"a");assert.equal(r.state.stage,"preview");
 assert.ok(walk(root).filter(x=>["button","select"].includes(x.tag)).every(x=>x.disabled));
});
r.state.draft.title="登録処理中の未保存変更";
third.resolve({item:{...copy(a),version:4,status:"registered",registeredAt:"2026-10-25T00:00:00Z",payload:second.body.payload}});await registering;
check("completion displays the registered original, not pending editor changes",()=>{
 assert.equal(r.state.stage,"complete");assert.equal(r.state.draft.title,"保存中に編集したタイトル");
 assert.equal(r.state.savedSignature,r.signature());assert.equal(r.state.dirty,false);
 assert.ok(app.buildDraft().includes("保存中に編集したタイトル"));
 assert.ok(!app.buildDraft().includes("登録処理中の未保存変更"));
});
const savedRoot=new Element("section");let opened=0;
app.mountSavedList(savedRoot,()=>opened++);
check("saved PR list shares authorized loaded records and labels registration honestly",()=>{
 assert.ok(walk(savedRoot).some(x=>x.textContent==="社内PR原稿"));
 assert.ok(walk(savedRoot).some(x=>x.textContent.includes("外部公開は別途確認")));
});
const listOpen=walk(savedRoot).find(x=>x.tag==="button"&&x.textContent==="原稿を開く");
r.state.dirty=true;listOpen.onclick();
check("stale list open handler cannot discard unsaved edits",()=>assert.equal(opened,0));
r.state.dirty=false;listOpen.onclick();
check("clean list open reuses editor without writes",()=>{assert.equal(opened,1);assert.equal(calls.length,5);});
r.state.items=Array.from({length:21},(_,i)=>({...copy(a),id:'saved-'+i}));r.render();
check("saved list paginates at twenty records",()=>assert.equal(walk(savedRoot).filter(x=>x.tag==="article").length,20));
walk(savedRoot).find(x=>x.tag==="button"&&x.textContent==="次へ").onclick();
check("saved list last page bounded",()=>assert.equal(walk(savedRoot).filter(x=>x.tag==="article").length,1));
r.state.ready=false;r.render();
check("unavailable saved list does not display records or claim zero",()=>{
 assert.equal(walk(savedRoot).filter(x=>x.tag==="article").length,0);
 assert.ok(walk(savedRoot).some(x=>x.textContent.includes("0件ではありません")));
});
console.log(`Marketing PR concurrency: ${count} checks passed (synthetic only)`);
