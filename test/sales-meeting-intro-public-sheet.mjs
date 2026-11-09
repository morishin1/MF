import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {toPublicTalent,publicSkillSheet} from "../lib/enger-talent-public.js";

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
