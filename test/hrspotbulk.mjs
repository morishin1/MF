// HR スポット人材：バルク変更・アンケート紐づけ・件数表示の回帰テスト
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {Script} from "node:vm";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const files=["api/hr/spot.js","api/hr/spot-survey.js","hr/spot.html","hr/spot-survey.html","hr/applicants.html"];
for(const p of files.filter(p=>p.endsWith(".js")))execFileSync(process.execPath,["--check",new URL("../"+p,import.meta.url).pathname]);
for(const p of files.filter(p=>p.endsWith(".html"))){
  for(const m of read(p).matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/g))
    if(m[1].trim())new Script(m[1]);
}
const page=read("hr/spot.html"),survey=read("hr/spot-survey.html");
const api=read("api/hr/spot.js"),publicApi=read("api/hr/spot-survey.js");
const app=read("hr/applicants.html"),sql=read("db/146_hr_spot_bulk.sql");
const checks=[
  [page,/id="selectAll"/,"bulk all checkbox"],
  [page,/data-check/,"row checkbox"],
  [page,/bulkCandidate/,"bulk candidate"],
  [page,/bulkClosed/,"bulk closed"],
  [page,/bulkArchive/,"archive action"],
  [page,/bulkRestore/,"restore action"],
  [page,/selected.size>=50/,"50 row limit"],
  [page,/function openEdit/,"edit drawer"],
  [page,/survey_phone/,"telephone shown"],
  [page,/id="count-active"/,"active count"],
  [page,/id="count-contractor"/,"contractor count"],
  [page,/id="count-mugendojo"/,"mugendojo count"],
  [page,/id="count-spot"/,"spot count"],
  [page,/id="count-closed"/,"closed count"],
  [page,/loadApplicantCounts/,"linked applicant counts"],
  [app,/loadSpotCount/,"spot count on applicant tabs"],
  [app,/spotCount===null/,"missing-count UI"],
  [api,/already_registered/,"duplicate name guard"],
  [api,/\.eq\("name",name\)/,"existing name lookup"],
  [api,/gw_hr_spot_bulk/,"atomic bulk RPC"],
  [api,/\.is\("deleted_at",null\)/,"exclude deleted"],
  [publicApi,/name:p\.name/,"existing name bound to token"],
  [publicApi,/survey_phone:a\.contactConsent\?phone:null/,"save consented phone"],
  [publicApi,/\.eq\("survey_token_hash",hash\)/,"one-person token matching"],
  [survey,/registeredName/,"read-only registered name"],
  [survey,/input type="tel"/,"phone field"],
  [survey,/input type="email"/,"email field"],
  [sql,/survey_phone text/,"phone migration"],
  [sql,/deleted_at timestamptz/,"soft-delete column"],
  [sql,/for update/,"row locks"],
  [sql,/v_count <> v_n/,"atomic count check"],
  [sql,/grant execute.*service_role/,"only service role execute"]
];
for(const [content,pattern,label] of checks)assert.match(content,pattern,label);
assert.doesNotMatch(sql,/delete from public\.gw_hr_spot_talents/i,"no physical delete");
assert.match(publicApi,/survey_answered_at/);
console.log("HR spot bulk/survey/counts static regression checks OK ("+checks.length+")");
