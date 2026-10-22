// HR スポット人材：公開アンケートの権限・流れ・既存画面との整合性
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Script } from "node:vm";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const sql=read("db/145_hr_spot_talents.sql");
const admin=read("api/hr/spot.js"),survey=read("api/hr/spot-survey.js");
const page=read("hr/spot.html"),publicPage=read("hr/spot-survey.html"),applicants=read("hr/applicants.html");
for(const p of ["api/hr/spot.js","api/hr/spot-survey.js"])execFileSync(process.execPath,["--check",new URL("../"+p,import.meta.url).pathname]);
for(const html of [page,publicPage]){
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
    if(m[1].trim())new Script(m[1]);
}
assert.match(sql,/create table if not exists public\.gw_hr_spot_talents/);
assert.match(sql,/enable row level security/);
assert.match(sql,/revoke all on public\.gw_hr_spot_talents from anon, authenticated/);
assert.match(sql,/for select to authenticated using \(public\.gw_is_recruiting\(tenant_id\)\)/);
assert.match(sql,/applicant_id uuid unique/);
assert.match(admin,/requireUser\(req,res\)/);
assert.match(admin,/!ctx\.tenantId\|\|!canRecruit\(ctx\)/);
assert.match(admin,/\.eq\("tenant_id",ctx\.tenantId\)/);
assert.match(admin,/randomBytes\(32\)/);
assert.match(admin,/createHash\("sha256"\)/);
assert.match(admin,/spot-survey\.html#token=/);
assert.match(admin,/p\.contact_consent/);
assert.match(admin,/p\.survey_answered_at/);
assert.match(admin,/existing_applicant/);
assert.match(admin,/concurrent_update/);
assert.match(admin,/\.is\("applicant_id",null\)/);
assert.match(admin,/!Number\.isInteger\(v\)/);
assert.match(survey,/methodNotAllowed\(res,\["POST"\]\)/);
assert.match(survey,/createHash\("sha256"\)/);
assert.match(survey,/\.eq\("survey_token_hash",hash\)/);
assert.match(survey,/new Date\(p\.survey_expires_at\)\.getTime\(\)<Date\.now\(\)/);
assert.match(survey,/\.is\("survey_answered_at",null\)/);
assert.match(survey,/contactConsent/);
assert.match(survey,/survey_email:a\.contactConsent\?email:null/);
assert.doesNotMatch(publicPage,/fonts\.googleapis|cdn\.|qrserver\.com|third-party/);
assert.match(publicPage,/location\.hash\.slice\(1\)/);
assert.match(publicPage,/history\.replaceState/);
assert.match(page,/vendor\/qrcode-generator\.js/);
assert.match(page,/function qrSvg\(/);
assert.match(page,/HRLayout\.init\(\{active:"applicants"\}\)/);
assert.match(applicants,/class="spot-link" href="\/hr\/spot\.html"/);
console.log("HRスポット人材：権限・同意・QR・選考引継ぎ・画面スクリプトの静的チェック OK");
