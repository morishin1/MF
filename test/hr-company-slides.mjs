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
assert.match(interview,/会社紹介の説明文（担当者用）/);
assert.ok(!interview.includes("参考評価5項目を入力してください"),"reference scoring cannot block interview completion");
assert.match(interview,/表示する資料/);
assert.match(interview,/追加する資料のURLを貼り付け/);
assert.match(interview,/HrInterviewNavigator\.chooseAnswer/);
assert.match(interview,/API\.api\("\/api\/hr\/materials"/);
assert.match(interview,/◆選択回答/);
const sourceContext={URL};
runInNewContext(read("js/hr-interview-sources.js"),sourceContext);
const source=sourceContext.HRInterviewSources;
assert.equal(source.VISION_URL,"https://8grp.co.jp/recruit/vision/");
assert.equal(source.safeUrl("https://docs.google.com/presentation/d/abcDEF123/edit"),"https://docs.google.com/presentation/d/abcDEF123/edit");
assert.match(source.embedUrl("https://docs.google.com/presentation/d/abcDEF123/edit"),/abcDEF123\/embed/);
assert.equal(source.safeUrl("javascript:alert(1)"),"");
assert.equal(source.safeUrl("http://example.com"),"");
assert.equal(source.safeUrl("https://gw.8grp.co.jp/hr/applicants.html"),"");
assert.equal(source.fromMaterial({id:"mat",kind:"url",active:true,shareExternal:false,url:"https://example.com"}),null);
const answersCtx={};
runInNewContext(read("js/hr-interview-choices.js"),answersCtx);
const questionModel=answersCtx.HRInterviewChoices;
assert.deepEqual(Array.from(questionModel.steps).map(x=>x.length),[2,2,3,3,3,3]);
assert.deepEqual(
 [...questionModel.normalize({motivation:"事業に興味がある",interest:["AIまち","無限道場","偽の値"],unknown:"x"}).interest],
 ["AIまち","無限道場"]);

for(const html of [interview,read("hr/interview-presentation.html")]){
 const scripts=[...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean);
 assert.ok(scripts.length);
 for(const code of scripts)new Script(code);
}
const onlyCandidate=read("hr/interview-presentation.html");
assert.ok(!onlyCandidate.includes("applicantId"),"candidate-only page must not load applicant details");
assert.ok(!onlyCandidate.includes("hrInterviewAct"),"candidate-only page must not access HR API");
assert.match(onlyCandidate,/HRCompanySlides\.card/);
console.log("PASS: official vision default, safe URL library, click-based answers, seven optional slides, six-stage flow and candidate-only view");
