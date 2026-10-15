import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const read=(p)=>readFileSync(new URL("../"+p, import.meta.url),"utf8");
const sql=read("db/136_hr_materials.sql");
const api=read("api/hr/materials.js");
const links=read("api/hr/interview-materials.js");
const detail=read("api/hr/applicants/detail.js");
const page=read("hr/materials.html");
const applicants=read("hr/applicants.html");
const layout=read("js/hr-layout.js");
const interviews=read("api/hr/interviews/index.js");

assert.match(sql,/create table if not exists public\.gw_hr_materials/);
assert.match(sql,/create table if not exists public\.gw_hr_interview_materials/);
assert.match(sql,/share_external.*boolean not null default false/);
assert.match(sql,/default_for_casual.*boolean not null default false/);
assert.match(sql,/kind = 'url'.*https:\/\//s);
assert.match(sql,/not share_external or kind = 'url'/);
assert.match(sql,/enable row level security/);

assert.match(api,/canRecruit\(ctx\)/);
assert.match(api,/materials\/\$\{crypto\.randomUUID\(\)\}\.pdf/);
assert.match(api,/createSignedUploadUrl/);
assert.match(api,/createSignedUrl/);
assert.match(api,/PDFは20MB以内/);

assert.match(links,/gw_hr_interview_materials/);
assert.match(links,/eq\("tenant_id",ctx\.tenantId\)/);
assert.match(links,/無効または別会社の資料/);

assert.match(detail,/materialCatalog/);
assert.match(detail,/materialsByInterview/);
assert.match(detail,/materialsReady/);

assert.match(layout,/key: "materials".*\/hr\/materials\.html.*label: "資料"/);
assert.match(page,/HRLayout\.init\(\{active:'materials'\}\)/);
assert.match(page,/候補者への案内メールにも共有できるURL/);

assert.match(interviews,/meeting_url_required/);
assert.match(interviews,/カジュアル面談は面談URLを入力してください/);
assert.match(applicants,/面談で使う資料/);
assert.match(applicants,/openInterviewMaterial/);
assert.match(applicants,/saveInterviewMaterials/);
assert.match(applicants,/defaultForCasual/);
assert.match(applicants,/shareExternal/);
assert.match(applicants,/面談URLが未登録です/);
assert.doesNotMatch(applicants,/\$\{ceoEvalSummary\(detail\)\}\s*\n\s*<button class="btn btn-secondary btn-sm" onclick="openScheduleForm/);

console.log("HR資料・面談UX: db/136 / API / UI の主要ルール OK");
