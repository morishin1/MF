// scripts/office-read-check.mjs（本物の AI で1人分の勤務表を試す道具）の動作。偽の client で通す。
//
// ■ 守ること
//   ・キーが無い・ファイルが無い・引数が足りない・月の形が違う → 何もせず、理由を出して終了（AI を呼ばない）
//   ・PDF・JPEG・PNG 以外は、AI を呼ばずに断る
//   ・読めた結果は、日ごとの表・人が見る量・勤務表の合計との照合を出す。DB・Storage には触れない（import しない）
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { main, compareWithExpected, dbShapeProblems } = await import(join(ROOT, "scripts/office-read-check.mjs"));
const EXPECTED_PATH = join(ROOT, "test/fixtures/office-timesheet/expected.json");
const EXPECTED = JSON.parse(fs.readFileSync(EXPECTED_PATH, "utf8"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-"));
const PDF = path.join(dir, "sheet.pdf");
fs.writeFileSync(PDF, Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 1)]));
const TXT = path.join(dir, "memo.txt");
fs.writeFileSync(TXT, "hello");
const run = async (argv, opts = {}) => { const lines = []; const code = await main(argv, { out: (s) => lines.push(s), ...opts }); return { code, text: lines.join("\n") }; };

const days = (n) => Array.from({ length: n }, (_, i) => ([0, 6].includes(new Date(Date.UTC(2026, 9, i + 1)).getUTCDay())
  ? { day: i + 1, kind: "off", blank: false, note: "休", confidence: "high" }
  : { day: i + 1, kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "high", note: null }));
const fake = (input, calls = []) => ({ calls, messages: { create: async (p) => { calls.push(p); return { model: "claude-test", stop_reason: "tool_use", content: [{ type: "tool_use", name: "read_timesheet", input }], usage: { input_tokens: 111, output_tokens: 22 } }; } } });

await ok("引数なし・月の形が違う・ファイル無し → 使い方／理由を出して 2。AI は呼ばない", async () => {
  const c = []; const cl = fake({}, c);
  assert.equal((await run([], { client: cl })).code, 2);
  assert.match((await run([PDF, "--month", "2026-13"], { client: cl })).text, /YYYY-MM/);
  assert.match((await run([path.join(dir, "none.pdf")], { client: cl })).text, /見つかりません/);
  assert.equal(c.length, 0);
});
await ok("キーが無い（client も無い）→ 2 と案内", async () => {
  const r = await run([PDF, "--month", "2026-10"], { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.text, /ANTHROPIC_API_KEY/);
});
await ok("PDF・JPEG・PNG 以外は、AI を呼ばずに断る（HEIC などは対象外）", async () => {
  const c = []; const r = await run([TXT, "--month", "2026-10"], { client: fake({}, c) });
  assert.equal(r.code, 1);
  assert.match(r.text, /PDF・JPEG・PNG/);
  assert.equal(c.length, 0);
});
await ok("読めた：秒数・トークン・日ごとの表・人が見る量・合計の照合を出す。休憩が空の日は【要入力】", async () => {
  const d = days(31); d[13].break = null; d[20].kind = "unknown"; d[20].start = null; d[20].end = null; d[20].confidence = "low";
  const input = { sheet_month: "2026-10", employee_name: "田中 太郎", total_worked: "168:00", break_column: "present", days: d };
  const t = [1000, 1000 + 12500]; let i = 0;
  const r = await run([PDF, "--month", "2026-10"], { client: fake(input), now: () => t[Math.min(i++, 1)] ?? 13500, env: {} });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /読み取りました/);
  assert.match(r.text, /入力 111 トークン・出力 22 トークン/);
  assert.match(r.text, /勤務表の氏名：田中 太郎/);
  assert.match(r.text, /10-14 .*【要入力】休憩が不明です/);
  assert.match(r.text, /10-21 .*未確認/);
  assert.match(r.text, /入力が必要な日 2日/);
  assert.match(r.text, /照合：入力が必要な日があるので/);
  assert.match(r.text, /推測で埋めない/);
});
await ok("勤務表の年月が違えば「読み取れませんでした」（別の月として取り込まない）。1 を返す", async () => {
  const input = { sheet_month: "2026-09", days: days(30) };
  const r = await run([PDF, "--month", "2026-10"], { client: fake(input), env: {} });
  assert.equal(r.code, 1);
  assert.match(r.text, /wrong_month/);
});
await ok("AI のエラーは、コードと理由を出して 1（エラーの生の文は「API の返答」に分けて出す）", async () => {
  const cl = { messages: { create: async () => { throw Object.assign(new Error("invalid_request_error: x"), { status: 400 }); } } };
  const r = await run([PDF, "--month", "2026-10"], { client: cl, env: {} });
  assert.equal(r.code, 1);
  assert.match(r.text, /rejected/);
  assert.match(r.text, /API の返答：invalid_request_error/);
});
// ---- --expect（正解との突き合わせ）／--json（画面が使える形の書き出し）------------------------------
const clock = (m) => (m == null ? null : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);
/** expected.json の printed（勤務表に書かれているとおり）を、AI が返す形にする。edit で日ごとに手を入れる */
const aiFromPrinted = (edit = () => {}) => ({
  sheet_month: EXPECTED.month, employee_name: EXPECTED.employee, total_worked: clock(EXPECTED.totalWorkedMin), break_column: "present",
  days: EXPECTED.days.map((e) => {
    const p = e.printed;
    const row = p.kind === "off"
      ? { day: e.day, kind: "off", blank: !e.note, note: e.note, confidence: "high" }
      : { day: e.day, kind: "work", start: clock(p.start), end: clock(p.end), break: clock(p.break), worked: clock(p.worked), note: e.note, confidence: "high" };
    // 読めない所は、AI も null にして「読めなかった」と返す（正しい振る舞い）
    if (EXPECTED.unreadable.includes(e.date)) { row.confidence = "low"; row.reason = "文字が読めない"; }
    edit(row, e);
    return row;
  }),
});
const SHEET = path.join(dir, "sample.pdf");
fs.writeFileSync(SHEET, Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 1)]));

await ok("--expect：書かれているとおりに読めた（読めない所は空のまま）→ 一致のみ・推測 0・終了コード 0。夜間の終了（翌6:00）は 30:00 でも 6:00 でも一致", async () => {
  const r = await run([SHEET, "--month", EXPECTED.month, "--expect", EXPECTED_PATH], { client: fake(aiFromPrinted()), env: {} });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /一致 155 ／ 読み落とし 0 ／ 誤読 0 ／ 推測（書かれていない所を埋めた）0\n/);
  assert.match(r.text, /日別データはそのまま DB に入る形です/);
  const r2 = await run([SHEET, "--month", EXPECTED.month, "--expect", EXPECTED_PATH], { client: fake(aiFromPrinted((row) => { if (row.day === 29) row.end = "6:00"; })), env: {} });
  assert.match(r2.text, /一致 155 /);   // 6:00（翌日の意味で書いた）も、endAccept にあるので誤読にしない
});
await ok("--expect：読めない所を AI が埋めた（休憩1:00・終了18:00）→ 「推測」として数え、終了コード 1。誤読・読み落としも分けて出す", async () => {
  const input = aiFromPrinted((row) => {
    if (row.day === 14) { row.break = "1:00"; row.worked = "8:00"; }      // 休憩が空白の日に、1:00 を補った（推測）
    if (row.day === 21) row.end = "18:00";                                // 染みで隠れた終了を、18:00 と決めた（推測）
    if (row.day === 5) row.end = "17:00";                                 // 17:30 を 17:00 と読み違えた（誤読）
    if (row.day === 2) row.start = null;                                  // 書かれている開始を空にした（読み落とし）
  });
  const r = await run([SHEET, "--month", EXPECTED.month, "--expect", EXPECTED_PATH], { client: fake(input), env: {} });
  assert.equal(r.code, 1);
  assert.match(r.text, /読み落とし 1 ／ 誤読 1 ／ 推測（書かれていない所を埋めた）3  ← 0 であるべきです/);
  assert.match(r.text, /推測  10-14 休憩：正解 （空） → AI 01:00/);
  assert.match(r.text, /推測  10-21 終了：正解 （空） → AI 18:00/);
  assert.match(r.text, /誤読  10-05 終了：正解 17:30 → AI 17:00/);
  assert.match(r.text, /読み落とし  10-02 開始：正解 09:30 → AI （空）/);
});
await ok("--expect：正解ファイルが無い・形が違う → AI を呼ばずに 2", async () => {
  const c = []; const cl = fake(aiFromPrinted(), c);
  assert.equal((await run([SHEET, "--month", "2026-10", "--expect", path.join(dir, "none.json")], { client: cl, env: {} })).code, 2);
  const bad = path.join(dir, "bad.json"); fs.writeFileSync(bad, JSON.stringify({ month: "2026-10" }));
  assert.match((await run([SHEET, "--month", "2026-10", "--expect", bad], { client: cl, env: {} })).text, /days が必要/);
  assert.equal(c.length, 0);
});
await ok("--json：画面が使う日別データ・評価・突き合わせを書き出す（指定した場所だけ）。読み直しても同じ。失敗したときも ok:false で書く", async () => {
  const jp = path.join(dir, "sub", "result.json");
  const r = await run([SHEET, "--month", EXPECTED.month, "--expect", EXPECTED_PATH, "--json", jp], { client: fake(aiFromPrinted()), env: {}, now: (() => { let i = 0; return () => 1000 + 5300 * i++; })() });
  assert.equal(r.code, 0, r.text);
  const j = JSON.parse(fs.readFileSync(jp, "utf8"));
  assert.equal(j.ok, true);
  assert.equal(j.elapsedSec, 5.3);
  assert.equal(j.days.length, 31);
  assert.deepEqual(j.dbShapeProblems, []);
  assert.equal(j.comparison.tally.guessed, 0);
  assert.equal(j.evaluation.summary.unresolvedCount, 2);          // 10/14（休憩が空）・10/21（終了が空）だけが「人の入力が必要」
  const d14 = j.days.find((d) => d.workDate === "2026-10-14");
  assert.equal(d14.breakMin, null);                               // 補っていない
  const d29 = j.days.find((d) => d.workDate === "2026-10-29");
  assert.equal(d29.endMin, 1800);                                 // 夜間は 30:00（翌6:00）のまま
  const jf = path.join(dir, "fail.json");
  const f = await run([SHEET, "--month", "2026-10", "--json", jf], { client: fake({ sheet_month: "2026-09", days: days(30) }), env: {} });
  assert.equal(f.code, 1);
  const jj = JSON.parse(fs.readFileSync(jf, "utf8"));
  assert.equal(jj.ok, false);
  assert.equal(jj.code, "wrong_month");
});
await ok("dbShapeProblems：DB の範囲外（開始が24:00以上・終了が48:00以上・小数など）を見つける。正しい値は通す", async () => {
  const ok1 = { workDate: "2026-10-01", kind: "work", startMin: 1320, endMin: 1800, breakMin: 60, sheetWorkedMin: 420, confidence: "high", flags: [] };
  assert.deepEqual(dbShapeProblems([ok1]), []);
  const bad = dbShapeProblems([{ ...ok1, startMin: 1440 }, { ...ok1, endMin: 2880 }, { ...ok1, breakMin: 10.5 }, { ...ok1, kind: "unknown" }, { ...ok1, confidence: "x" }, { ...ok1, flags: null }]);
  assert.equal(bad.length, 6);
});
await ok("compareWithExpected：休みの日に時刻が付いたら「推測」、勤務の日を休みと読んだら「誤読」", async () => {
  const days = EXPECTED.days.map((e) => ({ workDate: e.date, kind: e.printed.kind, startMin: e.printed.start, endMin: e.printed.end, breakMin: e.printed.break, sheetWorkedMin: e.printed.worked }));
  assert.equal(compareWithExpected(days, EXPECTED).tally.match, 155);
  days.find((d) => d.workDate === "2026-10-03").startMin = 540;       // 土曜（休み）に開始を付けた
  days.find((d) => d.workDate === "2026-10-01").kind = "off";         // 勤務を休みと読んだ
  const c = compareWithExpected(days, EXPECTED);
  assert.equal(c.tally.guessed, 1);
  assert.equal(c.tally.wrong, 1);
});

await ok("DB・Storage に触れない（supabase を import していない）", async () => {
  const src = fs.readFileSync(join(ROOT, "scripts/office-read-check.mjs"), "utf8");
  assert.ok(!/supabase|createClient|\.from\(|storage/i.test(src.replace(/\/\/.*$/gm, "")), "supabase に触れていない");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
