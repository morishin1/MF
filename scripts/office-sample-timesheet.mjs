// 勤務表のテスト用サンプル（架空のデータ）を作る。PDF・PNG・JPEG と、正解（expected.json）。
//
// ■ 使い方
//   node scripts/office-sample-timesheet.mjs [出力先のフォルダ]     （既定：test/fixtures/office-timesheet）
//
// ■ どんな勤務表か（2026年10月・テスト 太郎さん・すべて架空）
//   ・ほとんどの平日は 9:00〜18:00・休憩 1:00・実働 8:00
//   ・わざと「読めない・書かれていない」所を入れてある。AI が推測で埋めてはいけない所：
//       10/14  休憩の欄が空白（実働の欄も空白）
//       10/21  終了の時刻が、インクの染みで隠れている（実働の欄も隠れている）
//   ・そのほか：祝日（10/12）・有給（10/16）・残業（10/9 は実働 11:30）・休憩 0:45（10/5）・
//     30分単位の時刻（10/2 9:30〜18:30）・夜間作業で日をまたぐ（10/29 22:00〜翌 6:00）
//   ・いちばん下の「合計」には、隠れている所の本当の値も含めてある（実物の勤務表と同じで、
//     合計は書いた人が知っている本当の値で出すため）
//
// ■ expected.json
//   printed … 勤務表に「書かれている」とおりの値（空白・隠れている所は null）。AI の読取を、これと比べる
//   truth   … 書いた人が知っている本当の値（空白・隠れている所の中身）。人が直したあとの姿
//   scripts/office-read-check.mjs --expect で、AI の読取を printed と比べる

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../test/_browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONTH = "2026-10";
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (n) => String(n).padStart(2, "0");
const min = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const clock = (m) => (m == null ? "" : `${Math.floor(m / 60)}:${pad(m % 60)}`);

/** 日ごとの定義。printed のほうに null を入れた所が「書かれていない・読めない」所 */
function build() {
  const days = [];
  const HOLIDAY = { 12: "スポーツの日" };
  for (let d = 1; d <= 31; d++) {
    const wd = new Date(Date.UTC(2026, 9, d)).getUTCDay();
    const weekend = wd === 0 || wd === 6;
    const base = { day: d, wd, weekend, kind: weekend || HOLIDAY[d] ? "off" : "work", start: "9:00", end: "18:00", brk: "1:00", worked: "8:00", note: HOLIDAY[d] || "", hidden: [] };
    days.push(base);
  }
  const set = (d, o) => Object.assign(days[d - 1], o);
  set(2, { start: "9:30", end: "18:30" });
  set(5, { end: "17:30", brk: "0:45", worked: "7:45" });
  set(8, { start: "10:00", end: "19:00", note: "客先打合せ" });
  set(9, { end: "21:30", worked: "11:30", note: "障害対応" });
  set(14, { hidden: ["brk", "worked"] });                                  // 休憩・実働が空白
  set(16, { kind: "off", start: "", end: "", brk: "", worked: "", note: "有給休暇" });
  set(21, { hidden: ["end", "worked"] });                                  // 終了・実働が染みで隠れている
  set(23, { end: "18:30", worked: "8:30" });
  set(29, { start: "22:00", end: "翌6:00", brk: "1:00", worked: "7:00", note: "夜間作業（翌日6:00終了）", overnight: true });
  set(30, { kind: "off", start: "", end: "", brk: "", worked: "", note: "明け休み" });
  for (const x of days) if (x.kind === "off") { x.start = x.start ?? ""; }
  for (const x of days) if (x.kind === "off" && !("overnight" in x)) { x.start = ""; x.end = ""; x.brk = ""; x.worked = ""; }
  return days;
}

const toMin = (s) => (s === "" || s == null ? null : s.startsWith("翌") ? min(s.slice(1)) + 1440 : min(s));

export function expected() {
  const days = build();
  const out = days.map((x) => {
    const truth = x.kind === "off"
      ? { kind: "off", start: null, end: null, break: null, worked: null }
      : { kind: "work", start: toMin(x.start), end: toMin(x.end), break: toMin(x.brk), worked: toMin(x.worked) };
    const printed = { ...truth };
    for (const h of x.hidden) printed[{ brk: "break", end: "end", worked: "worked" }[h]] = null;
    const o = { day: x.day, date: `${MONTH}-${pad(x.day)}`, note: x.note || null, truth, printed };
    if (x.overnight) o.endAccept = [toMin("翌6:00"), 360];                    // 「翌6:00」は 30:00 でも 06:00 でもよい
    return o;
  });
  const total = out.reduce((s, d) => s + (d.truth.worked || 0), 0);
  return { month: MONTH, employee: "テスト 太郎", totalWorkedMin: total, unreadable: out.filter((d) => d.printed.break === null && d.truth.kind === "work" || d.printed.end === null && d.truth.kind === "work").map((d) => d.date), days: out };
}

function html() {
  const days = build();
  const exp = expected();
  const cell = (x, key, txt) => (x.hidden.includes(key) ? (key === "end" ? `<span class="blot"></span>` : "") : txt);
  const rows = days.map((x) => `<tr class="${x.weekend ? "we" : ""}${x.kind === "off" && !x.weekend ? " hol" : ""}">
    <td>${x.day}</td><td class="${x.wd === 0 ? "sun" : x.wd === 6 ? "sat" : ""}">${WD[x.wd]}</td>
    <td>${cell(x, "start", x.start)}</td><td>${cell(x, "end", x.end)}</td><td>${cell(x, "brk", x.brk)}</td><td>${cell(x, "worked", x.worked)}</td><td class="nt">${x.note}</td></tr>`).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 9mm; }
    body { font-family: 'Noto Sans CJK JP','Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif; font-size: 11px; color:#111; margin:0; width:190mm; }
    h1 { font-size:18px; margin:0 0 2mm; letter-spacing:.2em; text-align:center; }
    .warn { text-align:center; color:#b3261e; font-size:10px; margin-bottom:3mm; }
    .meta { display:flex; justify-content:space-between; margin-bottom:2mm; font-size:12px; }
    table { border-collapse:collapse; width:100%; }
    th, td { border:1px solid #333; padding:0 3px; height:6.1mm; text-align:center; }
    th { background:#e9e9e9; }
    td.nt { text-align:left; font-size:10px; width:48mm; }
    tr.we td { background:#f0f0f0; } tr.hol td { background:#f7f2e6; }
    td.sat { color:#1a4fb3; } td.sun { color:#b3261e; }
    .blot { display:inline-block; width:15px; height:12px; background:#0b0b0b; border-radius:45% 55% 40% 60%; transform:rotate(-12deg); vertical-align:middle; }
    .sum { margin-top:3mm; display:flex; justify-content:flex-end; gap:8mm; font-size:13px; }
    .sum b { font-size:15px; }
    .sign { margin-top:3mm; font-size:10px; color:#444; }
  </style></head><body>
    <h1>勤 務 表</h1>
    <div class="warn">※ テスト用の架空のデータです（実在の人物・会社ではありません）</div>
    <div class="meta"><span>2026年10月分</span><span>氏名：<b>テスト 太郎</b></span><span>客先：E2Eテスト株式会社</span></div>
    <table><thead><tr><th style="width:8mm">日</th><th style="width:8mm">曜</th><th>開始</th><th>終了</th><th>休憩</th><th>実働</th><th>備考</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="sum"><span>稼働日数 <b>${exp.days.filter((d) => d.truth.kind === "work").length}</b> 日</span><span>合計 <b>${clock(exp.totalWorkedMin)}</b></span></div>
    <div class="sign">確認者：＿＿＿＿＿＿＿＿　　提出日：2026年11月2日</div>
  </body></html>`;
}

export async function main(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const exp = expected();
  fs.writeFileSync(path.join(outDir, "expected.json"), JSON.stringify(exp, null, 2) + "\n");
  const br = await launch();
  const page = await br.newPage({ viewport: { width: 760, height: 1100 }, deviceScaleFactor: 2 });
  await page.setContent(html());
  await page.pdf({ path: path.join(outDir, "sample-2026-10.pdf"), format: "A4", printBackground: true });
  await page.screenshot({ path: path.join(outDir, "sample-2026-10.png"), fullPage: true });
  await page.screenshot({ path: path.join(outDir, "sample-2026-10.jpg"), fullPage: true, type: "jpeg", quality: 90 });
  await br.close();
  return exp;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || path.join(HERE, "../test/fixtures/office-timesheet"));
  main(out).then((e) => console.log(`作成しました：${out}\n  合計 ${clock(e.totalWorkedMin)}（${e.days.filter((d) => d.truth.kind === "work").length}日）／ 読めない・書かれていない所：${e.unreadable.join("・")}`),
    (err) => { console.error(err?.message || err); process.exit(1); });
}
