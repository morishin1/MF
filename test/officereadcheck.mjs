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
const { main } = await import(join(ROOT, "scripts/office-read-check.mjs"));

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
await ok("DB・Storage に触れない（supabase を import していない）", async () => {
  const src = fs.readFileSync(join(ROOT, "scripts/office-read-check.mjs"), "utf8");
  assert.ok(!/supabase|createClient|\.from\(|storage/i.test(src.replace(/\/\/.*$/gm, "")), "supabase に触れていない");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
