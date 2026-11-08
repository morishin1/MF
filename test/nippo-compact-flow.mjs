import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page=readFileSync(new URL("../nippo.html",import.meta.url),"utf8");
const code=readFileSync(new URL("../js/nippo-flow.js",import.meta.url),"utf8");
const scripts=[...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(m=>m[1]).filter(s=>s.trim());
for(const s of scripts)new Function(s);
new Function(code);

assert.match(page,/nippo-flow\.js\?v=20261108compact1/);
assert.match(page,/NippoFlow\?\.init\(\)/);
assert.match(page,/NippoFlow\?\.choose\(4,true\)/);
assert.match(page,/window\.NippoFlow\?\.showWeekPlan\(\)/);
assert.match(page,/updateNippoFlow\(\)/);

const all=[];
const $=id=>all.find(x=>x.id===id)||null;
function elem(tag="div",id="",classes=""){
  const x={
    tag,id,className:classes,hidden:false,open:false,attributes:{},parentNode:null,children:[],
    innerHTML:"",textContent:"",dataset:{},
    setAttribute(k,v){this.attributes[k]=v},
    removeAttribute(k){delete this.attributes[k];if(k==="open")this.open=false},
    appendChild(v){v.parentNode=this;this.children.push(v);return v},
    insertBefore(v,before){v.parentNode=this;this.children.splice(Math.max(0,this.children.indexOf(before)),0,v);return v},
    after(v){v.parentNode=this.parentNode},
    closest(){return this.parentNode},
    addEventListener(){},
    scrollIntoView(){},
    classList:{contains(k){return classes.split(" ").includes(k)},toggle(){}},
  };
  all.push(x);return x;
}
const pane=elem("div","pane-mine");
for(const id of ["np-flow-summary","np-flow-track","np-flow-message"])elem("div",id);
const entry=elem("section","np-submit-entry");
pane.appendChild(entry);
for(const id of ["thanks-card","am-card","push-card","mid-card","focus-card",
  "write-card","flags-card","ai-card","next-plan-card","wk-card",
  "np-schedule-gate","month-card","growth-card"]){
  const e=elem("div",id);
  pane.appendChild(e);
}
for(const id of ["team","past"]){
  const card=elem("div",id+"-card","card");
  const e=elem("div",id);
  pane.appendChild(card);card.appendChild(e);
}
$("am-card").classList.contains=k=>k==="hidden";
$("mid-card").classList.contains=k=>k==="hidden";
const doc={getElementById:$,createElement:t=>elem(t),head:{appendChild(){} }};
const win={};
new Function("document","window",code)(doc,win);
const flow=win.NippoFlow;
flow.init();
flow.sync({date:"2026-11-08",morningStarted:false,middayAvailable:false,focusCount:0,
  scheduleReady:false,closing:false,closingFilled:false,submitted:false});
assert.equal(flow.step(),1);
assert.equal($("np-flow-stage-1").hidden,false);
assert.equal($("np-flow-stage-4").hidden,true);
assert.match($("np-flow-track").innerHTML,/今日のゴール/);
assert.match($("np-flow-track").innerHTML,/日報を提出/);
assert.equal(($("np-flow-track").innerHTML.match(/data-np-flow-step=/g)||[]).length,4);
assert.ok($("np-flow-extra").children.some(e=>e.id==="month-card"));
assert.ok($("np-flow-extra").children.some(e=>e.id==="past-card"));
assert.equal($("np-schedule-gate").parentNode.id,"np-flow-stage-4");
assert.equal($("np-flow-weekplan").parentNode.id,"np-flow-stage-3");
flow.choose(3);
assert.equal($("np-flow-stage-3").hidden,false);
assert.equal($("np-flow-stage-1").hidden,true);
flow.showWeekPlan();
assert.equal($("np-flow-weekplan").open,true);
flow.sync({date:"2026-11-09",morningStarted:true,middayAvailable:false,focusCount:1,
  scheduleReady:true,closing:true,closingFilled:false,submitted:false});
assert.equal(flow.step(),4);
assert.equal($("np-flow-weekly").open,true);
assert.match($("np-flow-message").textContent,/週次振り返り/);
flow.sync({date:"2026-11-09",closingFilled:true,submitted:true});
assert.match($("np-flow-summary").textContent,/提出済/);
flow.choose(2);
assert.equal(flow.step(),2);
assert.match($("np-flow-track").innerHTML,/進捗確認/);
console.log("nippo compact 4-step UI: flow, required weekly, schedule gate, optional panels passed");
