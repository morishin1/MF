// 企業に見せる人材の形（lib/enger-talent-public.js）。非公開の項目が1つも出ないことを、値と鍵の両方で確かめる。
// enger-lp の tests/public-talent.test.mjs が、企業ポータル側の同じ決まりを確かめている（片方だけ変えない）。
import assert from "node:assert/strict";
import {
  toPublicTalent, publicSkillSheet, publicTalentSummary, containsPrivateCandidateContent, isPublicTalent, redact, parseTalentQuery, selectTalents, pageOf,
  PUBLIC_TALENT_COLUMNS_EXT, PUBLIC_TALENT_COLUMNS_BASE, NON_PROPOSABLE_STATUSES, prefectureOf, remoteKind, displayNameOf,
} from "../lib/enger-talent-public.js";

const NOW = Date.parse("2026-11-06T03:00:00Z");
// 実データに混ざりうる非公開の値。どれも出てはいけない
const SECRET = {
  name: "山田 太郎", email: "taro@partner.example", contact_email: "sales@partner.example", contact_name: "所属営業 佐藤",
  company: "株式会社パートナーA", source_company: "パートナーB合同会社", affiliation: "一社下社員", partner_organization_id: "11111111-1111-4111-8111-111111111111",
  rate: "75万円", salary_min: 7171, salary_max: 8282, rate_num: 7575, flow_depth: 9393, note: "NG企業：株式会社Z。内部メモ", detail: "職務経歴本文・A社常駐", detail_note: "社内向け紹介文Q",
  skill_sheet_url: "https://x.supabase.co/storage/v1/object/public/skillsheets/u/a.pdf", skill_sheet_data: { name: "山田 太郎" }, signup_source: "mail",
};
const row = {
  id: "aaaaaaaa-0000-4000-8000-000000000001", candidate_no: 123, initials: "T.Y.", title: "バックエンドエンジニア",
  skills: ["Java", "Spring", "AWS", "java"], exp: "8年", avail: "即日（連絡先 090-1234-5678）", status: "提案可",
  created_at: "2026-11-01T00:00:00Z", is_closed: false, deleted_at: null, is_focus: true, remote_pref: "フルリモート希望",
  location: "東京都世田谷区三軒茶屋1-2-3", nearest_station: "三軒茶屋", week_days: "週5", age_band: "30代（前半）", nationality: "日本", role_labels: ["バックエンド"],
  ...SECRET,
};

const t = toPublicTalent(row, { now: NOW });
assert.deepEqual(Object.keys(t).sort(), ["ageBand", "availability", "displayName", "experience", "isFocus", "isNew", "nationality", "nearestStation", "no", "prefecture", "remote", "remoteLabel", "roles", "skills", "talentNo", "title", "weekDays"].sort(), "returned keys are the allow-list only");
const flat = JSON.stringify([t, publicSkillSheet(t)]);
for (const [k, v] of Object.entries(SECRET)) {
  const values = typeof v === "object" ? [JSON.stringify(v)] : [String(v)];
  for (const s of values) assert.ok(!flat.includes(s), `secret ${k} (${s}) must never be returned`);
}
for (const s of ["山田", "partner", "パートナー", "75万", "NG企業", "skillsheets", "090-1234-5678", "世田谷", "三軒茶屋1"]) assert.ok(!flat.includes(s), `must not leak ${s}`);
assert.equal(t.talentNo, "P-000123");
assert.equal(t.displayName, "T.Y.");
assert.equal(t.prefecture, "東京都", "residence is reduced to the prefecture");
assert.equal(t.availability, "即日(連絡先 ［非公開］)", "phone numbers in free text are masked");
assert.deepEqual(t.skills, ["Java", "Spring", "AWS", "java"].filter((x, i, a) => a.indexOf(x) === i));
assert.equal(t.isFocus, true); assert.equal(t.isNew, true); assert.equal(t.remote, "full"); assert.equal(t.ageBand, "30代");

// 列の許可リストに、非公開の列が無い（氏名・単価・所属・メモ・スキルシート原本は読まない）
for (const cols of [PUBLIC_TALENT_COLUMNS_BASE, PUBLIC_TALENT_COLUMNS_EXT]) {
  const list = cols.split(",");
  for (const bad of ["name", "email", "contact_email", "contact_name", "company", "source_company", "affiliation", "rate", "salary_min", "salary_max", "rate_num", "note", "detail", "detail_note", "skill_sheet_url", "skill_sheet_data", "flow_depth", "partner_organization_id", "signup_source"]) {
    assert.ok(!list.includes(bad), `column ${bad} must not be read`);
  }
}

// 表示名：イニシャルが無ければ人材番号。日本語の氏名らしい値はイニシャル列に入っていても使わない
assert.equal(displayNameOf({ initials: "", candidate_no: 7 }), "P-000007");
assert.equal(displayNameOf({ initials: "山田太郎", candidate_no: 7 }), "P-000007");
assert.equal(displayNameOf({ initials: null, candidate_no: null }), "人材");

// 自由記述の伏せ字
assert.equal(redact("連絡は a.b+c@example.co.jp まで"), "連絡は ［非公開］ まで");
assert.equal(redact("https://drive.google.com/file/d/x 参照"), "［非公開］ 参照");
assert.equal(redact("03-1234-5678"), "［非公開］");
assert.equal(redact("2026-12-01 から"), "2026-12-01 から", "dates are not mistaken for phone numbers");
assert.equal(redact("a".repeat(50), 10), "a".repeat(10) + "…");
assert.equal(redact(null), null);

// 公開してよい人材
assert.equal(isPublicTalent(row), true);
assert.equal(isPublicTalent({ ...row, deleted_at: "2026-11-01" }), false);
assert.equal(isPublicTalent({ ...row, is_closed: true }), false);
for (const st of NON_PROPOSABLE_STATUSES) assert.equal(isPublicTalent({ ...row, status: st }), false, `status ${st} is hidden`);
assert.equal(isPublicTalent({ ...row, status: null }), true);
assert.equal(isPublicTalent({ ...row, id: null }), false);

assert.equal(prefectureOf("大阪市北区"), "大阪府");
assert.equal(prefectureOf("北海道札幌市"), "北海道");
assert.equal(prefectureOf("リモート"), null);
assert.equal(remoteKind("partial_remote"), "partial");
assert.equal(remoteKind("常駐可"), "onsite");
assert.equal(remoteKind(""), null);

// 絞り込み
const q = parseTalentQuery(new URLSearchParams({ tab: "focus", q: " Java ", skills: "AWS、Spring", remote: "full", prefecture: "東京都", weekDays: "5", start: "immediate", page: "2" }));
assert.deepEqual(q, { tab: "focus", q: "Java", skills: ["AWS", "Spring"], remote: "full", prefecture: "東京都", weekDays: 5, start: "immediate", sort: "relevance", page: 2 });
assert.deepEqual(parseTalentQuery(new URLSearchParams({ tab: "evil", remote: "x", prefecture: "火星", weekDays: "9", page: "-1", sort: "x" })),
  { tab: "all", q: "", skills: [], remote: null, prefecture: null, weekDays: null, start: null, sort: "new", page: 1 });

const rows = [
  { ...row, id: "1", candidate_no: 1, created_at: "2026-10-01T00:00:00Z", is_focus: false, skills: ["PHP"], title: "PHPエンジニア" },
  { ...row, id: "2", candidate_no: 2, created_at: "2026-11-05T00:00:00Z", skills: ["Java"], title: "Javaエンジニア" },
  { ...row, id: "3", candidate_no: 3, created_at: "2026-11-04T00:00:00Z", skills: ["Java", "AWS"], title: "クラウド" },
  { ...row, id: "4", candidate_no: 4, status: "稼働中" },
  { ...row, id: "5", candidate_no: 5, deleted_at: "2026-11-01" },
];
const base = parseTalentQuery(new URLSearchParams());
assert.deepEqual(selectTalents(rows, base, { now: NOW }).items.map((x) => x.row.id), ["2", "3", "1"], "new order, hidden rows excluded");
assert.deepEqual(selectTalents(rows, { ...base, tab: "focus" }, { now: NOW }).items.map((x) => x.row.id), ["2", "3"]);
assert.deepEqual(selectTalents(rows, { ...base, tab: "new" }, { now: NOW }).items.map((x) => x.row.id), ["2", "3"]);
assert.deepEqual(selectTalents(rows, { ...parseTalentQuery(new URLSearchParams({ skills: "aws" })) }, { now: NOW }).items.map((x) => x.row.id), ["3"]);
assert.deepEqual(selectTalents(rows, { ...parseTalentQuery(new URLSearchParams({ q: "java aws" })) }, { now: NOW }).items.map((x) => x.row.id), ["3"]);
assert.deepEqual(selectTalents(rows, { ...parseTalentQuery(new URLSearchParams({ q: "java", sort: "relevance" })) }, { now: NOW }).items.map((x) => x.row.id), ["2", "3"]);
assert.deepEqual(selectTalents(rows, { ...base, weekDays: 5 }, { now: NOW }).items.length, 3);
assert.deepEqual(selectTalents([{ ...row, id: "x", week_days: "週3" }], { ...base, weekDays: 4 }, { now: NOW }).items.length, 0);
assert.deepEqual(selectTalents(rows, { ...base, prefecture: "大阪府" }, { now: NOW }).items.length, 0);
const pg = pageOf(Array.from({ length: 65 }, (_, i) => i), 3, 30);
assert.deepEqual([pg.page, pg.pages, pg.slice.length], [3, 3, 5]);
assert.equal(pageOf([], 9).page, 1);

const sheet = publicSkillSheet(t);
assert.ok(sheet.rows.every(([k]) => !/単価|所属|氏名|連絡/.test(k)), "public sheet has no price/affiliation/name rows");
// Financial terms and corporate names in otherwise public free-text fields
// must be DROPPED, not merely visually hidden by the browser.
for(const value of [
 "85万円／月", "80万/月", "単金100万", "年収900万円", "株式会社秘密会社 Java",
 "取引先：ABC", "会社名：秘密の企業", "精算140-180h", "給与500,000円",
]) {
  assert.ok(containsPrivateCandidateContent(value), value);
  assert.equal(redact(value), null, value);
}
const privateFreeText={
  ...row, title:"株式会社秘密会社 / Java / 85万円",
  skills:["AWS","80万円","Spring","取引先：隠すべき会社"],
  role_labels:["エンジニア","会社名：秘密会社"],
  exp:"8年（単金80万円）",avail:"即日",note:"機密営業メモ：会社名と仕入",
};
const publicProjection=toPublicTalent(privateFreeText);
const publicSummary=publicTalentSummary(publicProjection);
const publicSheet=publicSkillSheet(publicProjection);
const response=JSON.stringify({publicProjection,publicSummary,publicSheet});
assert.deepEqual(publicProjection.skills,["AWS","Spring"]);
assert.equal(publicProjection.title,null);
assert.equal(publicProjection.experience,null);
assert.match(publicSummary.text,/AWS/);
for(const keyword of ["秘密会社","85万円","80万円","単金","取引先","仕入","機密営業メモ"])
  assert.ok(!response.includes(keyword),"exposed: "+keyword);

console.log("PASS enger talent public projection: allow-list keys, no secret values, masking, visibility, filters, sorting");
