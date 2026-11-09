import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {toPublicTalent,publicSkillSheet,publicTalentSummary} from "../lib/enger-talent-public.js";

const file=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const html=file("../sales/company-meeting.html");
const stages=file("../js/sales-meeting-five-stage.js");
const api=file("../api/sales/company-meeting-screen.js");

test("Six-step Sales meeting introduces Eight's company and services before proposals",()=>{
  assert.match(html,/id="meeting-eight-intro"/);
  assert.match(html,/https:\/\/8grp\.co\.jp\/recruit\/#about/);
  assert.match(html,/AI・DX開発/);
  assert.match(html,/ENGER/);
  assert.match(html,/無限道場/);
  assert.match(stages,/intro\.hidden=viewed!==0/);
  assert.match(stages,/proposals\.hidden=viewed!==3&&viewed!==4&&viewed!==5/);
  assert.match(html,/id="meeting-closeout"/);
  assert.match(html,/id="meeting-send"/);
});

test("Sales meeting can filter published recommendations and open public-detail modal",()=>{
  assert.match(html,/id="meeting-candidate-query"/);
  assert.match(html,/id="meeting-candidate-kind"/);
  assert.match(html,/function filterCandidates\(\)/);
  assert.match(html,/card\.hidden=!matched/);
  assert.match(html,/id="meeting-candidate-dialog"/);
  assert.match(html,/showCandidateSheet\(item\)/);
  assert.match(html,/meeting-sheet-rows/);
  assert.match(html,/meeting-sheet-csv/);
  assert.match(html,/formula injection/);
  assert.match(html,/meeting-offer-select/);
});

test("API returns only public-approved candidates, whitelisted skill sheet fields",()=>{
  assert.match(api,/companyInScope\(db,ctx\.tenantId,id\)/);
  assert.match(api,/\.eq\("status","published"\)/);
  assert.match(api,/filter\(isPublicTalent\)/);
  assert.match(api,/filter\(jobAvailable\)/);
  assert.match(api,/publicSkillSheet\(safe\)/);
  assert.match(api,/ENGER 公開用案件情報/);
  assert.doesNotMatch(api,/select\("\*"\)/);
});

test("public skill-sheet output does not leak private source fields",()=>{
  const source={
    candidate_no:123,initials:"AA",title:"インフラエンジニア",
    skills:["AWS","Linux"],exp:"5年",remote_pref:"full_remote",
    name:"SECRET_PERSON",email:"SECRET_EMAIL",phone:"SECRET_PHONE",
    affiliation:"SECRET_AFFILIATION",rate:"SECRET_RATE",note:"SECRET_NOTE",
    skill_sheet_url:"SECRET_FILE_URL"
  };
  const sheet=publicSkillSheet(toPublicTalent(source));
  const printed=JSON.stringify(sheet);
  assert.match(printed,/AWS/);
  assert.match(printed,/公開用スキルシート/);
  for(const secret of ["SECRET_PERSON","SECRET_EMAIL","SECRET_PHONE","SECRET_AFFILIATION","SECRET_RATE","SECRET_NOTE","SECRET_FILE_URL"])
    assert.ok(!printed.includes(secret),secret+" was exposed");
  assert.ok(sheet.rows.every(r=>Array.isArray(r)&&r.length===2));
});

test("Sales staff meeting shows a candidate summary derived only from the published projection",()=>{
  assert.match(html,/id="meeting-public-summary"/);
  assert.match(html,/meeting-public-summary-text/);
  assert.match(html,/サマリー・スキルシートを見る/);
  assert.match(api,/publicTalentSummary\(safe\)/);
  const raw={id:"aaaaaaaa-0000-4000-8000-000000000001",candidate_no:123,
    initials:"A.B.",title:"インフラエンジニア",skills:["Linux","AWS"],
    exp:"6年",avail:"即日",source_company:"株式会社機密",rate:"75万円",
    note:"顧客Aの原価85万円",detail_note:"株式会社秘密会社"};
  const projection=toPublicTalent(raw);
  const result=JSON.stringify({summary:publicTalentSummary(projection),sheet:publicSkillSheet(projection)});
  assert.match(result,/AWS/);
  for(const sensitive of ["株式会社機密","株式会社秘密会社","75万円","85万円","原価"])
    assert.ok(!result.includes(sensitive), sensitive+" exposed");
});
