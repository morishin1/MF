// HR応募分析：既存応募者のデータだけを集計。応募動機などの未記録を推測しない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext, Script } from "node:vm";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const js=read("js/hr-applicant-analytics.js");
const window={};
runInNewContext(js,{window,Date,Map,Set,Math,Number,String});
const A=window.HRApplicantAnalytics;
const people=[
 {createdAt:"2026-10-23T00:15:00+09:00",source:"Wantedly",jobTitle:"AIまち運営",status:"todo",stage:"applied",interviewCount:0},
 {createdAt:"2026-10-01T14:00:00+09:00",source:"Wantedly",jobTitle:"エンジニア",status:"passed",stage:"casual_interview",interviewCount:1},
 {createdAt:"2026-09-24T00:01:00+09:00",source:"紹介",jobTitle:"AIまち運営",status:"declined",stage:"ceo_interview",interviewCount:1},
 {createdAt:"2026-09-23T23:59:00+09:00",source:"紹介",jobTitle:"営業",status:"accepted",stage:"offer",interviewCount:2},
 {createdAt:"2026-08-10T10:00:00+09:00",source:"SNS",jobTitle:"営業",status:"todo",stage:"applied",interviewCount:0}
];
const d30=A.summarize(people,30,"2026-10-23");
assert.equal(d30.total,3,"30日コホートの日付境界はJST");
assert.equal(d30.interviewRecords,2,"面談記録のある人を集計する");
assert.equal(d30.offerStage,0,"過去の内定者を現在の内定段階として誤認しない");
assert.equal(d30.statusCounts.passed,1);
assert.equal(d30.statusCounts.declined,1);
assert.equal(d30.sources.find(x=>x[0]==="Wantedly")[1],2);
assert.equal(d30.jobs.find(x=>x[0]==="AIまち運営")[1],2);
const view=A.render(d30);
assert.match(view.kpi,/対象期間の応募/);
assert.match(view.outcomes,/見送り・不採用/);
assert.doesNotMatch(JSON.stringify(view),/応募理由：.+確定/,"理由を創作しない");
assert.equal(A.escapeText("<img onerror=alert(1)>"),"&lt;img onerror=alert(1)&gt;");
const page=read("hr/index.html"),nav=read("js/hr-layout.js"),apps=read("hr/applicants.html");
for(const src of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
 if(src[1].trim())new Script(src[1]);
assert.match(page,/HRApplicantAnalytics\.summarize/);
assert.match(page,/応募動機・応募経路の詳しい理由：未収集/);
assert.match(nav,/href: "\/hr\/applicants\.html", label: "ダッシュボード"/);
assert.match(nav,/href: "\/hr\/", label: "応募分析"/);
assert.match(apps,/<h1 class="hr-title">採用ダッシュボード<\/h1>/);
console.log("HR応募分析：JST・期間・媒体・職種・段階・未記録・XSS・ナビ 静的チェック OK");
