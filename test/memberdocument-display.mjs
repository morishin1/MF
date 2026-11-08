// Display-only working / inactive / hidden classification in Office document register.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultDisplayState,memberDisplayState,memberDisplayCounts,isDisplayState } from "../lib/member-document-display.js";

assert.equal(defaultDisplayState({status:"active"}),"working");
for(const status of ["invited","leaving","left"])assert.equal(defaultDisplayState({status}),"inactive");
assert.equal(memberDisplayState({status:"active"},"hidden"),"hidden");
assert.equal(memberDisplayState({status:"left"},"working"),"working");
assert.equal(memberDisplayState({status:"left"},"invalid"),"inactive");
assert.equal(isDisplayState("hidden"),true);
assert.equal(isDisplayState("deleted"),false);
assert.deepEqual(memberDisplayCounts([{displayState:"working"},{displayState:"inactive"},{displayState:"hidden"}]),
  {working:1,inactive:1,hidden:1});

const html=readFileSync(new URL("../admin-contracts.html",import.meta.url),"utf8");
assert.ok(html.includes("max-width:none!important"));
assert.ok(html.includes("flex-flow:row wrap!important"));
assert.ok(html.includes(".ct-life-scroll{overflow:visible!important"));
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(m=>m[1]).filter(Boolean);
for(const src of scripts)new Function(src);
const main=scripts.at(-1);
const nodes=new Map();
const doc={
  getElementById(id){
    if(!nodes.has(id))nodes.set(id,{innerHTML:"",textContent:"",value:"",scrollIntoView(){}});
    return nodes.get(id);
  },
};
const layout={esc:x=>String(x??""),warm(){},init(){return {then(){}}}};
const calls=[];
let shouldFail=false;
const api={api:async(path,args)=>{
  calls.push([path,args?.body]);
  if(shouldFail)throw new Error("test failure");
  return {ok:true,displayState:args?.body?.displayState};
}};
const page=new Function("document","KPLayout","API","KPDrop","MemberDocs",
  main+"\nreturn {setRows(v){memberRows=v;renderMemberOverview()},setMemberTab,changeMemberDisplay};")(
    doc,layout,api,{}, {summaries(){},openDocument(){},open(){}});
const mk=(id,status)=>({
  employeeId:id,name:id,employeeStatus:status,displayReady:true,
  employmentType:"契約社員",employmentStatus:status==="active"?"在籍中":"退職",
  contractStatus:"契約書未確認",contractAlert:null,missingCount:0,
  lifecycle:{phases:[{key:"recruit",label:"採用時"}],
    buttons:[{phase:"recruit",key:"resume",label:"履歴書",state:"check"}]},
});
const people=[...Array.from({length:14},(_,i)=>mk("work"+i,"active")),
  ...Array.from({length:5},(_,i)=>mk("idle"+i,"left"))];
page.setRows(people);
const result=()=>nodes.get("ct-member-overview").innerHTML;
const tabs=()=>nodes.get("ct-member-tabs").innerHTML;
assert.ok(result().includes("work0")&&!result().includes("idle0"));
assert.ok(tabs().includes('ct-member-tab-count">14</span>') &&
  tabs().includes('ct-member-tab-count">5</span>'));
assert.ok(result().includes("type=\"checkbox\"")&&result().includes("data-state=\"hidden\""));
page.setMemberTab("inactive");
assert.ok(result().includes("idle0")&&!result().includes("work0"));
page.setMemberTab("working");
await page.changeMemberDisplay("work0","inactive",{checked:true});
assert.ok(!result().includes("work0"));
assert.ok(tabs().includes('ct-member-tab-count">13</span>') &&
  tabs().includes('ct-member-tab-count">6</span>'));
page.setMemberTab("inactive");
await page.changeMemberDisplay("work0","hidden",{checked:true});
assert.ok(!result().includes("work0"));
page.setMemberTab("hidden");
assert.ok(result().includes("work0"));
assert.equal(calls.length,2);
assert.deepEqual(calls.map(x=>x[1].displayState),["inactive","hidden"]);
shouldFail=true;
await page.changeMemberDisplay("work0","working",{checked:true});
assert.ok(result().includes("work0")); // failed API save must not move the employee
assert.ok(nodes.get("ct-display-message").textContent.includes("更新に失敗"));
console.log("member document display: 3-state persistence UI, filtering and 100%-width CSS checks passed");
