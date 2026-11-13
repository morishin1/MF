// Contract page and Office/KEIEI document buttons: render regression without browser setup.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memberLifecycle, LIFECYCLE_PHASES } from "../lib/member-document-lifecycle.js";

const pageSource=readFileSync(new URL("../admin-contracts.html",import.meta.url),"utf8");
const memberSource=readFileSync(new URL("../js/member-documents.js",import.meta.url),"utf8");
const scripts=[...pageSource.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(m=>m[1]).filter(s=>s.trim());
assert.equal(scripts.length,2);
for(const s of scripts)new Function(s);
new Function(memberSource);

const e={id:"11111111-1111-4111-8111-111111111111",display_name:"確認用 太郎",
  employment_type:"契約社員",employee_kind:"proper",status:"active"};
const lifecycle=memberLifecycle(e);
const summary={employeeId:e.id,name:e.display_name,employmentType:e.employment_type,
  employeeStatus:"active",displayState:"working",employmentStatus:"在籍中",contractStatus:"契約情報のみ",missingCount:2,reviewCount:0,
  requiredConfigured:true,requiredCount:3,receivedCount:1,contractAlert:null,lifecycle};

const nodes=new Map();
const dom={
  getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:"",textContent:"",value:"",open:false,scrollIntoView(){}});return nodes.get(id);},
  addEventListener(){},
  createElement(){return {id:"",textContent:"",innerHTML:""};},
  head:{appendChild(){}},
};
const layout={esc:x=>String(x??""),warm(){},init(){return {then(){}};}};
const js=scripts.at(-1);
const app=new Function("document","KPLayout","API","KPDrop","MemberDocs",
  js+"\nreturn {setRows(rows){memberRows=rows;renderMemberOverview()},setMemberFilter};")(
    dom,layout,{}, {}, {summaries(){},openDocument(){},open(){}});
app.setRows([{...summary,employeeId:"hidden-member",name:"非表示の人",displayState:"hidden"},summary]);
const out=nodes.get("ct-member-overview").innerHTML;
assert.ok(!out.includes("非表示の人"), "非表示のメンバーを稼働中に混在させない");
const renderedPhases=[...out.matchAll(/class="ct-life-phase" data-phase="([^"]+)"/g)].map(m=>m[1]);
assert.deepEqual(renderedPhases,LIFECYCLE_PHASES.map(p=>p.key));
assert.equal((out.match(/class="ct-life-button /g)||[]).length,lifecycle.buttons.length);
assert.equal((out.match(/MemberDocs.openDocument/g)||[]).length,lifecycle.buttons.length);
assert.ok(out.includes("退職証明書")&&out.includes("振込口座")&&out.includes("雇用契約"));
app.setMemberFilter("q","存在しない");
assert.ok(!nodes.get("ct-member-overview").innerHTML.includes("確認用 太郎"));

// Shared compact buttons in the Office and KEIEI member tables.
const win={};
const memberFns=new Function("window","document",memberSource+"\nreturn window.MemberDocs;")(win,dom);
const office=memberFns.rail(summary,{context:"office"});
const keiei=memberFns.rail(summary,{context:"keiei"});
for(const html of [office,keiei]){
  assert.equal((html.match(/class='md-rail-button /g)||[]).length,lifecycle.buttons.length);
}
assert.ok(office.includes("onUpdated:render"));
assert.ok(keiei.includes("onUpdated:KeieiMembers.onDocuments"));
console.log("document lifecycle UI: all render checks passed");
