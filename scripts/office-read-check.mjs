// 勤務表の AI読取を、本物の AI で1回だけ試す（DB にも Storage にも触れない。読むだけ）。
//
// ■ なぜ要るのか
//   Phase 3 のテストは、偽の AI（fake client）で通している。本物のモデルが、実際の勤務表を
//   どこまで読めるか・何秒かかるか（Vercel の実行時間は 60 秒）は、本物で試さないと分からない。
//   本番の DB に触れる前に、1人分の勤務表で確かめる。
//
// ■ 使い方
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/office-read-check.mjs <勤務表.pdf|.jpg|.png> [--month 2026-10]
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

/** 引数と環境から、実行する。out は出力先（テストで差し替える）。終了コードを返す */
export async function main(argv, { env = process.env, out = (s) => console.log(s), client = null, now = () => Date.now() } = {}) {
  const args = argv.slice();
  const mi = args.indexOf("--month");
  let month = new Date(now() + 9 * 3600000).toISOString().slice(0, 7);
  if (mi >= 0) { month = args[mi + 1] || ""; args.splice(mi, 2); }
  const file = args[0];

  if (!file) { out("使い方: ANTHROPIC_API_KEY=... node scripts/office-read-check.mjs <勤務表.pdf|.jpg|.png> [--month YYYY-MM]"); return 2; }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { out(`--month は YYYY-MM で指定してください（いま「${month}」）`); return 2; }
  if (!fs.existsSync(file)) { out(`ファイルが見つかりません：${file}`); return 2; }
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
  out("\n※ 読めない所は空のまま出ています（推測で埋めない）。実際の勤務表と見比べて、誤読・見落としがどれだけあるかを確かめてください。");
  return 0;
}
const brk = (m) => (m == null ? "" : `${Math.floor(m / 60)}:${pad(m % 60)}`);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e?.message || e); process.exit(1); });
}
