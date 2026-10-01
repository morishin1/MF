// HR の日時は日本時間（Asia/Tokyo）で見せる：lib/jst.js（サーバ）と js/jst.js（画面）。
//
// ■ 何を守るテストか
//   1. UTC 07:15 は日本時間 16:15（「2026/10/1 16:15」または「本日 16:15」）
//   2. 日付またぎ：UTC では前日でも、日本では当日
//   3. datetime-local の入出力で 9 時間ずれない（表示 → 保存 → 表示で同じ）
//   4. サーバ・端末のタイムゾーン（Vercel は UTC、海外の端末など）に左右されない
//   5. サーバ側の NEXT ACTION・通知の日時も同じ書き方
//   6. HR の画面・サーバに、端末／サーバのローカル時刻に頼る書き方を戻さない
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const J = await import(join(ROOT, "lib/jst.js"));
const box = {};
vm.runInNewContext(readFileSync(join(ROOT, "js/jst.js"), "utf8"), box);
const C = box.JST;

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const T = "2026-10-01T07:15:00+00:00";

console.log("\n— 日本時間で見せる —");
for (const [who, X] of [["サーバ lib/jst.js", J], ["画面 js/jst.js", C]]) {
  await ok(`${who}：UTC 07:15 → 2026/10/1 16:15`, () => {
    assert.equal(X.dateTime(T), "2026/10/1 16:15");
    assert.equal(X.date(T), "2026/10/1");
    assert.equal(X.time(T), "16:15");
    assert.equal(X.ymd(T), "2026-10-01");
  });
  await ok(`${who}：日本で今日なら「本日 16:15」、別の日なら年月日つき`, () => {
    assert.equal(X.when(T, new Date("2026-10-01T00:00:00+09:00")), "本日 16:15");
    assert.equal(X.when(T, new Date("2026-10-01T23:59:00+09:00")), "本日 16:15");
    assert.equal(X.when(T, new Date("2026-09-30T23:59:00+09:00")), "2026/10/1 16:15");
    // UTC ではまだ 9/30 でも、日本ではもう 10/1（今日）
    assert.equal(X.when(T, new Date("2026-09-30T15:30:00Z")), "本日 16:15");
  });
  await ok(`${who}：日付またぎ（UTC では前日 16:30、日本では当日 01:30）`, () => {
    const s = "2026-09-30T16:30:00Z";
    assert.equal(X.dateTime(s), "2026/10/1 01:30");
    assert.equal(X.ymd(s), "2026-10-01");
    assert.equal(X.toInput(s), "2026-10-01T01:30");
    assert.equal(X.ymd("2026-09-30T14:59:00Z"), "2026-09-30", "日本の 23:59 はまだ当日");
  });
  await ok(`${who}：datetime-local の表示 → 保存 → 表示で 9 時間ずれない`, () => {
    assert.equal(X.toInput(T), "2026-10-01T16:15", "UTC の 07:15 を入れない");
    assert.equal(X.fromInput("2026-10-01T16:15"), "2026-10-01T07:15:00.000Z");
    assert.equal(X.toInput(X.fromInput(X.toInput(T))), "2026-10-01T16:15");
    assert.equal(X.fromInput("2026-10-01T01:30"), "2026-09-30T16:30:00.000Z", "日付またぎも戻せる");
    assert.equal(X.fromInput(""), null);
    assert.equal(X.dateTime(null), "");
    assert.equal(X.when("not a date"), "");
  });
}

await ok("サーバと画面で、同じ時刻は同じ文字列になる（1年ぶん・15分おき抜き取り）", () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  for (let t = start; t < start + 366 * 86400000; t += 86400000 / 4 + 15 * 60000) {
    const iso = new Date(t).toISOString();
    for (const f of ["dateTime", "date", "time", "ymd", "toInput"]) assert.equal(C[f](iso), J[f](iso), `${f}(${iso})`);
    assert.equal(C.fromInput(C.toInput(iso)).slice(0, 16), iso.slice(0, 16));
  }
});

await ok("サーバ・端末のタイムゾーンが UTC・米国・日本のどれでも同じ結果", () => {
  const code = `import(${JSON.stringify(join(ROOT, "lib/jst.js"))}).then((J) => {
    const vm = require("node:vm"), fs = require("node:fs"), b = {};
    vm.runInNewContext(fs.readFileSync(${JSON.stringify(join(ROOT, "js/jst.js"))}, "utf8"), b);
    const t = "2026-10-01T07:15:00+00:00";
    console.log([J.dateTime(t), J.toInput(t), J.fromInput("2026-10-01T16:15"), b.JST.dateTime(t), b.JST.toInput(t), b.JST.fromInput("2026-10-01T16:15")].join("|"));
  })`;
  for (const tz of ["UTC", "America/Los_Angeles", "Europe/London", "Asia/Tokyo"]) {
    const out = execFileSync(process.execPath, ["-e", code], { env: { ...process.env, TZ: tz } }).toString().trim();
    assert.equal(out, "2026/10/1 16:15|2026-10-01T16:15|2026-10-01T07:15:00.000Z|2026/10/1 16:15|2026-10-01T16:15|2026-10-01T07:15:00.000Z", tz);
  }
});

console.log("\n— サーバ側の NEXT ACTION —");
await ok("面談予定の NEXT ACTION は日本時間（サーバが UTC でも 16:15）", async () => {
  const { shapeApplicant } = await import(join(ROOT, "lib/hr.js"));
  const a = shapeApplicant({ id: "a1", stage: "ceo_interview", status: "interview_scheduled" },
    { id: "iv1", scheduledAt: T, kind: "ceo" });
  assert.ok(/(本日|2026\/10\/1) 16:15 社長面談$/.test(a.nextAction), a.nextAction);
  assert.equal(a.nextInterviewId, "iv1");
  assert.equal(a.nextInterviewKind, "ceo");
});

console.log("\n— 端末・サーバのローカル時刻に頼る書き方を HR に戻さない —");
await ok("hr/*.html・lib/hr*.js・api/hr/** に getHours/getMinutes/toLocaleString(日時)/toISOString().slice(…) が無い", () => {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(join(ROOT, "api/hr"));
  for (const f of readdirSync(join(ROOT, "hr"))) if (f.endsWith(".html")) files.push(join(ROOT, "hr", f));
  for (const f of readdirSync(join(ROOT, "lib"))) if (/^hr.*\.js$/.test(f)) files.push(join(ROOT, "lib", f));
  const bad = [];
  const RULES = [
    /\.get(Hours|Minutes|Date|Month|FullYear|Day)\(\)/,
    /toISOString\(\)\.slice\(/,
    /toLocale(Date|Time)?String\("ja-JP", *\{[^}]*(hour|month|day)/,
    /new Date\([^)]*\)\.toLocale(Date|Time)?String\(/,
  ];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      // timeZone を明示しているものは端末に頼っていない
      if (!/timeZone:/.test(line) && RULES.some((r) => r.test(line))) bad.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], `日本時間の共通部品（lib/jst.js・js/jst.js）を使ってください:\n${bad.join("\n")}`);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
