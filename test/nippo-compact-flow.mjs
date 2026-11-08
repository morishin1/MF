import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const page=readFileSync(new URL("../nippo.html",import.meta.url),"utf8");
const code=readFileSync(new URL("../js/nippo-flow.js",import.meta.url),"utf8");
for(const m of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
  if(m[1].trim())new Function(m[1]);
new Function(code);
assert.match(page,/nippo-flow\.js\?v=20261030officeactions1/);
const all=[];
const $=id=>all.find(x=>x.id===id)||null;
function element(tag="div",id="",classes=""){
  const a={tag,id,className:classes,hidden:false,open:false,attributes:{},
    parentNode:null,children:[],innerHTML:"",textContent:"",value:"",dataset:{},
    setAttribute(k,v){this.attributes[k]=v},
    removeAttribute(k){delete this.attributes[k];if(k==="open")this.open=false},
    appendChild(c){c.parentNode=this;this.children.push(c);return c},
    insertBefore(c,b){c.parentNode=this;this.children.splice(Math.max(0,this.children.indexOf(b)),0,c);return c},
    after(c){c.parentNode=this.parentNode},
    closest(){return this.parentNode},addEventListener(){},scrollIntoView(){},
    classList:{contains(k){return classes.split(" ").includes(k)},toggle(){},add(){},remove(){}},
  };
  all.push(a);return a;
}
const pane=element("div","pane-mine");
for(const id of ["np-flow-summary","np-flow-track","np-flow-message","np-flow-date"])element("div",id);
const entry=element("section","np-submit-entry");pane.appendChild(entry);
for(const id of ["thanks-card","am-card","push-card","mid-card","focus-card","write-card",
  "flags-card","ai-card","next-plan-card","wk-card","np-schedule-gate","month-card","growth-card"]){
  pane.appendChild(element("div",id));
}
for(const id of ["f-work","f-wins","f-consult","f-improve"]){
  const section=element("div",id+"-section","np-sec");
  const field=element("div",id);section.appendChild(field);
  $("write-card").appendChild(section);
}
for(const id of ["team","past"]){
  const card=element("div",id+"-card","card");
  const child=element("div",id);pane.appendChild(card);card.appendChild(child);
}
$("am-card").classList.contains=k=>k==="hidden";
$("mid-card").classList.contains=k=>k==="hidden";
const dom={getElementById:$,createElement:tag=>element(tag),head:{appendChild(){}}};
const win={};
let ready={outcome:false,reflection:false};
win.NippoFlowReadiness=()=>ready;
new Function("document","window",code)(dom,win);
const flow=win.NippoFlow;flow.init();
flow.sync({date:"2026-11-09",goalConfirmed:false,submitted:false,
  todayGoal:{goalText:"提案資料を整理",doneWhen:"提案送信"},scheduleReady:true});
assert.equal(flow.step(),1);
assert.ok($("np-flow-track").innerHTML.includes("今日の成果"));
assert.ok($("np-flow-track").innerHTML.includes("明日のゴール"));
assert.equal(($("np-flow-track").innerHTML.match(/data-np-flow-step=/g)||[]).length,4);
assert.equal($("f-work-section").parentNode.id,"np-flow-stage-1");
assert.equal($("f-improve-section").parentNode.id,"np-flow-stage-2");
assert.equal($("np-flow-goal-form").parentNode.id,"np-flow-stage-3");
assert.equal($("np-schedule-gate").parentNode.id,"np-flow-stage-4");
assert.equal($("np-flow-weekplan").parentNode.id,"np-flow-stage-3");
assert.equal($("np-flow-date").value,"2026-11-09");
flow.choose(2);assert.equal(flow.step(),1); // first report must be written
ready={outcome:true,reflection:false};
flow.choose(2);assert.equal(flow.step(),2);
flow.choose(3);assert.equal(flow.step(),2); // reflection required
ready={outcome:true,reflection:true};
flow.choose(3);assert.equal(flow.step(),3);
flow.choose(4);assert.equal(flow.step(),4); // tomorrow's goal is OPTIONAL
assert.match($("np-flow-message").textContent,/ゴールは未設定/);
flow.sync({date:"2026-11-09",goalConfirmed:false,closing:true,closingFilled:false});
assert.equal($("np-flow-weekly").open,true);
assert.match($("np-flow-message").textContent,/週次振り返り/);
flow.sync({date:"2026-11-09",goalConfirmed:false,submitted:true});
assert.match($("np-flow-summary").textContent,/提出済/);
assert.ok($("np-flow-extra").children.some(x=>x.id==="month-card"));
console.log("nippo tomorrow-goal 4-step UI: all cases passed");