// db/office_phase3_test_read_result.sql（実 Claude の読取結果を、正解と突き合わせる SELECT）を守るテスト。
//
// ■ なぜ要るのか
//   実 AI の確認は、本番の Supabase で、人がこの SQL を流して行う。正解の値（expected.json）や、AI が最初に返した値の置き場所
//   （ai_snapshot のキー）とずれると、「推測が 0 件」と誤って出しかねない。ずれを、テストで先に止める。
//
// ■ 守ること
//   1. 読み取り専用（SELECT だけ。insert・update・delete・drop・alter・create・truncate が無い）
//   2. 正解の表（VALUES）が、test/fixtures/office-timesheet/expected.json の printed と、31日 × 全項目で同じ
//      （夜間の終了 10/29 は、30:00 と 6:00 のどちらも一致）
//   3. AI の値を読むキー（ai_snapshot の kind・startMin・endMin・breakMin・sheetWorkedMin）が、本物の normalizeRead が保存するキーと同じ
//   4. 対象は、seed のテスト社員（固定 id）の 2026-10。判読不能な日（10/14・10/21）は、expected.json の unreadable と同じ
//   5. 報告してほしい項目（モデル・成否・所要時間・一致・誤読・読み落とし・推測・休憩空欄・判読不能・画面で使える形）が、すべて出る
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SQL = fs.readFileSync(join(ROOT, "db/office_phase3_test_read_result.sql"), "utf8");
const SEED = fs.readFileSync(join(ROOT, "db/office_phase3_test_seed.sql"), "utf8");
const EXPECTED = JSON.parse(fs.readFileSync(join(ROOT, "test/fixtures/office-timesheet/expected.json"), "utf8"));
const { normalizeRead } = await import(join(ROOT, "lib/office-timesheet-ai.js"));
const code = SQL.replace(/--.*$/gm, "");

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

await ok("読み取り専用：SELECT だけ（書き込み・定義の文が無い）", async () => {
  assert.ok(!/\b(insert\s+into|update\s+\w|delete\s+from|drop\s|alter\s|create\s|truncate\s|grant\s|revoke\s)/i.test(code), "書き込みの文がある");
  assert.ok(/^\s*with\b/m.test(code) && /\bselect\b/i.test(code));
});

await ok("正解の表が、expected.json の printed と同じ（31日 × 区分・開始・終了・休憩・実働）。夜間の終了は 30:00 と 6:00 のどちらも一致", async () => {
  const body = code.slice(code.indexOf("values\n") + 7, code.indexOf("got as"));
  const rows = [...body.matchAll(/\(\s*(\d+),\s*'(work|off)',\s*(null|\d+),\s*(null|\d+),\s*(null|\d+),\s*(null|\d+),\s*(null|\d+)\)/g)];
  assert.equal(rows.length, 31, "31日ぶん");
  const num = (v) => (v === "null" ? null : Number(v));
  for (const m of rows) {
    const d = EXPECTED.days.find((x) => x.day === Number(m[1]));
    const p = d.printed;
    assert.deepEqual([m[2], num(m[3]), num(m[4]), num(m[6]), num(m[7])], [p.kind, p.start, p.end, p.break, p.worked], `${d.date}`);
    const alt = (d.endAccept || []).find((x) => x !== p.end) ?? null;
    assert.equal(num(m[5]), alt, `${d.date} の終了の別の書き方`);
  }
  assert.deepEqual(EXPECTED.days.find((d) => d.day === 29).endAccept.sort((a, b) => a - b), [360, 1800]);
});

await ok("AI の値を読むキーが、本物の normalizeRead が ai_snapshot に保存するキーと同じ", async () => {
  const n = normalizeRead({ sheet_month: "2026-10", days: [{ day: 1, kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "high" }] }, "2026-10");
  const keys = Object.keys(n.days[0].snapshot);
  for (const k of ["kind", "startMin", "endMin", "breakMin", "sheetWorkedMin"]) {
    assert.ok(keys.includes(k), `normalizeRead の snapshot に ${k} が無い`);
    assert.ok(code.includes(`->> '${k}'`), `SQL が ${k} を読んでいない`);
  }
});

await ok("対象は、seed のテスト社員の 2026-10。判読不能な日（10/14・10/21）が、expected.json の unreadable と同じ", async () => {
  assert.ok(SQL.includes("e13db73f-3d85-45ca-ac0a-7f26a5d53610") && SEED.includes("e13db73f-3d85-45ca-ac0a-7f26a5d53610"));
  assert.match(code, /target_month = '2026-10'/);
  assert.match(code, /billing_month = '2026-10'/);
  assert.deepEqual(EXPECTED.unreadable, ["2026-10-14", "2026-10-21"]);
  assert.match(code, /day = 14 and field = '休憩'/);
  assert.match(code, /day = 14 and field in \('休憩', '実働'\)\) or \(day = 21 and field in \('終了', '実働'\)/);
});

await ok("報告してほしい項目が、すべて出る（モデル・成否・所要時間・一致・誤読・読み落とし・推測・休憩空欄・判読不能・画面で使える形）", async () => {
  for (const label of ["使用モデル名", "読取した勤務表", "所要時間の目安", "正しく読めた項目数", "誤読数", "読み落とし数", "推測して埋めた件数",
    "休憩が空欄の日", "判読不能な箇所", "読み込まれた日数", "一致しなかった項目"]) {
    assert.ok(SQL.includes(label), `${label} が無い`);
  }
  assert.match(code, /'推測'/); assert.match(code, /'誤読'/); assert.match(code, /'読み落とし'/);
  assert.match(SQL, /1件でもあれば、本番投入は止めて修正/);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
