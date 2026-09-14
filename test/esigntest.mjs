// 差し込み・状態判定・PDF・ハッシュを、本物のコードで通す
import {
  buildFields, merge, usedFields, statusOf, isOverdue, STARTERS, DOC_KINDS, AGREE_TEXT,
} from "../lib/esign.js";
import { renderContractPdf, appendSignaturePage, sha256, shortHash } from "../lib/pdf-jp.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

let bad = 0;
const ok = (c, m) => { if (!c) { console.log("NG:", m); bad++; } };

// ---- 差し込み ----
const employee = {
  display_name: "今福 太郎", email: "taro@gw.8grp.co.jp", department: "制作部",
  position: "主任", employment_type: "正社員", joined_on: "2026-04-01",
  work_location: "本社", initial_role: "Web制作",
};
const profile = { name_kana: "イマフク タロウ", postal_code: "101-0003",
  address: "東京都千代田区一ツ橋2-1-2", phone: "090-0000-0000", birth_date: "1995-04-01" };
const contract = { fixed_term: true, period_from: "2026-04-01", period_to: "2027-03-31",
  probation_months: 3, work_place: "本社", job_content: "Webサイトの企画・制作",
  work_hours: "9:00〜18:00", work_days: "月〜金", wage_type: "月給",
  wage_amount: 320000, wage_note: "固定残業手当を含む" };

const f = buildFields({ employee, profile, contract, companyName: "株式会社エイト" });
ok(f["氏名"] === "今福 太郎", "氏名");
ok(f["入社日"] === "2026年4月1日", `入社日 ${f["入社日"]}`);
ok(f["契約期間"] === "2026年4月1日 〜 2027年3月31日", `契約期間 ${f["契約期間"]}`);
ok(f["賃金"] === "月給 320,000円（固定残業手当を含む）", `賃金 ${f["賃金"]}`);
ok(f["試用期間"] === "3か月", "試用期間");
ok(/^\d{4}年\d{1,2}月\d{1,2}日$/.test(f["今日"]), "今日");

// 無期契約
const f2 = buildFields({ employee, profile, contract: { fixed_term: false }, companyName: "エイト" });
ok(f2["契約期間"] === "期間の定めなし", `無期 ${f2["契約期間"]}`);
// 終了日未定
const f3 = buildFields({ employee, profile, contract: { fixed_term: true, period_from: "2026-04-01" } });
ok(f3["契約期間"] === "2026年4月1日 〜 （終了日未定）", `終了未定 ${f3["契約期間"]}`);

// ---- merge ----
const m1 = merge("{{氏名}} 様（{{部署}}）\n住所: {{住所}}", f);
ok(m1.text === "今福 太郎 様（制作部）\n住所: 東京都千代田区一ツ橋2-1-2", `差し込み: ${m1.text}`);
ok(m1.missing.length === 0, "埋まっているのに missing が出た");

const empty = buildFields({ employee: { display_name: "山田" }, profile: {}, contract: {} });
const m2 = merge("{{氏名}} / {{住所}} / {{賃金}}", empty);
ok(m2.text.includes("【未入力：住所】"), `未入力の印: ${m2.text}`);
ok(m2.missing.includes("住所") && m2.missing.includes("賃金"), `missing: ${m2.missing}`);
ok(!m2.missing.includes("氏名"), "埋まっている氏名が missing に入った");

// 知らない項目はそのまま残す（打ち間違いに気づけるように）
const m3 = merge("{{存在しない項目}} と {{氏名}}", f);
ok(m3.text.includes("{{存在しない項目}}"), `未知の項目: ${m3.text}`);
ok(m3.text.includes("今福 太郎"), "未知が混ざると他も止まる");

// 空白ゆらぎ
ok(merge("{{ 氏名 }}", f).text === "今福 太郎", "前後に空白のある差し込み");

// 差し込みの一覧
const used = usedFields("{{氏名}}{{住所}}{{氏名}}");
ok(used.length === 2 && used.includes("氏名") && used.includes("住所"), `usedFields: ${used}`);

// ---- 状態 ----
const today = new Date("2026-09-07T12:00:00+09:00");
ok(statusOf({ status: "signed" }, today) === "signed", "署名済");
ok(statusOf({ status: "cancelled" }, today) === "cancelled", "取り消し");
ok(statusOf({ status: "sent", due_on: "2026-09-10" }, today) === "sent", "期限内");
ok(statusOf({ status: "sent", due_on: "2026-09-06" }, today) === "overdue", "期限切れ");
ok(statusOf({ status: "sent", due_on: "2026-09-07" }, today) === "sent", "当日は期限内");
ok(statusOf({ status: "sent", due_on: null }, today) === "sent", "期限なし");
ok(!isOverdue({ status: "signed", due_on: "2020-01-01" }, today), "署名済は期限切れにしない");

// ---- 下書き ----
for (const k of ["employment", "pledge", "equipment", "training"]) {
  ok(STARTERS[k] && STARTERS[k].body.length > 200, `下書きが薄い: ${k}`);
  ok(DOC_KINDS.some((d) => d.key === k), `種類に無い: ${k}`);
  // 下書きの差し込みが、全部 buildFields で埋まる形になっているか
  const unknown = usedFields(STARTERS[k].body).filter((x) => !(x in f));
  ok(unknown.length === 0, `下書き ${k} に知らない差し込み: ${unknown}`);
}

// ---- PDF と署名 ----
const body = merge(STARTERS.employment.body, f).text;
const base = await renderContractPdf({
  title: "労働条件通知書 兼 雇用契約書", company: "株式会社エイト", body,
  docId: "11111111-2222-3333-4444-555555555555",
  issuedOn: f["今日"], employeeName: f["氏名"], version: 1,
});
const h = sha256(base);
ok(base.length > 5000, "PDFが小さすぎる");
ok(/^%PDF-/.test(Buffer.from(base.slice(0, 8)).toString("latin1")), "PDFの先頭が違う");
ok(/^[0-9a-f]{64}$/.test(h), `ハッシュの形: ${h}`);

// 同じ入力から2回作っても、中身は同じ長さになる（作成日時は入るので完全一致はしない）
const base2 = await renderContractPdf({
  title: "労働条件通知書 兼 雇用契約書", company: "株式会社エイト", body,
  docId: "11111111-2222-3333-4444-555555555555",
  issuedOn: f["今日"], employeeName: f["氏名"], version: 1,
});
ok(Math.abs(base2.length - base.length) < 200, "同じ入力で大きさが変わる");

const signed = await appendSignaturePage(base, {
  signerName: "今福 太郎", signerEmail: employee.email, employeeCode: "abc-123",
  signedAt: "2026年9月7日 18:42:07（日本時間）",
  docId: "11111111-2222-3333-4444-555555555555", docHash: h,
  title: "労働条件通知書 兼 雇用契約書", agreedText: AGREE_TEXT,
  ip: "203.0.113.42", userAgent: "Mozilla/5.0 Chrome/141.0",
});
ok(signed.length > base.length, "署名でページが増えていない");
ok(sha256(signed) !== h, "署名前と署名済みのハッシュが同じ");
// 署名前のPDFは変わっていない（ハッシュの前提）
ok(sha256(base) === h, "署名の処理が元のPDFを書き換えた");

// 署名済みPDFにもう一度足せる（＝壊れていない）
const twice = await appendSignaturePage(signed, {
  signerName: "確認", signedAt: "-", docId: "-", docHash: "-",
});
ok(twice.length > signed.length, "署名済みPDFを読み直せない");

ok(shortHash(h) === h.slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ").toUpperCase(), "短縮ハッシュ");

// ---- 折り返し ----
const longLine = "あ".repeat(400) + "\n" + "A".repeat(400);
const wide = await renderContractPdf({ title: "折り返しの確認", body: longLine, docId: "x" });
ok(wide.length > 3000, "長い行でPDFが作れない");

console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
