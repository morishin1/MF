// Company presentation is public-only; staff notes and interview records remain in HR.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, runInNewContext } from "node:vm";
const read=(path)=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const deck=read("js/hr-company-slides.js");
const sandbox={};
runInNewContext(deck,sandbox);
const slides=sandbox.HRCompanySlides;
assert.equal(slides.slides.length,7,"candidate deck is limited to seven slides");
assert.ok(slides.slides.every(s=>s.title&&s.lead&&s.points.length===3&&s.talk&&s.evidence),"each slide includes a claim, proof note and presenter script");
for(let i=0;i<slides.slides.length;i++){
 const html=slides.card(i);
 assert.match(html,/class="eight-slide"/);
 assert.ok(!html.includes(slides.slides[i].talk),"candidate deck must never include private presenter script");
 assert.ok(!html.includes(slides.slides[i].evidence),"candidate deck must never include presenter-only evidence notes");
}
assert.equal(slides.esc("<b>&"),"&lt;b&gt;&amp;");
const interview=read("hr/interviews.html");
const stepBlock=interview.match(/const steps=\[([\s\S]*?)\];\nconst dimensions=/);
assert.ok(stepBlock,"interview steps exist");
const names=[...stepBlock[1].matchAll(/title:"([^"]+)",time:(\d+)/g)].map(m=>[m[1],Number(m[2])]);
assert.deepEqual(names,[["導入",2],["会社紹介",8],["経験・希望",8],["仕事の提案",6],["条件・質問",4],["次の案内",2]]);
assert.equal(names.reduce((sum,x)=>sum+x[1],0),30);
assert.match(interview,/候補者に見せる画面を開く/);
assert.match(interview,/担当者が話す内容/);
assert.ok(!interview.includes("参考評価5項目を入力してください"),"reference scoring cannot block interview completion");
for(const html of [interview,read("hr/interview-presentation.html")]){
 const scripts=[...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean);
 assert.ok(scripts.length);
 for(const code of scripts)new Script(code);
}
const onlyCandidate=read("hr/interview-presentation.html");
assert.ok(!onlyCandidate.includes("applicantId"),"candidate-only page must not load applicant details");
assert.ok(!onlyCandidate.includes("hrInterviewAct"),"candidate-only page must not access HR API");
assert.match(onlyCandidate,/HRCompanySlides\.card/);
console.log("PASS: seven presentation slides, 30-minute flow, private script separation, safe candidate view and syntax");
