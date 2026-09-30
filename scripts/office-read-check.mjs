// 勤務表の AI読取を、本物の AI で1回だけ試す（DB にも Storage にも触れない。読むだけ）。
//
// ■ なぜ要るのか
//   Phase 3 のテストは、偽の AI（fake client）で通している。本物のモデルが、実際の勤務表を
//   どこまで読めるか・何秒かかるか（Vercel の実行時間は 60 秒）は、本物で試さないと分からない。
//   本番の DB に触れる前に、1人分の勤務表で確かめる。
//
// ■ 使い方
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/office-read-check.mjs <勤務表.pdf|.jpg|.png> [--month 2026-10]
//                                   [--expect 正解.json] [--json 結果.json]
//
//   ・--expect … 正解（scripts/office-sample-timesheet.mjs が作る expected.json）と突き合わせる。
//                「勤務表に書かれているとおり」（printed）と比べて、一致・読み落とし・誤読・推測を数える。
//                推測（書かれていない・読めない所を AI が埋めた）は 0 でなければならない
//   ・--json   … 読取の結果（画面が使う日別データ・評価・突き合わせ）を JSON で書き出す。保存先は指定した所だけ
//
//   ・対応するのは PDF・JPEG・PNG だけ（外部提出フォームと同じ）。それ以外は、読まずに断る
//   ・モデルは lib/claude.js の MODEL（環境変数 ANTHROPIC_MODEL で変えられる。本番と同じ設定で試すこと）
//   ・--month を省くと、今月。勤務表の年月と違うと「別の月の勤務表」として取り込まない（本番と同じ）
//   ・勤務表には氏名・稼働が載っている。AI（Anthropic）へ送られるので、社内の取り決めに沿った
//     ファイルで試すこと。結果は画面に出すだけで、どこにも保存しない
//
// ■ 何が分かるか
//   ・かかった秒数（60 秒に収まるか）と、使ったトークン数
//   ・日ごとの読取結果と、要確認の印（読めない所は空のまま出る）
//   ・確認にかかりそうな量：入力が必要な日・要確認の日の数、合計時間、勤務表の合計との一致

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readTimesheet, MODEL, READ_TIMEOUT_MS } from "../lib/office-timesheet-ai.js";
import { evaluateSheet } from "../lib/office-timesheet.js";
import { formatClock, formatHours } from "../lib/office-time.js";

const pad = (n) => String(n).padStart(2, "0");

/** 値つきの引数（--name 値）を取り出す。見つからなければ undefined。args は破壊的に縮める */
function takeOpt(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1] ?? "";
  args.splice(i, 2);
  return v;
}

/**
 * AI が返した日別（readTimesheet の days）が、そのまま DB（gw_timesheet_days）に入り、画面が評価できる形か。
 * db/107_office_timesheets.sql の check 制約と同じ範囲を確かめる。違反があれば、その内容を返す
 */
export function dbShapeProblems(days) {
  const bad = [];
  const isInt = (v) => Number.isInteger(v);
  for (const d of days) {
    const at = d.workDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(at))) bad.push(`${at}: 日付の形`);
    if (d.kind !== null && d.kind !== "work" && d.kind !== "off") bad.push(`${at}: kind=${d.kind}`);
    const rng = [["startMin", d.startMin, 0, 1439], ["endMin", d.endMin, 0, 2879], ["breakMin", d.breakMin, 0, 1440], ["sheetWorkedMin", d.sheetWorkedMin, 0, 1440]];
    for (const [n, v, lo, hi] of rng) if (v !== null && !(isInt(v) && v >= lo && v <= hi)) bad.push(`${at}: ${n}=${v}（${lo}〜${hi}の整数のみ）`);
    if (d.confidence !== null && !["high", "mid", "low"].includes(d.confidence)) bad.push(`${at}: confidence=${d.confidence}`);
    if (!Array.isArray(d.flags)) bad.push(`${at}: flags が配列でない`);
  }
  return bad;
}

const FIELDS = [["kind", "区分", (d) => d.kind, (p) => p.kind], ["start", "開始", (d) => d.startMin, (p) => p.start],
  ["end", "終了", (d) => d.endMin, (p) => p.end], ["break", "休憩", (d) => d.breakMin, (p) => p.break], ["worked", "実働", (d) => d.sheetWorkedMin, (p) => p.worked]];

/**
 * AI の読取を、正解（expected.json の printed＝勤務表に書かれているとおり）と比べる。
 *   match   … 同じ
 *   missed  … 書かれているのに、AI が空（読み落とし）
 *   wrong   … 書かれているのと違う値（誤読）
 *   guessed … 書かれていない・読めない所（printed が空）に、AI が値を入れた（推測。0 でなければならない）
 * 「休み」の日の開始・終了などは、どちらも空なら一致。夜間の終了などは endAccept のどちらでも一致
 */
export function compareWithExpected(days, expected) {
  const byDate = new Map(days.map((d) => [d.workDate, d]));
  const tally = { match: 0, missed: 0, wrong: 0, guessed: 0 };
  const items = [];
  const hidden = [];   // 書かれていない・読めない所（勤務表は空白・染みで、本当の値は書いた人だけが知っている）
  for (const e of expected.days) {
    const d = byDate.get(e.date);
    for (const [key, label, pick, want] of FIELDS) {
      const got = d ? pick(d) : null;
      const exp = want(e.printed);
      const truth = want(e.truth || {});
      if ((exp === null || exp === undefined) && truth !== null && truth !== undefined) {
        hidden.push({ date: e.date, field: label, got: got ?? null, kept: got === null || got === undefined });
      }
      let result;
      if (exp === null || exp === undefined) result = got === null || got === undefined ? "match" : "guessed";
      else if (got === null || got === undefined) result = "missed";
      else if (got === exp || (key === "end" && Array.isArray(e.endAccept) && e.endAccept.includes(got))) result = "match";
      else result = "wrong";
      tally[result]++;
      if (result !== "match") items.push({ date: e.date, field: label, expected: exp ?? null, got: got ?? null, result });
    }
  }
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  return { tally, total, items, hidden };
}

/** 突き合わせの結果を、人が読む形にする（分は h:mm） */
function showCompare(cmp, out) {
  const v = (field, x) => (x == null ? "（空）" : field === "区分" ? ({ work: "勤務", off: "休み" }[x] || x) : formatClock(x));
  const { tally, total } = cmp;
  out(`\n■ 正解との突き合わせ（勤務表に書かれているとおり・全${total}項目）`);
  out(`  一致 ${tally.match} ／ 読み落とし ${tally.missed} ／ 誤読 ${tally.wrong} ／ 推測（書かれていない所を埋めた）${tally.guessed}${tally.guessed ? "  ← 0 であるべきです" : ""}`);
  for (const i of cmp.items) out(`  ${{ missed: "読み落とし", wrong: "誤読", guessed: "推測" }[i.result]}  ${i.date.slice(5)} ${i.field}：正解 ${v(i.field, i.expected)} → AI ${v(i.field, i.got)}`);
}

/**
 * 「実 AI 確認」で報告してほしい項目を、そのままの並びで出す。
 * 実行した人が、このブロックだけを知らせれば足りる（キー・個人情報は含まない）
 */
export function checklist({ model, sec, cmp, problems }) {
  const { tally, total, hidden } = cmp;
  const yn = (b) => (b ? "はい" : "いいえ");
  const list = (arr) => arr.map((h) => `${h.date.slice(5)} ${h.field}`).join("・") || "なし";
  const blankBreak = hidden.filter((h) => h.field === "休憩");
  const filled = hidden.filter((h) => !h.kept);
  return [
    "",
    "■ 報告項目（実 AI 確認）",
    `  使用モデル名：${model}`,
    "  読取：成功",
    `  所要秒数：${sec} 秒（Vercel の上限は 60 秒。読取の待ち時間は ${READ_TIMEOUT_MS / 1000} 秒）`,
    `  正しく読めた項目数：${tally.match} ／ 全${total}項目`,
    `  誤読数：${tally.wrong}`,
    `  読み落とし数：${tally.missed}`,
    `  推測して埋めた件数：${tally.guessed}${tally.guessed ? "  ← 1件でもあれば本番投入は止めて修正" : ""}`,
    `  休憩が空欄の日を、空欄のまま扱えたか：${blankBreak.length ? `${yn(blankBreak.every((h) => h.kept))}（${list(blankBreak)}）` : "（この勤務表には該当なし）"}`,
    `  判読不能な箇所を、勝手に補完しなかったか：${hidden.length ? `${yn(!filled.length)}（対象：${list(hidden)}${filled.length ? `／補完された：${list(filled)}` : ""}）` : "（この勤務表には該当なし）"}`,
    `  JSON が画面でそのまま使える形か：${yn(!problems.length)}（DB の範囲内・日別の評価まで計算できた）`,
  ].join("\n");
}

/** 引数と環境から、実行する。out は出力先（テストで差し替える）。終了コードを返す */
export async function main(argv, { env = process.env, out = (s) => console.log(s), client = null, now = () => Date.now() } = {}) {
  const args = argv.slice();
  const monthOpt = takeOpt(args, "--month");
  const expectPath = takeOpt(args, "--expect");
  const jsonPath = takeOpt(args, "--json");
  let month = monthOpt ?? new Date(now() + 9 * 3600000).toISOString().slice(0, 7);
  const file = args[0];

  if (!file) { out("使い方: ANTHROPIC_API_KEY=... node scripts/office-read-check.mjs <勤務表.pdf|.jpg|.png> [--month YYYY-MM] [--expect 正解.json] [--json 結果.json]"); return 2; }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { out(`--month は YYYY-MM で指定してください（いま「${month}」）`); return 2; }
  if (!fs.existsSync(file)) { out(`ファイルが見つかりません：${file}`); return 2; }
  let expected = null;
  if (expectPath !== undefined) {
    try { expected = JSON.parse(fs.readFileSync(expectPath, "utf8")); } catch (e) { out(`--expect のファイルを読めません：${expectPath}（${e.code || e.message}）`); return 2; }
    if (!Array.isArray(expected?.days)) { out(`--expect のファイルの形が違います：${expectPath}（days が必要です）`); return 2; }
  }
  if (!client && !env.ANTHROPIC_API_KEY) { out("ANTHROPIC_API_KEY が設定されていません。本番と同じキーで試してください。"); return 2; }

  const buffer = fs.readFileSync(file);
  out(`ファイル：${path.basename(file)}（${(buffer.length / 1024).toFixed(0)} KB） ／ 対象月：${month} ／ モデル：${MODEL}`);
  out("AI に読み取らせています…（Vercel の実行時間は 60 秒。それを超えるようなら、そのまま知らせてください）");

  const t0 = now();
  const r = await readTimesheet({ buffer, month, client, apiKey: env.ANTHROPIC_API_KEY });
  const sec = ((now() - t0) / 1000).toFixed(1);

  if (!r.ok) {
    out(`\n✘ 読み取れませんでした（${sec}秒）：${r.code}\n  ${r.message}`);
    if (r.detail) out(`  （API の返答：${r.detail}）`);
    if (jsonPath) writeJson(jsonPath, { ok: false, month, model: MODEL, elapsedSec: Number(sec), code: r.code, message: r.message }, out);
    return 1;
  }

  out(`\n✔ 読み取りました（${sec}秒 ／ 上限 ${READ_TIMEOUT_MS / 1000}秒）。入力 ${r.usage?.inputTokens ?? "?"} トークン・出力 ${r.usage?.outputTokens ?? "?"} トークン`);
  out(`  勤務表の氏名：${r.sheet.employeeName ?? "（読み取れず）"} ／ 勤務表の合計：${r.sheet.totalWorkedMin != null ? `${formatClock(r.sheet.totalWorkedMin)}（${formatHours(r.sheet.totalWorkedMin)}h）` : "（書かれていない）"} ／ 休憩の欄：${{ present: "あり", absent: "なし", unclear: "不明" }[r.sheet.breakColumn]}`);
  for (const w of r.warnings) out(`  注意：${w.text}`);

  const days = r.days.map((d) => ({
    workDate: d.workDate, kind: d.kind, startMin: d.startMin, endMin: d.endMin, breakMin: d.breakMin,
    sheetWorkedMin: d.sheetWorkedMin, note: d.note, source: "ai", confidence: d.confidence, aiFlags: d.flags, edited: false, reviewedAt: null,
  }));
  const ev = evaluateSheet(days, { month, sheetTotalMin: r.sheet.totalWorkedMin });

  out("\n日付   区分  開始   終了   休憩   実働   AI   要確認の理由");
  for (const d of ev.days) {
    const flags = d.flags.map((f) => `${f.blocking ? "【要入力】" : ""}${f.text}`).join(" ／ ");
    const mark = d.blocking ? "✘" : d.needsReview ? "△" : " ";
    out(`${mark} ${d.workDate.slice(5)}  ${(d.kind === "work" ? "勤務" : d.kind === "off" ? "休み" : "未確認").padEnd(3)}  ${formatClock(d.startMin).padEnd(5) || "  -  "}  ${formatClock(d.endMin).padEnd(5) || "  -  "}  ${brk(d.breakMin).padEnd(5)}  ${(d.worked != null ? formatClock(d.worked) : "-").padEnd(5)}  ${(d.confidence || "-").padEnd(4)} ${flags}`);
  }
  const s = ev.summary;
  out(`\n合計 ${formatHours(s.totalMinutes)}h（稼働 ${s.workDays}日）`);
  out(`人が見る量：入力が必要な日 ${s.unresolvedCount}日 ／ 要確認の日 ${s.reviewCount}日 ／ 問題のない日 ${ev.days.length - ev.days.filter((d) => d.blocking || d.needsReview).length}日（全${ev.days.length}日）`);
  out(`勤務表の合計との照合：${{ match: "一致", mismatch: `差あり（計算−表 ${formatClock(Math.abs(s.totalCheck.diffMinutes || 0))}）`, incomplete: "入力が必要な日があるので、まだ照合できない", none: "合計の記載なし" }[s.totalCheck.status]}`);

  // 画面（確認画面）が使える形か：DB の範囲に収まり、評価（実働・要確認の印）が計算できたか
  const problems = dbShapeProblems(r.days);
  out(`画面での利用：${problems.length ? `✘ DB に入らない値があります（${problems.length}件）\n  ${problems.join("\n  ")}` : "✔ 日別データはそのまま DB に入る形です（範囲内・評価も計算できました）"}`);

  let cmp = null;
  if (expected) {
    cmp = compareWithExpected(r.days, expected);
    showCompare(cmp, out);
    out(checklist({ model: r.model, sec, cmp, problems }));
  }
  if (jsonPath) {
    writeJson(jsonPath, {
      ok: true, month, model: r.model, elapsedSec: Number(sec), usage: r.usage, sheet: r.sheet, warnings: r.warnings,
      days: r.days, evaluation: { summary: ev.summary, days: ev.days.map((d) => ({ workDate: d.workDate, worked: d.worked, blocking: d.blocking, needsReview: d.needsReview, flags: d.flags })) },
      dbShapeProblems: problems, comparison: cmp,
    }, out);
  }
  out("\n※ 読めない所は空のまま出ています（推測で埋めない）。実際の勤務表と見比べて、誤読・見落としがどれだけあるかを確かめてください。");
  return problems.length || (cmp && cmp.tally.guessed > 0) ? 1 : 0;
}

// 結果を、指定された1か所にだけ書く（データベースにも保管庫にも書かない）
function writeJson(file, obj, out) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  out(`結果の JSON を書き出しました：${file}`);
}
const brk = (m) => (m == null ? "" : `${Math.floor(m / 60)}:${pad(m % 60)}`);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e?.message || e); process.exit(1); });
}
