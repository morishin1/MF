// Word雛形からの書類発行（共通基盤）。架空の雛形だけを使う。実在の契約書・個人情報は使わない。
import assert from "node:assert/strict";
import { readZip, writeZip, listPlaceholders, fillTemplate, inspectTemplate, extractText, sha256, crc32 } from "../lib/hr-docx.js";
import { validateTemplate, valuesFor, issueDocument, DOC_KINDS, TEMPLATE_CATEGORIES, FIELDS, issueFilename } from "../lib/hr-contract-template.js";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (t, rpr = "") => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (...runs) => `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${runs.join("")}</w:p>`;
const cell = (inner) => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc>`;
// 条項（差し込みの無い段落）。発行しても1文字も変わってはいけない
const CLAUSES = [
  para(run("第1条（契約期間）", "<w:b/>")),
  para(run("甲は乙を次の条件で雇用し、乙はこれに従い誠実に勤務する。")),
  para(run("第2条（秘密保持）", "<w:b/>")),
  para(run("乙は、在職中および退職後も、業務上知り得た秘密を第三者に漏らしてはならない（A &amp; B を含む）。")),
];
const body = [
  para(run("雇用契約書", '<w:b/><w:sz w:val="32"/>')),
  // Word が1つの差し込みを複数の <w:t> に分けて保存した場合
  para(run("{{会社"), run("名}}", "<w:b/>"), run("（以下「甲」という）と "), run("{{氏"), run("名"), run("}}"), run("（以下「乙」という）は、次のとおり契約する。")),
  CLAUSES[0], CLAUSES[1],
  `<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tr>${cell(para(run("契約期間")))}${cell(para(run("{{契約期間}}")))}</w:tr><w:tr>${cell(para(run("賃金")))}${cell(para(run("{{賃金形態}} {{賃金額}}")))}</w:tr><w:tr>${cell(para(run("就業場所")))}${cell(para(run("{{就業場所}}")))}</w:tr></w:tbl>`,
  CLAUSES[2], CLAUSES[3],
  para(run("{{契約締結日}}")),
].join("");
const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
const footerXml = `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${W}>${para(run("{{会社名}}"))}</w:ftr>`;
const stylesXml = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:styleId="Normal"/></w:styles>`;
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 250, 251, 252]);
const parts = (doc = documentXml, extra = []) => [
  { name: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
  { name: "word/document.xml", data: Buffer.from(doc) },
  { name: "word/footer1.xml", data: Buffer.from(footerXml) },
  { name: "word/styles.xml", data: Buffer.from(stylesXml) },
  { name: "word/media/seal.png", data: image, method: 0 },
  ...extra,
];
const template = writeZip(parts());

// ---- zip ----
assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
const back = readZip(template);
assert.deepEqual(back.map((e) => e.name), parts().map((e) => e.name), "部品の並びを保つ");
for (const e of parts()) assert.ok(back.find((x) => x.name === e.name).data.equals(e.data), e.name + " の中身を保つ");
assert.ok(writeZip(parts()).equals(template), "同じ入力からは同じバイト列");
assert.throws(() => readZip(Buffer.from("not a zip at all, definitely not")), /docx_invalid/);
assert.throws(() => readZip(template.subarray(0, template.length - 5)), /docx_invalid/);
{ const bad = Buffer.from(template); bad[30 + "[Content_Types].xml".length + 6] ^= 0xff; assert.throws(() => readZip(bad), /docx_invalid/, "壊れた中身は読まない"); }

// ---- 差し込み項目の読み取り（分割された文字もつなげて読む） ----
assert.deepEqual(listPlaceholders(template), ["会社名", "氏名", "契約期間", "賃金形態", "賃金額", "就業場所", "契約締結日"]);
const info = inspectTemplate(template);
assert.equal(info.sha256, sha256(template)); assert.equal(info.placeholders.length, 7);
assert.throws(() => inspectTemplate(writeZip(parts().filter((e) => e.name !== "word/document.xml"))), /docx_not_word/);
assert.throws(() => inspectTemplate(writeZip(parts(documentXml, [{ name: "word/vbaProject.bin", data: Buffer.from("x") }]))), /docx_macro/, "マクロ入りは受け付けない");

// ---- 差し込み：条項・表・書式は変えない ----
const values = { 会社名: "株式会社サンプル", 氏名: "架空 太郎", 契約期間: "2026年12月1日から2027年5月31日まで", 賃金形態: "月給", 賃金額: "250,000円", 就業場所: "本社 <3F> & 分室", 契約締結日: "2026年11月20日" };
const filled = fillTemplate(template, values);
assert.deepEqual(filled.missing, []); assert.ok(Buffer.isBuffer(filled.docx));
assert.deepEqual(listPlaceholders(filled.docx), [], "差し込み残しなし");
const outParts = readZip(filled.docx);
assert.deepEqual(outParts.map((e) => e.name), parts().map((e) => e.name));
assert.ok(outParts.find((e) => e.name === "word/styles.xml").data.equals(Buffer.from(stylesXml)), "スタイルは変えない");
assert.ok(outParts.find((e) => e.name === "word/media/seal.png").data.equals(image), "画像は変えない");
const outXml = outParts.find((e) => e.name === "word/document.xml").data.toString("utf8");
for (const c of CLAUSES) assert.ok(outXml.includes(c), "条項の段落は1バイトも変えない");
assert.ok(outXml.includes('<w:tblW w:w="8000" w:type="dxa"/>') && (outXml.match(/<w:tc>/g) || []).length === 6, "表の構造は変えない");
assert.ok(outXml.includes('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'), "用紙設定は変えない");
assert.equal((outXml.match(/<w:r>/g) || []).length, (documentXml.match(/<w:r>/g) || []).length, "文字のまとまり（書式の単位）の数は変えない");
assert.equal((outXml.match(/<w:rPr>/g) || []).length, (documentXml.match(/<w:rPr>/g) || []).length, "書式指定の数は変えない");
// 文字として読むと、差し込み箇所だけが置き換わっている
const expected = extractText(template)["word/document.xml"].map((p) => p.replace(/\{\{([^{}]+)\}\}/g, (_, k) => values[k]));
assert.deepEqual(extractText(filled.docx)["word/document.xml"], expected, "変わったのは差し込み箇所の文字だけ");
assert.deepEqual(extractText(filled.docx)["word/footer1.xml"], ["株式会社サンプル"], "フッターにも差し込む");
assert.ok(outXml.includes("本社 &lt;3F&gt; &amp; 分室"), "値の記号は文字として入る（XMLを壊さない）");
assert.ok(fillTemplate(template, values).docx.equals(filled.docx), "同じ雛形・同じ値なら同じ文書");

// ---- 値が足りなければ作らない（推測で埋めない） ----
const partial = fillTemplate(template, { ...values, 賃金額: "", 就業場所: undefined });
assert.equal(partial.docx, null); assert.deepEqual(partial.missing, ["賃金額", "就業場所"]);
assert.equal(fillTemplate(template, {}).docx, null);
assert.deepEqual(fillTemplate(template, { ...values, 氏名: "   " }).missing, ["氏名"], "空白だけは未入力");
assert.deepEqual(fillTemplate(template, { ...values, 氏名: 12345 }).missing, ["氏名"], "文字列以外は使わない");

// ---- 雛形の登録前確認 ----
const ok = validateTemplate(template, { kind: "employment_contract", category: "fixed_term_trial" });
assert.equal(ok.sha256, sha256(template)); assert.deepEqual(ok.placeholders, listPlaceholders(template));
assert.throws(() => validateTemplate(template, { kind: "resume", category: "fixed_term_trial" }), /template_kind_invalid/);
assert.throws(() => validateTemplate(template, { kind: "employment_contract", category: "unknown" }), /template_category_invalid/);
const unknownDoc = writeZip(parts(documentXml.replace("{{就業場所}}", "{{血液型}}")));
assert.throws(() => validateTemplate(unknownDoc, { kind: "employment_contract", category: "fixed_term_trial" }), (e) => e.code === "template_unknown_fields" && e.detail.join() === "血液型", "知らない項目のある雛形は登録しない");
const noFields = writeZip(parts(`<?xml version="1.0"?><w:document ${W}><w:body>${para(run("寺島 周作 様との契約書"))}</w:body></w:document>`).filter((e) => e.name !== "word/footer1.xml"));
assert.throws(() => validateTemplate(noFields, { kind: "employment_contract", category: "fixed_term_trial" }), /template_no_fields/, "差し込み項目の無い（個人名が残ったままの）文書は雛形にしない");
const noName = writeZip(parts(documentXml.replace("{{氏", "乙")));   // 氏名の差し込みを消した雛形
assert.throws(() => validateTemplate(noName, { kind: "employment_contract", category: "fixed_term_trial" }), /template_name_required/);
// 書類の種類は別々
assert.deepEqual(Object.keys(DOC_KINDS), ["employment_contract", "labor_notice", "offer_letter", "contractor_contract"]);
assert.ok(TEMPLATE_CATEGORIES.fixed_term_trial && TEMPLATE_CATEGORIES.trial_2weeks && TEMPLATE_CATEGORIES.contractor);
assert.equal(new Set(FIELDS.map((f) => f.key)).size, FIELDS.length);
assert.equal(issueFilename("employment_contract", 2, "pdf"), "雇用契約書_第2版.pdf");

// ---- その応募者・その採用条件からだけ作る ----
const applicant = { id: "app-1", name: "架空 太郎" };
const offer = { id: "offer-1", applicantId: "app-1", joinDate: "2026-12-01", contractEndDate: "2027-05-31", wageType: "月給", wageAmount: 250000, workLocation: "本社", employmentType: "契約社員", probationMonths: 3, offerTerms: {} };
const company = { name: "株式会社サンプル" };
const v = valuesFor({ applicant, offer, company, signedOn: "2026-11-20" });
assert.equal(v.契約期間, "2026年12月1日から2027年5月31日まで"); assert.equal(v.賃金額, "250,000円"); assert.equal(v.試用期間, "3か月"); assert.equal(v.契約締結日, "2026年11月20日");
assert.equal(v.住所, "", "登録が無い項目は空のまま（推測しない）"); assert.equal(v.始業時刻, "");
assert.equal(valuesFor({ applicant, offer: { ...offer, wageAmount: 0, joinDate: null }, company }).賃金額, "");
assert.equal(valuesFor({ applicant, offer: { ...offer, joinDate: null }, company }).契約期間, "", "開始日が無ければ契約期間も作らない");
assert.throws(() => valuesFor({ applicant, offer: { ...offer, applicantId: "app-2" }, company }), /issue_scope/, "別の応募者の条件は使わない");
assert.throws(() => valuesFor({ applicant: {}, offer, company }), /issue_scope/);

// 雇用契約書の差し込みは実在する日付・妥当な契約期間・整数円だけを受け付ける。
assert.equal(valuesFor({ applicant, offer: { ...offer, joinDate: "2028-02-29", contractEndDate: "2028-06-01" }, company }).契約開始日, "2028年2月29日", "うるう年は有効");
assert.equal(valuesFor({ applicant, offer: { ...offer, joinDate: "2026-12-01T00:00:00+09:00" }, company }).契約開始日, "2026年12月1日", "タイムゾーンで日付を動かさない");
for (const wrong of ["2027-02-29", "2026-11-31", "2026-02-30", "2026-00-01", "2026-12-01-evil", "2026-12-01T99:99:99"]) {
  assert.throws(() => valuesFor({ applicant, offer: { ...offer, joinDate: wrong }, company }), /contract_date_invalid/, "不正日付: " + wrong);
}
assert.throws(() => valuesFor({ applicant, offer: { ...offer, joinDate: "2027-06-01" }, company }), /contract_period_invalid/, "終了日より後の開始日は拒否");
assert.throws(() => valuesFor({ applicant, offer, company, signedOn: "2026-02-30" }), /contract_date_invalid/, "契約締結日にも日付検証");
for (const invalid of ["1e6", "-200000", "1.5", "Infinity", "NaN", Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(valuesFor({ applicant, offer: { ...offer, wageAmount: invalid }, company }).賃金額, "", "推測して賃金を埋めない: " + invalid);
}
assert.equal(valuesFor({ applicant, offer: { ...offer, wageAmount: "250000.00" }, company }).賃金額, "250,000円", "整数円のDB文字列は扱える");

// 実際の有期雇用契約書にある給与内訳は、総支給額からの推測ではなく明示入力だけで差し込む。
const breakdown = valuesFor({ applicant, offer: {
  ...offer, offerTerms: {
    workHours: "9:00〜18:00", overtime: "あり", wagePayment: "月末締め・翌月25日払い",
    dutiesChange: "会社の指定する業務", workLocationChange: "会社の定める就業場所",
    baseSalary: 200000, fixedOvertimeAmount: 50000, fixedOvertimeHours: 20,
  },
}, company });
assert.equal(breakdown.基本給, "200,000円");
assert.equal(breakdown.固定残業代, "50,000円");
assert.equal(breakdown.固定残業時間, "20時間");
assert.equal(breakdown.勤務時間, "9:00〜18:00");
assert.equal(breakdown["賃金の締日・支払日"], "月末締め・翌月25日払い");
assert.equal(breakdown.業務の変更範囲, "会社の指定する業務");
assert.equal(breakdown.勤務地の変更範囲, "会社の定める就業場所");
assert.equal(valuesFor({ applicant, offer, company }).基本給, "", "個人ごとの基本給を原本から流用しない");
assert.equal(valuesFor({ applicant, offer, company }).固定残業代, "", "固定残業代を総支給額から推測しない");
assert.equal(valuesFor({ applicant, offer: { ...offer, offerTerms: { fixedOvertimeHours: "999" } }, company }).固定残業時間, "", "異常な固定残業時間は自動で差し込まない");



const tpl = { docx: template, sha256: sha256(template) };
const issued = issueDocument({ template: tpl, applicant, offer, company, signedOn: "2026-11-20" });
assert.equal(issued.ok, true); assert.equal(issued.sha256, sha256(issued.docx));
assert.deepEqual(Object.keys(issued.values), listPlaceholders(template), "記録するのは、実際に差し込んだ値だけ");
assert.ok(extractText(issued.docx)["word/document.xml"].join("\n").includes("架空 太郎"));
const short = issueDocument({ template: tpl, applicant, offer: { ...offer, workLocation: "" }, company, signedOn: "2026-11-20" });
assert.deepEqual(short, { ok: false, missing: ["就業場所"] }, "足りなければ発行しない");
assert.deepEqual(issueDocument({ template: tpl, applicant, offer, company }).missing, ["契約締結日"]);
assert.throws(() => issueDocument({ template: { docx: template, sha256: "0".repeat(64) }, applicant, offer, company, signedOn: "2026-11-20" }), /template_changed/, "登録時と違う雛形では発行しない");
// 別の応募者で発行しても、前の人の値は残らない
const other = issueDocument({ template: tpl, applicant: { id: "app-2", name: "架空 花子" }, offer: { ...offer, id: "offer-2", applicantId: "app-2", wageAmount: 300000 }, company, signedOn: "2026-11-21" });
const otherText = JSON.stringify(extractText(other.docx));
assert.ok(otherText.includes("架空 花子") && otherText.includes("300,000円") && !otherText.includes("架空 太郎") && !otherText.includes("250,000円"));
assert.ok(readZip(template).find((e) => e.name === "word/document.xml").data.equals(Buffer.from(documentXml)), "雛形そのものは書き換わらない");
console.log("PASS HR contract template base: zip round-trip, split-run placeholders, clause/table/format preservation, no guessing on missing values, template validation, separate document kinds, applicant-scoped issuing");
