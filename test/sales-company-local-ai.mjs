import test from "node:test";
import assert from "node:assert/strict";
import { parseLocalAIResult,localAIMarkdown } from "../lib/sales-company-local-ai.js";
import { toEngerJobMatchInput,toEngerCandidateMatchReference,toEngerNeedDraft } from "../lib/sales-local-ai-matching-adapter.js";

const company="11111111-1111-4111-8111-111111111111";
const digest="a".repeat(64);
const valid={
 schema_version:"enger-company-matching-v1",company_id:company,source_hash:digest,
 company_summary:"登録情報と受領情報の要約です。",
 matching_requirements:[{
  direction:"talent",role:"Java開発エンジニア",role_labels:["バックエンドエンジニア"],skills:["Java","AWS"],
  salary_min:60,salary_max:90,work_style:"hybrid",location:"東京都",start_period:"2026年12月",
  start_date:"2026-12-01",required_experience_years:3,headcount:2,
  evidence_refs:["company_profile"],rationale:"商談メモからの仮説",
 }],
};
test("import checks strict company and source digest",()=>{
  assert.throws(()=>parseLocalAIResult(JSON.stringify({...valid,company_id:"22222222-2222-4222-8222-222222222222"}),company,digest,["company_profile"]),/企業ID/);
  assert.throws(()=>parseLocalAIResult(JSON.stringify({...valid,source_hash:"b".repeat(64)}),company,digest,["company_profile"]),/変更/);
  assert.throws(()=>parseLocalAIResult(JSON.stringify({...valid,matching_requirements:[{...valid.matching_requirements[0],evidence_refs:["unknown"]}]}),company,digest,["company_profile"]),/出典ID/);
});
test("local AI import becomes exact ENGER engine fields, without creating a real job",()=>{
  const parsed=parseLocalAIResult(JSON.stringify(valid),company,digest,["company_profile"]);
  const requirement=parsed.matching_requirements[0];
  const j=toEngerJobMatchInput(requirement);
  assert.equal(j.title,"Java開発エンジニア");
  assert.deepEqual(j.skills,["Java","AWS"]);
  assert.equal(j.remote_type,"partial_remote");
  assert.equal(j.work_location,"東京都");
  assert.equal(j.start_date,"2026-12-01");
  assert.equal(j.salary_min,60);
  assert.equal(j.salary_max,90);
  assert.equal(j.required_experience_years,3);
  assert.equal(j.confirmed,false);
  const need=toEngerNeedDraft(requirement,company,0);
  assert.equal(need.kind,"talent");
  assert.equal(need.isFocus,false);
  assert.equal(need.autoSend,false);
  assert.equal(need.isActive,false);
  assert.deepEqual(need.skills,["Java","AWS"]);
  assert.equal(need.roleLabels[0],"バックエンドエンジニア");
  assert.equal(need.startDate,"2026-12-01");
});
test("job direction does not invent an ENGER candidate",()=>{
  const r={direction:"job",role:"Python人材",skills:["Python"]};
  assert.equal(toEngerCandidateMatchReference(r),null);
  assert.equal(toEngerJobMatchInput(r),null);
  assert.equal(toEngerCandidateMatchReference({...r,source_candidate_id:company}).candidateId,company);
});
test("export is self-contained Markdown with stable source identifiers",()=>{
  const md=localAIMarkdown({company:{id:company,name:"株式会社テスト"},source_refs:["company_profile"]},digest);
  assert.match(md,/ENGER/);
  assert.ok(md.includes(company));
  assert.ok(md.includes(digest));
  assert.ok(md.includes("salary_min"));
  assert.ok(md.includes("source_candidate_id"));
});
