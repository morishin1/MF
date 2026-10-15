import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  HR_MATERIAL_CATEGORIES, HR_MATERIAL_MAX_BYTES, HR_MATERIAL_BUCKET,
  materialCategoryLabel, cleanMaterialName, cleanMaterialDescription, isHttpsUrl,
  normalizeMaterialIds, shapeHrMaterial,
} from "../lib/hr-materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const src = async (p) => readFile(join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== HR資料 定義 ===\n");

await ok("カテゴリは7種類", () => {
  assert.deepEqual(HR_MATERIAL_CATEGORIES.map((x) => x.key),
    ["company","recruiting","mugendojo","service","regional","ai_dx","other"]);
});
await ok("無限道場・地方創生・AI/DXの表示名", () => {
  assert.equal(materialCategoryLabel("mugendojo"), "無限道場");
  assert.equal(materialCategoryLabel("regional"), "地方創生");
  assert.equal(materialCategoryLabel("ai_dx"), "AI・DX");
});
await ok("PDFは既存private hr bucket・10MB上限", () => {
  assert.equal(HR_MATERIAL_BUCKET, "hr");
  assert.equal(HR_MATERIAL_MAX_BYTES, 10 * 1024 * 1024);
});
await ok("資料名・説明を整形", () => {
  assert.equal(cleanMaterialName("  会社案内  "), "会社案内");
  assert.equal(cleanMaterialDescription(" a\r\nb "), "a\nb");
});
await ok("外部URLはhttpsのみ", () => {
  assert.equal(isHttpsUrl("https://8grp.co.jp/"), true);
  assert.equal(isHttpsUrl("http://8grp.co.jp/"), false);
  assert.equal(isHttpsUrl("javascript:alert(1)"), false);
});
await ok("資料IDはUUIDだけ・重複除外", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(normalizeMaterialIds([a,a,b]), [a,b]);
  assert.equal(normalizeMaterialIds(["bad"]), null);
  assert.equal(normalizeMaterialIds(undefined), undefined);
});
await ok("API返却形はstorage_pathを外す", () => {
  const out = shapeHrMaterial({
    id:"m1",name:"会社案内",category:"company",kind:"file",storage_path:"secret/path.pdf",
    filename:"guide.pdf",mime_type:"application/pdf",size_bytes:1000,sort_order:10,is_active:true,
    share_external:false,default_for_casual:true,created_at:"x",updated_at:"y",
  });
  assert.equal(out.storage_path, undefined);
  assert.equal(out.url, null);
  assert.equal(out.defaultForCasual, true);
});

console.log("\n=== db/136 と画面の安全策 ===\n");

await ok("db/136は応募者書類テーブルを再利用しない", async () => {
  const s = await src("db/136_hr_materials_interview.sql");
  assert.match(s, /create table if not exists public\.gw_hr_materials/);
  assert.match(s, /create table if not exists public\.gw_hr_interview_materials/);
  assert.doesNotMatch(s, /alter table public\.gw_hr_documents/);
});
await ok("URL/PDFの排他・https・PDF外部共有禁止をDBでも守る", async () => {
  const s = await src("db/136_hr_materials_interview.sql");
  assert.match(s, /gw_hr_materials_source_chk/);
  assert.match(s, /gw_hr_materials_https_chk/);
  assert.match(s, /gw_hr_materials_external_chk/);
  assert.match(s, /not share_external or kind = 'url'/);
});
await ok("2表ともRLS有効・採用HRのSELECTのみ", async () => {
  const s = await src("db/136_hr_materials_interview.sql");
  assert.match(s, /alter table public\.gw_hr_materials enable row level security/);
  assert.match(s, /alter table public\.gw_hr_interview_materials enable row level security/);
  assert.match(s, /for select using \(public\.gw_is_recruiting\(tenant_id\)\)/);
  assert.doesNotMatch(s, /for (insert|update|delete)/i);
});
await ok("PDFはtenant/materials配下、署名付きURL", async () => {
  const s = await src("api/hr/materials.js");
  assert.match(s, /ctx\.tenantId \+ "\/materials\/"/);
  assert.match(s, /createSignedUploadUrl/);
  assert.match(s, /createSignedUrl/);
  assert.match(s, /%PDF-/);
});
await ok("PDF外部共有はAPIでも拒否", async () => {
  const s = await src("api/hr/materials.js");
  assert.match(s, /PDFの候補者向け外部共有は今回対象外です/);
  assert.match(s, /PDFは外部共有できません/);
});
await ok("HRナビは CEO REVIEW → 資料 → メールひな型", async () => {
  const s = await src("js/hr-layout.js");
  const ceo=s.indexOf('key: "ceo"'), mat=s.indexOf('key: "materials"'), mail=s.indexOf('key: "templates"');
  assert.ok(ceo >= 0 && ceo < mat && mat < mail);
});
await ok("資料画面は390pxで1列", async () => {
  const s = await src("hr/materials.html");
  assert.match(s, /@media\(max-width:720px\)\{\.hm-grid\{grid-template-columns:1fr\}/);
  assert.match(s, /@media\(max-width:390px\)/);
});
await ok("面談カードに資料ボタン・URLなし警告", async () => {
  const s = await src("hr/applicants.html");
  assert.match(s, /interviewMaterialButtons\(i\)/);
  assert.match(s, /面談URLが未登録です/);
  assert.match(s, /openInterviewMaterial/);
});
await ok("面談一覧はscheduledAtで昇順", async () => {
  const s = await src("hr/applicants.html");
  assert.match(s, /function orderedInterviews\(\)/);
  assert.match(s, /return ta - tb/);
});
await ok("面談タブはCEO評価サマリーを別表示しない", async () => {
  const s = await src("hr/applicants.html");
  const start=s.indexOf('} else if (detailTab === "interviews")');
  const end=s.indexOf('} else if (detailTab === "eval")', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(s.slice(start,end), /ceoEvalSummary/);
});
await ok("手動カジュアル面談はURL必須をAPIでも守る", async () => {
  const s = await src("api/hr/interviews/index.js");
  assert.match(s, /row\.value\.kind === "casual" && !row\.value\.meeting_url/);
  assert.match(s, /meeting_url_required/);
});
await ok("面談資料リンクはtenant内のactive資料だけ受け付ける", async () => {
  const s = await src("api/hr/interviews/index.js");
  assert.match(s, /\.eq\("tenant_id", ctx\.tenantId\)/);
  assert.match(s, /\.eq\("is_active", true\)\.in\("id", ids\)/);
  assert.match(s, /無効または別会社の資料が含まれています/);
});

console.log("\n合計 " + (pass + fail) + " 件中 " + pass + " 件 通過");
process.exit(fail ? 1 : 0);
